/* ============================================================
   api.js — the "backend", running in the browser
   Mirrors the Apps Script modules (Auth, Tickets, Approvals,
   Reassign, Admin) but reads/writes localStorage via Store.
   The UI only ever calls API.call(name, token, payload).
   ============================================================ */
(function (global) {
  'use strict';

  var Store = global.Store;
  var U = Store.U;

  function cfg(k, fb) { return Store.cfg(k, fb); }
  function cfgNum(k, fb) { var n = Number(Store.cfg(k, fb)); return isNaN(n) ? Number(fb) : n; }
  function normEmail(e) { return U.normEmail(e); }

  var PRIORITIES = ['Low', 'Medium', 'High'];
  var STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED'];
  var ROLES = { USER: 'USER', CBA: 'CBA', ANALYST: 'ANALYST', ADMIN: 'ADMIN' };
  var ADMIN_CLUSTER_ID = 'CL-ADMIN';
  var ADMIN_CLUSTER_NAME = 'Admin';

  function fail(msg) { var e = new Error(msg); e._api = true; throw e; }

  /* ----------------------------- mail ------------------------------ */
  var Mail = {
    send: function (to, subject, body) {
      Store.insert('mails', { MailID: U.uid('M'), To: normEmail(to), Subject: subject, Body: body, SentAt: U.now() });
      return true;
    }
  };

  /* ----------------------------- SLA ------------------------------- */
  function slaDue(priority, from) {
    var base = from ? new Date(from) : new Date();
    var hrs = priority === 'High' ? cfgNum('SLA_HIGH_HRS', 24)
      : priority === 'Low' ? cfgNum('SLA_LOW_HRS', 168) : cfgNum('SLA_MED_HRS', 72);
    return new Date(base.getTime() + hrs * 3600000).toISOString();
  }

  /* ============================== Auth ============================= */
  var Auth = {
    signup: function (p) {
      var email = normEmail(p.email);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('A valid email address is required.');
      var domain = String(cfg('ALLOWED_DOMAIN', '') || '').toLowerCase();
      if (domain && email.split('@')[1] !== domain) fail('Please sign up with your @' + domain + ' email address.');
      if (Store.findOne('users', function (u) { return normEmail(u.Email) === email; })) fail('An account with this email already exists. Please log in.');
      if (!p.name || !String(p.name).trim()) fail('Full name is required.');
      if (!/^[6-9]\d{9}$/.test(String(p.phone || '').trim())) fail('Enter a valid 10-digit mobile number.');
      if (!p.department || !String(p.department).trim()) fail('Department is required.');

      var clusterId = String(p.clusterId || '').trim();
      var cluster = clusterId ? Store.findOne('clusters', function (c) { return String(c.ClusterID) === clusterId; }) : null;
      if (clusterId && !cluster) fail('Please choose a valid cluster.');

      var user = Store.insert('users', {
        UserID: Store.nextId('U-', 'users', 'UserID'),
        Name: String(p.name).trim(), Email: email, Phone: String(p.phone).trim(),
        Department: String(p.department).trim(),
        DefaultPriority: PRIORITIES.indexOf(p.defaultPriority) >= 0 ? p.defaultPriority : 'Medium',
        Role: ROLES.USER, ClusterID: cluster ? String(cluster.ClusterID) : '',
        ReportsTo: '', Status: 'ACTIVE', CreatedAt: U.now(), LastLoginAt: ''
      });
      Auth.logActivity(user, 'SIGNUP', email);
      Mail.send(email, 'Welcome to ' + cfg('APP_NAME', 'PW Ticket Portal'),
        'Hi ' + user.Name + ', your account is ready. You can now raise requests to the Analytics team.');
      return { registered: true, email: email };
    },

    requestOtp: function (p) {
      var email = normEmail(p.email);
      if (!email) fail('Please enter your email.');
      var user = Store.findOne('users', function (u) { return normEmail(u.Email) === email; });
      if (!user || String(user.Status).toUpperCase() !== 'ACTIVE') {
        return { email: email, sent: true, message: 'If this email is registered, we sent an OTP.' };
      }
      var otp = U.randomOtp();
      Store.remove('otp', function (r) { return normEmail(r.Email) === email; });
      Store.insert('otp', {
        Email: email, OtpHash: otp, ExpiresAt: U.addMinutes(U.now(), cfgNum('OTP_EXPIRY_MIN', 10)),
        Attempts: 0, CreatedAt: U.now()
      });
      Mail.send(email, cfg('APP_NAME', 'PW Ticket Portal') + ' - Login OTP',
        'Your login code is ' + otp + '. It expires in ' + cfg('OTP_EXPIRY_MIN', 10) + ' minutes.');
      // demo only: return the OTP so the UI can show it (no real email is sent)
      return { email: email, sent: true, demoOtp: otp };
    },

    verifyOtp: function (p) {
      var email = normEmail(p.email);
      var code = String(p.code || '').trim();
      if (!code) fail('Please enter the OTP.');
      var rec = Store.findOne('otp', function (r) { return normEmail(r.Email) === email; });
      if (!rec) fail('No OTP was requested for this email.');
      if (U.toMs(rec.ExpiresAt) < Date.now()) {
        Store.remove('otp', function (r) { return normEmail(r.Email) === email; });
        fail('OTP expired. Please request a new one.');
      }
      var tries = Number(rec.Attempts || 0);
      if (tries >= cfgNum('OTP_MAX_ATTEMPTS', 5)) {
        Store.remove('otp', function (r) { return normEmail(r.Email) === email; });
        fail('Too many incorrect attempts. Please request a new OTP.');
      }
      if (String(rec.OtpHash) !== code) {
        Store.update('otp', rec, { Attempts: tries + 1 });
        fail('Incorrect OTP. Attempts left: ' + (cfgNum('OTP_MAX_ATTEMPTS', 5) - tries - 1));
      }
      Store.remove('otp', function (r) { return normEmail(r.Email) === email; });
      var user = Store.findOne('users', function (u) { return normEmail(u.Email) === email; });
      if (!user || String(user.Status).toUpperCase() !== 'ACTIVE') fail('Account is not available.');
      Store.update('users', user, { LastLoginAt: U.now() });
      var token = Auth.createSession(user);
      Auth.logActivity(user, 'LOGIN', email);
      return { token: token, user: Auth.publicUser(user) };
    },

    createSession: function (user) {
      var token = U.randomToken();
      Store.insert('sessions', {
        Token: token, Email: normEmail(user.Email), Role: String(user.Role || '').toUpperCase(),
        CreatedAt: U.now(), ExpiresAt: U.addHours(U.now(), cfgNum('SESSION_HOURS', 24)), LastSeenAt: U.now()
      });
      return token;
    },

    requireSession: function (token) {
      if (!token) fail('SESSION_EXPIRED');
      var rec = Store.findOne('sessions', function (s) { return s.Token === token; });
      if (!rec) fail('SESSION_EXPIRED');
      if (U.toMs(rec.ExpiresAt) < Date.now()) {
        Store.remove('sessions', function (s) { return s.Token === token; });
        fail('SESSION_EXPIRED');
      }
      var user = Store.findOne('users', function (u) { return normEmail(u.Email) === normEmail(rec.Email); });
      if (!user) fail('SESSION_EXPIRED');
      if (String(user.Status).toUpperCase() !== 'ACTIVE') fail('Your account is inactive. Contact the admin.');
      Store.update('sessions', rec, { LastSeenAt: U.now() });
      user.Role = String(user.Role || '').toUpperCase();
      return user;
    },

    logout: function (token) { Store.remove('sessions', function (s) { return s.Token === token; }); return { loggedOut: true }; },
    killSessions: function (email) { return Store.remove('sessions', function (s) { return normEmail(s.Email) === normEmail(email); }); },

    publicUser: function (u) {
      return {
        userId: u.UserID, name: u.Name || '', email: normEmail(u.Email), phone: u.Phone || '',
        department: u.Department || '', role: String(u.Role || 'USER').toUpperCase(),
        clusterId: u.ClusterID || '', defaultPriority: u.DefaultPriority || 'Medium', reportsTo: u.ReportsTo || ''
      };
    },
    me: function (user) { return Auth.publicUser(user); },

    logActivity: function (user, event, meta) {
      if (!user) return;
      Store.insert('activity', {
        Timestamp: U.now(), Email: normEmail(user.Email),
        Role: String(user.Role || '').toUpperCase(), Event: event, Meta: meta || ''
      });
    }
  };

  /* ============================= Tickets =========================== */
  var Tickets = {
    canSee: function (user, t) {
      switch (String(user.Role).toUpperCase()) {
        case 'ADMIN': return true;
        case 'CBA': return String(t.ClusterID) === String(user.ClusterID);
        case 'ANALYST': return normEmail(t.AnalystEmail) === normEmail(user.Email);
        case 'USER': return normEmail(t.RaisedByEmail) === normEmail(user.Email);
        default: return false;
      }
    },
    log: function (ticketId, user, action, oldValue, newValue, note) {
      Store.insert('logs', {
        LogID: U.uid('L'), TicketID: ticketId, Action: action, ByEmail: normEmail(user.Email),
        ByRole: String(user.Role || '').toUpperCase(), OldValue: oldValue == null ? '' : String(oldValue),
        NewValue: newValue == null ? '' : String(newValue), Note: note || '', Timestamp: U.now()
      });
    },
    publicTicket: function (t) {
      var dueMs = U.toMs(t.DueAt);
      var status = String(t.Status || '').toUpperCase();
      var slaState = (status === 'CLOSED' || status === 'RESOLVED') ? 'MET'
        : (!dueMs ? '-' : (Date.now() > dueMs ? 'BREACHED' : (dueMs - Date.now() < 4 * 3600000 ? 'DUE_SOON' : 'ON_TRACK')));
      return {
        ticketId: t.TicketID, title: t.Title, description: t.Description, category: t.Category || 'Other',
        priority: t.Priority || 'Medium', status: status, raisedByEmail: normEmail(t.RaisedByEmail),
        raisedByName: t.RaisedByName || '', raisedByPhone: t.RaisedByPhone || '', department: t.Department || '',
        clusterId: t.ClusterID || '', cbaEmail: normEmail(t.CBA_Email), analystEmail: normEmail(t.AnalystEmail),
        approvalRequired: String(t.ApprovalRequired).toUpperCase() === 'TRUE',
        approvalStatus: t.ApprovalStatus || 'NONE', approvedBy: normEmail(t.ApprovedBy),
        dueAt: t.DueAt || '', createdAt: t.CreatedAt || '', updatedAt: t.UpdatedAt || '',
        resolvedAt: t.ResolvedAt || '', closedAt: t.ClosedAt || '', rating: t.Rating || '',
        feedback: t.Feedback || '', slaState: slaState
      };
    },

    create: function (user, p) {
      if (!p.title || !String(p.title).trim()) fail('Title is required.');
      if (!p.description || !String(p.description).trim()) fail('Description is required.');
      var priority = PRIORITIES.indexOf(p.priority) >= 0 ? p.priority
        : (PRIORITIES.indexOf(user.DefaultPriority) >= 0 ? user.DefaultPriority : 'Medium');
      var title = String(p.title).trim();
      if (!p.force) {
        var dup = Store.findOne('tickets', function (t) {
          return normEmail(t.RaisedByEmail) === normEmail(user.Email) &&
            String(t.Title).trim().toLowerCase() === title.toLowerCase() &&
            String(t.Status).toUpperCase() !== 'CLOSED';
        });
        if (dup) return { duplicate: true, existingTicketId: dup.TicketID, message: 'You already have an open ticket with this title (' + dup.TicketID + ').' };
      }
      var cluster = Store.findOne('clusters', function (c) { return String(c.ClusterID) === String(user.ClusterID); });
      var cbaEmail = cluster ? normEmail(cluster.CBA_Email) : '';
      var ticket = Store.insert('tickets', {
        TicketID: Store.nextId('TKT-' + new Date().getFullYear() + '-', 'tickets', 'TicketID'),
        Title: title, Description: String(p.description).trim(), Category: String(p.category || 'Other').trim(),
        Priority: priority, Status: 'NEW', RaisedByEmail: normEmail(user.Email), RaisedByName: user.Name,
        RaisedByPhone: user.Phone || '', Department: String(p.department || user.Department || '').trim(),
        ClusterID: user.ClusterID || '', CBA_Email: cbaEmail, AnalystEmail: '',
        ApprovalRequired: 'FALSE', ApprovalStatus: 'NONE', ApprovedBy: '', AttachmentLinks: '',
        DueAt: slaDue(priority), CreatedAt: U.now(), UpdatedAt: U.now(),
        ResolvedAt: '', ClosedAt: '', Rating: '', Feedback: ''
      });
      Tickets.log(ticket.TicketID, user, 'CREATED', '', priority, 'Ticket raised');
      Auth.logActivity(user, 'TICKET_CREATE', ticket.TicketID);
      if (p.assignTo) {
        var assignee = Tickets.resolveAssignee_(user, ticket, p.assignTo);
        Store.update('tickets', ticket, { AnalystEmail: normEmail(assignee.Email), Status: 'ASSIGNED', UpdatedAt: U.now() });
        Tickets.log(ticket.TicketID, user, 'ASSIGNED', '', normEmail(assignee.Email), 'Assigned on create');
        Auth.logActivity(user, 'ASSIGN', ticket.TicketID + ' -> ' + assignee.Email);
      }
      if (cbaEmail && cbaEmail !== normEmail(user.Email)) Mail.send(cbaEmail, '[New Ticket] ' + ticket.TicketID + ' - ' + ticket.Title,
        user.Name + ' raised "' + ticket.Title + '" (' + priority + '). Please triage.');
      Mail.send(user.Email, '[Received] ' + ticket.TicketID + ' - ' + ticket.Title,
        'We received your request. Due by ' + U.fmtDate(ticket.DueAt) + '.');
      if (ticket.AnalystEmail && normEmail(ticket.AnalystEmail) !== normEmail(user.Email)) {
        Mail.send(ticket.AnalystEmail, '[Assigned] ' + ticket.TicketID + ' - ' + ticket.Title, user.Name + ' assigned this ticket to you.');
      }
      return Tickets.publicTicket(ticket);
    },

    list: function (user, f) {
      f = f || {};
      var rows = Store.all('tickets').filter(function (t) { return Tickets.canSee(user, t); });
      if (f.status) rows = rows.filter(function (t) { return String(t.Status) === f.status; });
      if (f.priority) rows = rows.filter(function (t) { return String(t.Priority) === f.priority; });
      if (f.clusterId && user.Role === 'ADMIN') rows = rows.filter(function (t) { return String(t.ClusterID) === String(f.clusterId); });
      if (f.analyst) rows = rows.filter(function (t) { return normEmail(t.AnalystEmail) === normEmail(f.analyst); });
      if (f.q) {
        var q = String(f.q).toLowerCase();
        rows = rows.filter(function (t) {
          return (t.TicketID + ' ' + t.Title + ' ' + t.Description + ' ' + t.RaisedByName + ' ' + t.Department).toLowerCase().indexOf(q) >= 0;
        });
      }
      rows.sort(function (a, b) { return U.toMs(b.UpdatedAt || b.CreatedAt) - U.toMs(a.UpdatedAt || a.CreatedAt); });
      var total = rows.length;
      var page = Math.max(1, Number(f.page) || 1);
      var pageSize = Math.max(1, Number(f.pageSize) || 20);
      var start = (page - 1) * pageSize;
      return { rows: rows.slice(start, start + pageSize).map(Tickets.publicTicket), total: total, page: page, pageSize: pageSize };
    },

    get: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (!Tickets.canSee(user, t)) fail('You do not have access to this ticket.');
      var logs = Store.find('logs', function (l) { return String(l.TicketID) === String(p.ticketId); })
        .sort(function (a, b) { return U.toMs(a.Timestamp) - U.toMs(b.Timestamp); })
        .map(function (l) { return { action: l.Action, byEmail: normEmail(l.ByEmail), byRole: l.ByRole, oldValue: l.OldValue, newValue: l.NewValue, note: l.Note, at: l.Timestamp }; });
      var comments = Store.find('comments', function (c) { return String(c.TicketID) === String(p.ticketId); })
        .sort(function (a, b) { return U.toMs(a.Timestamp) - U.toMs(b.Timestamp); })
        .map(function (c) { return { commentId: c.CommentID, byEmail: normEmail(c.ByEmail), byName: c.ByName, text: c.Text, at: c.Timestamp }; });
      var approvals = Store.find('approvals', function (a) { return String(a.TicketID) === String(p.ticketId); })
        .map(function (a) { return { approvalId: a.ApprovalID, approverEmail: normEmail(a.ApproverEmail), requestedBy: normEmail(a.RequestedByEmail), note: a.RequestNote, status: a.Status, decisionNote: a.DecisionNote, requestedAt: a.RequestedAt, expiresAt: a.ExpiresAt, decidedAt: a.DecidedAt }; });
      var reassigns = Store.find('reassign', function (r) { return String(r.TicketID) === String(p.ticketId); })
        .map(function (r) { return { reqId: r.ReqID, fromAnalyst: normEmail(r.FromAnalyst), toAnalyst: normEmail(r.ToAnalyst), reason: r.Reason, status: r.Status, decisionNote: r.DecisionNote, requestedAt: r.RequestedAt, decidedAt: r.DecidedAt }; });
      return Object.assign(Tickets.publicTicket(t), { logs: logs, comments: comments, approvals: approvals, reassignRequests: reassigns });
    },

    resolveAssignee_: function (user, t, email) {
      var target = Store.findOne('users', function (u) { return normEmail(u.Email) === normEmail(email); });
      if (!target) fail('Selected user not found.');
      if (String(target.Status).toUpperCase() !== 'ACTIVE') fail('That user is inactive.');
      var role = String(target.Role).toUpperCase();
      var actorRole = String(user.Role).toUpperCase();
      var isSelf = normEmail(target.Email) === normEmail(user.Email);
      var sameCluster = String(target.ClusterID) === String(t.ClusterID);
      // An admin can hand a ticket to any active worker, in any cluster.
      if (actorRole === 'ADMIN' && (role === 'CBA' || role === 'ANALYST')) return target;
      if (role === 'ANALYST') {
        if (!sameCluster) fail('That analyst is not in this ticket\'s cluster.');
        return target;
      }
      if (role === 'CBA' && isSelf && sameCluster) return target;
      fail('Assign to an Associate Analyst in this cluster, or take it yourself.');
    },

    assign: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (!Tickets.canSee(user, t)) fail('This ticket is outside your cluster.');
      var st = String(t.Status).toUpperCase();
      if (['CLOSED', 'RESOLVED'].indexOf(st) >= 0) fail('Cannot assign a ' + st + ' ticket.');
      var assignee = Tickets.resolveAssignee_(user, t, p.analystEmail);
      var old = t.AnalystEmail || '';
      Store.update('tickets', t, { AnalystEmail: normEmail(assignee.Email), Status: 'ASSIGNED', UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'ASSIGNED', old, normEmail(assignee.Email), p.note || '');
      Auth.logActivity(user, 'ASSIGN', t.TicketID + ' -> ' + assignee.Email);
      if (normEmail(assignee.Email) !== normEmail(user.Email)) {
        Mail.send(assignee.Email, '[Assigned] ' + t.TicketID + ' - ' + t.Title, user.Name + ' assigned this ticket to you.');
      }
      if (normEmail(t.RaisedByEmail) !== normEmail(assignee.Email)) {
        Mail.send(t.RaisedByEmail, 'Update on ' + t.TicketID, 'Your ticket is now with ' + assignee.Email + '.');
      }
      return Tickets.publicTicket(t);
    },

    myAnalysts: function (user) {
      var role = String(user.Role).toUpperCase();
      var clusters = {};
      Store.all('clusters').forEach(function (c) { clusters[String(c.ClusterID)] = c.ClusterName; });
      var list = Store.all('users').filter(function (u) {
        if (String(u.Status).toUpperCase() !== 'ACTIVE') return false;
        var r = String(u.Role).toUpperCase();
        if (role === 'ADMIN') return r === 'ANALYST' || r === 'CBA';
        if (r !== 'ANALYST') return false;
        return String(u.ClusterID) === String(user.ClusterID);
      }).map(function (u) {
        return {
          email: normEmail(u.Email), name: u.Name, role: String(u.Role).toUpperCase(),
          clusterId: u.ClusterID || '', clusterName: clusters[String(u.ClusterID)] || u.ClusterID || ''
        };
      });
      if (role === 'CBA') {
        list.unshift({
          email: normEmail(user.Email), name: user.Name + ' (me)', role: 'CBA',
          clusterId: user.ClusterID || '',
          clusterName: clusters[String(user.ClusterID)] || user.ClusterID || '', self: true
        });
      }
      return list;
    },

    updateStatus: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (!Tickets.canSee(user, t)) fail('Access denied.');
      var to = String(p.status || '').toUpperCase();
      var from = String(t.Status || '').toUpperCase();
      if (STATUSES.indexOf(to) === -1) fail('Invalid status.');
      var role = String(user.Role).toUpperCase();
      if (role === 'ANALYST' && normEmail(t.AnalystEmail) !== normEmail(user.Email)) fail('This ticket is not assigned to you.');
      if (role === 'ANALYST' || role === 'CBA') {
        var allowed = { ASSIGNED: ['IN_PROGRESS'], IN_PROGRESS: ['ON_HOLD', 'RESOLVED'], ON_HOLD: ['IN_PROGRESS'], PENDING_APPROVAL: ['IN_PROGRESS'], REOPENED: ['IN_PROGRESS', 'ASSIGNED'], NEW: ['IN_PROGRESS'] };
        if ((allowed[from] || []).indexOf(to) === -1) fail('Cannot move from ' + from + ' to ' + to + '.');
      }
      var patch = { Status: to, UpdatedAt: U.now() };
      if (to === 'RESOLVED') patch.ResolvedAt = U.now();
      Store.update('tickets', t, patch);
      Tickets.log(t.TicketID, user, 'STATUS_CHANGED', from, to, p.note || '');
      Auth.logActivity(user, 'TICKET_UPDATE', t.TicketID + ' -> ' + to);
      return Tickets.publicTicket(t);
    },

    close: function (user, p) {
      var t = Tickets.mustOwn(user, p.ticketId);
      if (String(t.Status).toUpperCase() !== 'RESOLVED') fail('Only a resolved ticket can be closed.');
      Store.update('tickets', t, { Status: 'CLOSED', ClosedAt: U.now(), UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'CLOSED', 'RESOLVED', 'CLOSED', p.note || '');
      return Tickets.publicTicket(t);
    },

    reopen: function (user, p) {
      var t = Tickets.mustOwn(user, p.ticketId);
      var st = String(t.Status).toUpperCase();
      if (['RESOLVED', 'CLOSED'].indexOf(st) === -1) fail('Only resolved/closed tickets can be reopened.');
      if (!p.reason || !String(p.reason).trim()) fail('Please give a reason for reopening.');
      Store.update('tickets', t, { Status: 'REOPENED', ClosedAt: '', ResolvedAt: '', UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'REOPENED', st, 'REOPENED', String(p.reason).trim());
      return Tickets.publicTicket(t);
    },

    rate: function (user, p) {
      var t = Tickets.mustOwn(user, p.ticketId);
      if (String(t.Status).toUpperCase() !== 'CLOSED') fail('You can rate only closed tickets.');
      if (t.Rating !== '' && t.Rating != null) fail('This ticket is already rated.');
      var rating = Number(p.rating);
      if (!(rating >= 1 && rating <= 5)) fail('Rating must be between 1 and 5.');
      Store.update('tickets', t, { Rating: rating, Feedback: String(p.feedback || '').trim() });
      Tickets.log(t.TicketID, user, 'RATED', '', String(rating), String(p.feedback || '').trim());
      return { rating: rating };
    },

    mustOwn: function (user, ticketId) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(ticketId); });
      if (!t) fail('Ticket not found.');
      var role = String(user.Role).toUpperCase();
      var owner = normEmail(t.RaisedByEmail) === normEmail(user.Email);
      if (role !== 'ADMIN' && !owner) fail('Only the requester can do this.');
      return t;
    },

    addComment: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (!Tickets.canSee(user, t)) fail('Access denied.');
      if (!p.text || !String(p.text).trim()) fail('Comment cannot be empty.');
      Store.insert('comments', { CommentID: U.uid('C'), TicketID: t.TicketID, ByEmail: normEmail(user.Email), ByName: user.Name, Text: String(p.text).trim(), Timestamp: U.now() });
      Store.update('tickets', t, { UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'COMMENT', '', '', String(p.text).trim().slice(0, 120));
      Auth.logActivity(user, 'COMMENT', t.TicketID);
      return { commentId: 'ok' };
    },

    dashboard: function (user) {
      var role = String(user.Role).toUpperCase();
      var tickets = Store.all('tickets').filter(function (t) { return Tickets.canSee(user, t); });
      var byStatus = {}, byPriority = {}, open = 0, closed = 0, unassigned = 0, mine = 0, overdue = 0;
      var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'ON_HOLD', 'RESOLVED', 'REOPENED'];
      tickets.forEach(function (t) {
        var st = String(t.Status).toUpperCase();
        byStatus[st] = (byStatus[st] || 0) + 1;
        byPriority[t.Priority] = (byPriority[t.Priority] || 0) + 1;
        if (openStates.indexOf(st) >= 0) open++; else if (st === 'CLOSED') closed++;
        if (!t.AnalystEmail) unassigned++;
        if (normEmail(t.AnalystEmail) === normEmail(user.Email)) mine++;
        if (U.toMs(t.DueAt) && Date.now() > U.toMs(t.DueAt) && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
      });
      var recent = tickets.slice().sort(function (a, b) { return U.toMs(b.CreatedAt) - U.toMs(a.CreatedAt); })
        .slice(0, 5).map(Tickets.publicTicket);
      var out = { total: tickets.length, open: open, closed: closed, unassigned: unassigned, assignedToMe: mine, overdue: overdue, byStatus: byStatus, byPriority: byPriority, recent: recent, role: role, clusterId: user.ClusterID || '' };
      if (role === 'CBA' || role === 'ADMIN') {
        out.pendingReassignments = Store.find('reassign', function (r) {
          if (String(r.Status).toUpperCase() !== 'PENDING') return false;
          if (role === 'ADMIN') return true;
          return normEmail(r.CBA_Email) === normEmail(user.Email);
        }).length;
        out.pendingApprovals = tickets.filter(function (t) { return String(t.ApprovalStatus).toUpperCase() === 'PENDING'; }).length;
      }
      return out;
    }
  };

  /* ============================ Approvals ========================== */
  var Approvals = {
    request: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (!Tickets.canSee(user, t)) fail('Access denied.');
      var approver = normEmail(p.approverEmail);
      if (!approver || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(approver)) fail('A valid approver email is required.');
      var token = U.randomToken();
      var approvalId = 'APR-' + U.uid('').slice(0, 10).toUpperCase();
      Store.insert('approvals', {
        ApprovalID: approvalId, TicketID: t.TicketID, RequestedByEmail: normEmail(user.Email),
        ApproverEmail: approver, Token: token, Status: 'PENDING', RequestNote: String(p.note || '').trim(),
        DecisionNote: '', RequestedAt: U.now(), ExpiresAt: U.addHours(U.now(), cfgNum('APPROVAL_EXPIRY_HRS', 72)), DecidedAt: ''
      });
      Store.update('tickets', t, { ApprovalRequired: 'TRUE', ApprovalStatus: 'PENDING', Status: 'PENDING_APPROVAL', UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'APPROVAL_REQUESTED', '', approver, p.note || '');
      Auth.logActivity(user, 'APPROVAL_SENT', t.TicketID + ' -> ' + approver);
      Mail.send(approver, '[Approval Needed] ' + t.TicketID + ': ' + t.Title,
        'Please review and approve/reject this request from ' + user.Name + '. (Demo link: #approve/' + approvalId + '/' + token + ')');
      return { approvalId: approvalId, approverEmail: approver, demoToken: token, expiresAt: '' };
    },
    getInfo: function (token, approvalId) {
      var a = Approvals.lookup_(token, approvalId);
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(a.TicketID); }) || {};
      var expired = U.toMs(a.ExpiresAt) < Date.now() && String(a.Status).toUpperCase() === 'PENDING';
      return {
        approvalId: a.ApprovalID, status: expired ? 'EXPIRED' : String(a.Status).toUpperCase(),
        canDecide: String(a.Status).toUpperCase() === 'PENDING' && !expired,
        approverEmail: normEmail(a.ApproverEmail), requestedBy: normEmail(a.RequestedByEmail),
        note: a.RequestNote, decisionNote: a.DecisionNote || '', requestedAt: a.RequestedAt,
        decidedAt: a.DecidedAt || '',
        ticket: { ticketId: t.TicketID, title: t.Title, description: t.Description, priority: t.Priority, category: t.Category, department: t.Department, raisedByName: t.RaisedByName, raisedByEmail: normEmail(t.RaisedByEmail), raisedByPhone: t.RaisedByPhone }
      };
    },
    decide: function (token, approvalId, decision, note) {
      decision = String(decision || '').toUpperCase();
      if (decision !== 'APPROVED' && decision !== 'REJECTED') fail('Invalid decision.');
      var a = Approvals.lookup_(token, approvalId);
      if (String(a.Status).toUpperCase() !== 'PENDING') fail('This request has already been ' + String(a.Status).toLowerCase() + '.');
      if (U.toMs(a.ExpiresAt) < Date.now()) fail('This approval link has expired.');
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(a.TicketID); });
      if (!t) fail('Ticket not found.');
      Store.update('approvals', a, { Status: decision, DecisionNote: String(note || '').trim(), DecidedAt: U.now() });
      Store.update('tickets', t, { ApprovalStatus: decision, ApprovedBy: normEmail(a.ApproverEmail), Status: decision === 'APPROVED' ? 'IN_PROGRESS' : 'ON_HOLD', UpdatedAt: U.now() });
      var actor = { Email: a.ApproverEmail, Name: a.ApproverEmail, Role: 'APPROVER' };
      Tickets.log(a.TicketID, actor, 'APPROVAL_' + decision, '', decision, String(note || '').trim());
      Auth.logActivity(actor, 'APPROVAL_' + decision, a.TicketID);
      return { status: decision };
    },
    lookup_: function (token, approvalId) {
      if (!token || !approvalId) fail('Missing approval link details.');
      var a = Store.findOne('approvals', function (x) { return String(x.ApprovalID) === String(approvalId) && String(x.Token) === String(token); });
      if (!a) fail('This approval link is invalid.');
      return a;
    }
  };

  /* ============================ Reassign =========================== */
  var Reassign = {
    request: function (user, p) {
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(p.ticketId); });
      if (!t) fail('Ticket not found.');
      if (normEmail(t.AnalystEmail) !== normEmail(user.Email)) fail('Only the assigned analyst can request a reassignment.');
      if (String(t.Status).toUpperCase() === 'CLOSED') fail('Closed tickets cannot be reassigned.');
      var to = normEmail(p.toAnalystEmail);
      if (!to) fail('Select the analyst to reassign to.');
      if (to === normEmail(user.Email)) fail('You cannot reassign to yourself.');
      var target = Store.findOne('users', function (u) { return normEmail(u.Email) === to; });
      if (!target || String(target.Role).toUpperCase() !== 'ANALYST' || String(target.Status).toUpperCase() !== 'ACTIVE') fail('Target is not an active Associate Analyst.');
      if (String(target.ClusterID) !== String(t.ClusterID)) fail('Target analyst is not in this ticket\'s cluster.');
      if (Store.findOne('reassign', function (r) { return String(r.TicketID) === String(t.TicketID) && String(r.Status).toUpperCase() === 'PENDING'; })) fail('A reassignment request is already pending for this ticket.');
      var req = Store.insert('reassign', {
        ReqID: 'RR-' + U.uid('').slice(0, 10).toUpperCase(), TicketID: t.TicketID,
        FromAnalyst: normEmail(user.Email), ToAnalyst: to, Reason: String(p.reason || '').trim(),
        Status: 'PENDING', CBA_Email: t.CBA_Email || '', DecisionNote: '', RequestedAt: U.now(), DecidedAt: ''
      });
      Store.update('tickets', t, { Status: 'PENDING_APPROVAL', UpdatedAt: U.now() });
      Tickets.log(t.TicketID, user, 'REASSIGN_REQUESTED', normEmail(user.Email), to, req.Reason);
      Auth.logActivity(user, 'REASSIGN_REQUEST', t.TicketID + ' -> ' + to);
      Mail.send(req.CBA_Email || cfg('ADMIN_EMAIL', ''), '[Approval needed] Reassign ' + t.TicketID,
        user.Name + ' wants to hand this ticket to ' + to + '.');
      return { ReqID: req.ReqID, Status: req.Status };
    },
    list: function (user) {
      var role = String(user.Role).toUpperCase();
      var rows = Store.all('reassign');
      if (role === 'CBA') rows = rows.filter(function (r) { return normEmail(r.CBA_Email) === normEmail(user.Email); });
      return rows.slice().sort(function (a, b) { return U.toMs(b.RequestedAt) - U.toMs(a.RequestedAt); })
        .map(function (r) {
          var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(r.TicketID); }) || {};
          return { reqId: r.ReqID, ticketId: r.TicketID, ticketTitle: t.Title || '', fromAnalyst: normEmail(r.FromAnalyst), toAnalyst: normEmail(r.ToAnalyst), reason: r.Reason, status: String(r.Status).toUpperCase(), decisionNote: r.DecisionNote || '', requestedAt: r.RequestedAt, decidedAt: r.DecidedAt || '' };
        });
    },
    decide: function (user, p) {
      var req = Store.findOne('reassign', function (r) { return String(r.ReqID) === String(p.reqId); });
      if (!req) fail('Request not found.');
      if (String(req.Status).toUpperCase() !== 'PENDING') fail('This request was already decided.');
      var role = String(user.Role).toUpperCase();
      if (role === 'CBA' && normEmail(req.CBA_Email) !== normEmail(user.Email)) fail('This request is not assigned to you.');
      var t = Store.findOne('tickets', function (x) { return String(x.TicketID) === String(req.TicketID); });
      if (!t) fail('Ticket not found.');
      var approve = p.approve === true || String(p.approve) === 'true';
      Store.update('reassign', req, { Status: approve ? 'APPROVED' : 'REJECTED', DecisionNote: String(p.note || '').trim(), DecidedAt: U.now() });
      if (approve) {
        Store.update('tickets', t, { AnalystEmail: normEmail(req.ToAnalyst), Status: 'ASSIGNED', UpdatedAt: U.now() });
        Tickets.log(t.TicketID, user, 'REASSIGN_APPROVED', normEmail(req.FromAnalyst), normEmail(req.ToAnalyst), req.DecisionNote);
        Auth.logActivity(user, 'REASSIGN_APPROVED', t.TicketID + ' -> ' + req.ToAnalyst);
      } else {
        Store.update('tickets', t, { Status: 'IN_PROGRESS', UpdatedAt: U.now() });
        Tickets.log(t.TicketID, user, 'REASSIGN_REJECTED', '', '', req.DecisionNote);
        Auth.logActivity(user, 'REASSIGN_REJECTED', t.TicketID);
      }
      return { status: approve ? 'APPROVED' : 'REJECTED' };
    }
  };

  /* ============================== Admin ============================ */
  var Admin = {
    publicClusters: function () {
      return Store.all('clusters').filter(function (c) { return !c.Status || String(c.Status).toUpperCase() === 'ACTIVE'; })
        .map(function (c) { return { clusterId: String(c.ClusterID), name: c.ClusterName }; });
    },
    teamWorkload: function (user) {
      var role = String(user.Role).toUpperCase();
      var analysts = Store.all('users').filter(function (u) {
        if (String(u.Role).toUpperCase() !== 'ANALYST') return false;
        if (role === 'ADMIN') return true;
        return String(u.ClusterID) === String(user.ClusterID);
      });
      var tickets = Store.all('tickets').filter(function (t) { return role === 'ADMIN' ? true : String(t.ClusterID) === String(user.ClusterID); });
      var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];
      return analysts.map(function (a) {
        var mine = tickets.filter(function (t) { return normEmail(t.AnalystEmail) === normEmail(a.Email); });
        return { email: normEmail(a.Email), name: a.Name, clusterId: a.ClusterID, open: mine.filter(function (t) { return openStates.indexOf(String(t.Status).toUpperCase()) >= 0; }).length, total: mine.length };
      }).sort(function (x, y) { return y.open - x.open; });
    },
    listUsers: function () {
      return Store.all('users').map(function (u) {
        return { userId: u.UserID, name: u.Name || '', email: normEmail(u.Email), phone: u.Phone || '', department: u.Department || '', defaultPriority: u.DefaultPriority || 'Medium', role: String(u.Role || 'USER').toUpperCase(), clusterId: u.ClusterID || '', reportsTo: normEmail(u.ReportsTo), status: String(u.Status || 'ACTIVE').toUpperCase(), createdAt: u.CreatedAt || '', lastLoginAt: u.LastLoginAt || '' };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    },
    saveUser: function (user, p) {
      var u = p.user || {};
      var email = normEmail(u.email);
      if (!email) fail('Email is required.');
      var role = String(u.role || 'USER').toUpperCase();
      if (['USER', 'CBA', 'ANALYST', 'ADMIN'].indexOf(role) === -1) fail('Invalid role.');
      var status = String(u.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
      var existing = Store.findOne('users', function (x) { return normEmail(x.Email) === email; });
      if (existing) {
        var roleChanged = String(existing.Role).toUpperCase() !== role;
        var statusChanged = String(existing.Status || 'ACTIVE').toUpperCase() !== status;
        Store.update('users', existing, {
          Name: u.name || existing.Name, Phone: u.phone !== undefined ? u.phone : existing.Phone,
          Department: u.department !== undefined ? u.department : existing.Department,
          DefaultPriority: PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : existing.DefaultPriority,
          Role: role, ClusterID: u.clusterId !== undefined ? u.clusterId : existing.ClusterID,
          ReportsTo: u.reportsTo !== undefined ? normEmail(u.reportsTo) : existing.ReportsTo, Status: status
        });
        if (roleChanged || statusChanged) Auth.killSessions(email);
        Auth.logActivity(user, 'USER_UPDATED', email + ' (' + role + ')');
        return { email: email, updated: true };
      }
      if (!u.name) fail('Name is required for a new user.');
      Store.insert('users', {
        UserID: Store.nextId('U-', 'users', 'UserID'), Name: u.name, Email: email, Phone: u.phone || '',
        Department: u.department || '', DefaultPriority: PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : 'Medium',
        Role: role, ClusterID: u.clusterId || '', ReportsTo: normEmail(u.reportsTo), Status: status,
        CreatedAt: U.now(), LastLoginAt: ''
      });
      Auth.logActivity(user, 'USER_CREATED', email + ' (' + role + ')');
      Mail.send(email, 'Welcome to ' + cfg('APP_NAME', 'PW Ticket Portal'), 'Hi ' + u.name + ', your account is ready.');
      return { email: email, created: true };
    },
    listClusters: function () {
      return Store.all('clusters').map(function (c) { return { clusterId: String(c.ClusterID), name: c.ClusterName, cbaEmail: normEmail(c.CBA_Email), status: String(c.Status || 'ACTIVE').toUpperCase() }; });
    },
    clusterAnalysts: function (user) {
      var role = String(user.Role).toUpperCase();
      return Store.all('users').filter(function (u) {
        if (String(u.Role).toUpperCase() !== 'ANALYST') return false;
        if (role === 'ADMIN') return true;
        return String(u.ClusterID) === String(user.ClusterID);
      }).map(function (u) {
        return {
          email: normEmail(u.Email), name: u.Name || '', phone: u.Phone || '',
          department: u.Department || '', clusterId: u.ClusterID || '',
          reportsTo: normEmail(u.ReportsTo), status: String(u.Status || 'ACTIVE').toUpperCase(),
          lastLoginAt: u.LastLoginAt || ''
        };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    },
    saveAnalyst: function (user, p) {
      var a = p.analyst || {};
      var email = normEmail(a.email);
      if (!email) fail('Email is required.');
      var actorRole = String(user.Role).toUpperCase();
      var clusterId = actorRole === 'ADMIN'
        ? String(a.clusterId || user.ClusterID || ADMIN_CLUSTER_ID)
        : String(user.ClusterID);
      if (!clusterId) fail('You are not assigned to a cluster yet.');
      var status = String(a.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
      var existing = Store.findOne('users', function (x) { return normEmail(x.Email) === email; });
      if (existing) {
        if (String(existing.Role).toUpperCase() !== 'ANALYST') {
          fail('That email belongs to a ' + String(existing.Role).toUpperCase() + ', not an analyst.');
        }
        if (actorRole !== 'ADMIN' && String(existing.ClusterID) !== String(user.ClusterID)) {
          fail('That analyst is not in your cluster.');
        }
        var statusChanged = String(existing.Status || 'ACTIVE').toUpperCase() !== status;
        Store.update('users', existing, {
          Name: a.name || existing.Name,
          Phone: a.phone !== undefined ? a.phone : existing.Phone,
          Department: a.department !== undefined ? a.department : existing.Department,
          ClusterID: clusterId,
          ReportsTo: a.reportsTo !== undefined ? normEmail(a.reportsTo) : existing.ReportsTo,
          Status: status
        });
        if (statusChanged) Auth.killSessions(email);
        Auth.logActivity(user, 'ANALYST_UPDATED', email + ' (' + clusterId + ')');
        return { email: email, updated: true };
      }
      if (!a.name || !String(a.name).trim()) fail('Name is required for a new analyst.');
      Store.insert('users', {
        UserID: Store.nextId('U-', 'users', 'UserID'), Name: String(a.name).trim(), Email: email,
        Phone: a.phone || '', Department: a.department || '', DefaultPriority: 'Medium',
        Role: ROLES.ANALYST, ClusterID: clusterId,
        ReportsTo: normEmail(a.reportsTo) || normEmail(user.Email),
        Status: status, CreatedAt: U.now(), LastLoginAt: ''
      });
      Auth.logActivity(user, 'ANALYST_CREATED', email + ' (' + clusterId + ')');
      Mail.send(email, 'Welcome to ' + cfg('APP_NAME', 'PW Ticket Portal'), 'Hi ' + a.name + ', your analyst account is ready.');
      return { email: email, created: true };
    },
    removeAnalyst: function (user, p) {
      var email = normEmail(p.email);
      if (!email) fail('Email is required.');
      var target = Store.findOne('users', function (x) { return normEmail(x.Email) === email; });
      if (!target) fail('Analyst not found.');
      if (String(target.Role).toUpperCase() !== 'ANALYST') fail('That user is not an analyst.');
      var actorRole = String(user.Role).toUpperCase();
      if (actorRole !== 'ADMIN' && String(target.ClusterID) !== String(user.ClusterID)) {
        fail('That analyst is not in your cluster.');
      }
      Store.update('users', target, { Status: 'INACTIVE' });
      Auth.killSessions(email);
      Auth.logActivity(user, 'ANALYST_REMOVED', email);
      return { email: email, removed: true };
    },
    saveCluster: function (user, p) {
      var c = p.cluster || {};
      var id = String(c.clusterId || '').trim();
      var name = String(c.name || '').trim();
      if (!name) fail('Cluster name is required.');
      var cbaEmail = normEmail(c.cbaEmail);
      var status = String(c.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
      if (id) {
        var existing = Store.findOne('clusters', function (x) { return String(x.ClusterID) === id; });
        if (!existing) fail('Cluster not found.');
        Store.update('clusters', existing, { ClusterName: name, CBA_Email: cbaEmail, Status: status });
        Auth.logActivity(user, 'CLUSTER_UPDATED', id);
        return { clusterId: id, updated: true };
      }
      var newId = Store.nextId('CL-', 'clusters', 'ClusterID');
      Store.insert('clusters', { ClusterID: newId, ClusterName: name, CBA_Email: cbaEmail, Status: status });
      Auth.logActivity(user, 'CLUSTER_CREATED', newId);
      return { clusterId: newId, created: true };
    },
    analytics: function (user, p) {
      var range = Admin.rangeMs_(p);
      var tickets = Store.all('tickets').filter(function (t) { return U.toMs(t.CreatedAt) >= range.from && U.toMs(t.CreatedAt) <= range.to; });
      var logs = Store.find('logs', function (l) { return U.toMs(l.Timestamp) >= range.from && U.toMs(l.Timestamp) <= range.to; });
      var users = Store.all('users');
      var byStatus = {}, byPriority = {}, byCluster = {}, byCategory = {}, trend = {};
      var overdue = 0, resolved = 0;
      tickets.forEach(function (t) {
        var st = String(t.Status).toUpperCase();
        byStatus[st] = (byStatus[st] || 0) + 1;
        byPriority[t.Priority] = (byPriority[t.Priority] || 0) + 1;
        byCluster[t.ClusterID || '—'] = (byCluster[t.ClusterID || '—'] || 0) + 1;
        byCategory[t.Category || 'Other'] = (byCategory[t.Category || 'Other'] || 0) + 1;
        var day = U.dayKey(t.CreatedAt);
        if (day) trend[day] = (trend[day] || 0) + 1;
        if (st === 'RESOLVED' || st === 'CLOSED') resolved++;
        if (t.DueAt && U.toMs(t.DueAt) < Date.now() && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
      });
      var assignMs = {};
      logs.forEach(function (l) { if (String(l.Action) === 'ASSIGNED') assignMs[l.TicketID] = U.toMs(l.Timestamp); });
      var firstAssignByCba = {}, resolveByAnalyst = {}, ratingByAnalyst = {};
      tickets.forEach(function (t) {
        var aMs = U.toMs(t.CreatedAt);
        if (assignMs[t.TicketID] && aMs) {
          var cba = t.CBA_Email || '—';
          firstAssignByCba[cba] = firstAssignByCba[cba] || { totalHrs: 0, count: 0 };
          firstAssignByCba[cba].totalHrs += (assignMs[t.TicketID] - aMs) / 3600000; firstAssignByCba[cba].count++;
        }
        if (t.ResolvedAt && aMs) {
          var an = normEmail(t.AnalystEmail) || '—';
          resolveByAnalyst[an] = resolveByAnalyst[an] || { totalHrs: 0, count: 0 };
          resolveByAnalyst[an].totalHrs += (U.toMs(t.ResolvedAt) - aMs) / 3600000; resolveByAnalyst[an].count++;
        }
        if (t.Rating) {
          var an2 = normEmail(t.AnalystEmail) || '—';
          ratingByAnalyst[an2] = ratingByAnalyst[an2] || { total: 0, count: 0 };
          ratingByAnalyst[an2].total += Number(t.Rating); ratingByAnalyst[an2].count++;
        }
      });
      function avgHours(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k].count ? Math.round((o[k].totalHrs / o[k].count) * 10) / 10 : 0; }); return out; }
      function avgRating(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k].count ? Math.round((o[k].total / o[k].count) * 10) / 10 : 0; }); return out; }
      var activity = Store.find('activity', function (a) { return U.toMs(a.Timestamp) >= range.from && U.toMs(a.Timestamp) <= range.to; });
      var active = Admin.rankActivity_(activity, users);
      var inactive = users.filter(function (u) {
        if (String(u.Status).toUpperCase() !== 'ACTIVE') return true;
        var last = U.toMs(u.LastLoginAt);
        return last && (Date.now() - last) > 15 * 86400000;
      }).map(function (u) { return { name: u.Name, email: normEmail(u.Email), role: String(u.Role).toUpperCase(), lastLoginAt: u.LastLoginAt || '' }; });
      return {
        range: { from: range.from, to: range.to, days: range.days },
        totals: { total: tickets.length, resolved: resolved, overdue: overdue, open: tickets.length - resolved },
        byStatus: byStatus, byPriority: byPriority, byCluster: byCluster, byCategory: byCategory, trend: trend,
        avgFirstAssignHrsByCba: avgHours(firstAssignByCba), avgResolveHrsByAnalyst: avgHours(resolveByAnalyst),
        avgRatingByAnalyst: avgRating(ratingByAnalyst), mostActive: active, inactiveMembers: inactive
      };
    },
    activity: function (user, p) {
      var range = Admin.rangeMs_(p);
      var events = Store.find('activity', function (a) { return U.toMs(a.Timestamp) >= range.from && U.toMs(a.Timestamp) <= range.to; });
      return { range: range, users: Admin.rankActivity_(events, Store.all('users')) };
    },
    rankActivity_: function (events, users) {
      var stats = {};
      function bucket(email, name, role) {
        email = normEmail(email);
        if (!stats[email]) stats[email] = { email: email, name: name || '', role: role || '', logins: 0, totalActions: 0, ticketsCreated: 0, comments: 0, lastActive: '', byEvent: {} };
        if (name && !stats[email].name) stats[email].name = name;
        if (role && !stats[email].role) stats[email].role = String(role).toUpperCase();
        return stats[email];
      }
      users.forEach(function (u) { bucket(u.Email, u.Name, u.Role); });
      events.forEach(function (a) {
        var s = bucket(a.Email, '', a.Role);
        s.totalActions++;
        var ev = String(a.Event || '').toUpperCase();
        s.byEvent[ev] = (s.byEvent[ev] || 0) + 1;
        if (ev === 'LOGIN') s.logins++;
        if (ev === 'TICKET_CREATE') s.ticketsCreated++;
        if (ev === 'COMMENT') s.comments++;
        var at = U.toMs(a.Timestamp);
        if (at && (!s.lastActive || at > U.toMs(s.lastActive))) s.lastActive = a.Timestamp;
      });
      return Object.keys(stats).map(function (k) { return stats[k]; }).sort(function (a, b) { return b.totalActions - a.totalActions; });
    },
    listMails: function () {
      return Store.all('mails').slice().sort(function (a, b) { return U.toMs(b.SentAt) - U.toMs(a.SentAt); });
    },
    exportCsv: function (user, p) {
      var type = String(p.type || 'tickets');
      var rows;
      if (type === 'logs') rows = Store.all('logs').map(function (l) { return { TicketID: l.TicketID, Action: l.Action, ByEmail: l.ByEmail, ByRole: l.ByRole, OldValue: l.OldValue, NewValue: l.NewValue, Note: l.Note, Timestamp: l.Timestamp }; });
      else if (type === 'activity') rows = Store.all('activity').map(function (a) { return { Timestamp: a.Timestamp, Email: a.Email, Role: a.Role, Event: a.Event, Meta: a.Meta }; });
      else rows = Store.all('tickets').map(function (t) { return { TicketID: t.TicketID, Title: t.Title, Category: t.Category, Priority: t.Priority, Status: t.Status, RaisedBy: t.RaisedByEmail, ClusterID: t.ClusterID, Analyst: t.AnalystEmail, DueAt: t.DueAt, CreatedAt: t.CreatedAt, ResolvedAt: t.ResolvedAt, ClosedAt: t.ClosedAt, Rating: t.Rating }; });
      return { filename: (type === 'logs' ? 'ticket-logs' : type === 'activity' ? 'activity-log' : 'tickets') + '.csv', csv: Admin.toCsv_(rows) };
    },
    toCsv_: function (rows) {
      if (!rows.length) return '';
      var headers = Object.keys(rows[0]);
      function cell(v) { var s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
      return headers.join(',') + '\n' + rows.map(function (r) { return headers.map(function (h) { return cell(r[h]); }).join(','); }).join('\n');
    },
    rangeMs_: function (p) {
      p = p || {};
      var to = p.to ? U.toMs(p.to) : Date.now();
      var from = p.from ? U.toMs(p.from) : to - (Number(p.days) || 30) * 86400000;
      return { from: from, to: to, days: Math.round((to - from) / 86400000) };
    }
  };

  /* ============================= Router ============================ */
  var PUBLIC_API = {
    signup: function (p) { return Auth.signup(p); },
    requestOtp: function (p) { return Auth.requestOtp(p); },
    verifyOtp: function (p) { return Auth.verifyOtp(p); },
    getClusters: function () { return Admin.publicClusters(); },
    getApproval: function (p) { return Approvals.getInfo(p.t, p.a); },
    decideApproval: function (p) { return Approvals.decide(p.t, p.a, p.decision, p.note); }
  };

  var PRIVATE_API = {
    logout: { fn: function (u, p) { return Auth.logout(p.token); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
    me: { fn: function (u) { return Auth.me(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
    createTicket: { fn: function (u, p) { return Tickets.create(u, p); }, roles: ['USER', 'CBA', 'ADMIN'] },
    listTickets: { fn: function (u, p) { return Tickets.list(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
    getTicket: { fn: function (u, p) { return Tickets.get(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
    addComment: { fn: function (u, p) { return Tickets.addComment(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
    assignTicket: { fn: function (u, p) { return Tickets.assign(u, p); }, roles: ['CBA', 'ADMIN'] },
    updateStatus: { fn: function (u, p) { return Tickets.updateStatus(u, p); }, roles: ['ANALYST', 'CBA', 'ADMIN'] },
    closeTicket: { fn: function (u, p) { return Tickets.close(u, p); }, roles: ['USER', 'ADMIN'] },
    reopenTicket: { fn: function (u, p) { return Tickets.reopen(u, p); }, roles: ['USER', 'ADMIN'] },
    rateTicket: { fn: function (u, p) { return Tickets.rate(u, p); }, roles: ['USER'] },
    myAnalysts: { fn: function (u) { return Tickets.myAnalysts(u); }, roles: ['CBA', 'ADMIN', 'ANALYST'] },
    requestApproval: { fn: function (u, p) { return Approvals.request(u, p); }, roles: ['CBA', 'ADMIN'] },
    requestReassign: { fn: function (u, p) { return Reassign.request(u, p); }, roles: ['ANALYST'] },
    listReassign: { fn: function (u) { return Reassign.list(u); }, roles: ['CBA', 'ADMIN'] },
    decideReassign: { fn: function (u, p) { return Reassign.decide(u, p); }, roles: ['CBA', 'ADMIN'] },
    teamWorkload: { fn: function (u) { return Admin.teamWorkload(u); }, roles: ['CBA', 'ADMIN'] },
    clusterAnalysts: { fn: function (u) { return Admin.clusterAnalysts(u); }, roles: ['CBA', 'ADMIN'] },
    saveAnalyst: { fn: function (u, p) { return Admin.saveAnalyst(u, p); }, roles: ['CBA', 'ADMIN'] },
    removeAnalyst: { fn: function (u, p) { return Admin.removeAnalyst(u, p); }, roles: ['CBA', 'ADMIN'] },
    adminUsers: { fn: function () { return Admin.listUsers(); }, roles: ['ADMIN'] },
    adminSaveUser: { fn: function (u, p) { return Admin.saveUser(u, p); }, roles: ['ADMIN'] },
    adminClusters: { fn: function () { return Admin.listClusters(); }, roles: ['ADMIN'] },
    adminSaveCluster: { fn: function (u, p) { return Admin.saveCluster(u, p); }, roles: ['ADMIN'] },
    adminAnalytics: { fn: function (u, p) { return Admin.analytics(u, p); }, roles: ['ADMIN'] },
    adminActivity: { fn: function (u, p) { return Admin.activity(u, p); }, roles: ['ADMIN'] },
    adminMails: { fn: function () { return Admin.listMails(); }, roles: ['ADMIN'] },
    adminExportCsv: { fn: function (u, p) { return Admin.exportCsv(u, p); }, roles: ['ADMIN'] },
    dashboard: { fn: function (u) { return Tickets.dashboard(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] }
  };

  var API = {
    call: function (name, token, payload) {
      try {
        payload = payload || {};
        if (PUBLIC_API[name]) return { ok: true, data: PUBLIC_API[name](payload) };
        var route = PRIVATE_API[name];
        if (!route) throw new Error('Unknown API: ' + name);
        var user = Auth.requireSession(token);
        if (route.roles.indexOf(user.Role) === -1) throw new Error('Not allowed for your role (' + user.Role + ').');
        return { ok: true, data: route.fn(user, payload) };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
    Auth: Auth, Tickets: Tickets, Approvals: Approvals, Reassign: Reassign, Admin: Admin, Mail: Mail
  };

  global.API = API;
})(window);
