/**
 * Tickets.gs
 * Raise, list, view, assign, progress, close, reopen, rate, and comment on tickets.
 * Every read passes through canSee(); every write checks an action permission.
 */

var Tickets = {

  /* --------------------------- visibility -------------------------- */
  canSee: function (user, t) {
    switch (String(user.Role).toUpperCase()) {
      case 'ADMIN':   return true;
      case 'CBA':     return String(t.ClusterID) === String(user.ClusterID);
      case 'ANALYST': return normEmail(t.AnalystEmail) === normEmail(user.Email);
      case 'USER':    return normEmail(t.RaisedByEmail) === normEmail(user.Email);
      default:        return false;
    }
  },

  log: function (ticketId, user, action, oldValue, newValue, note) {
    Db.insert(SHEETS.LOGS, {
      LogID: randomToken().slice(0, 12),
      TicketID: ticketId,
      Action: action,
      ByEmail: normEmail(user.Email),
      ByRole: String(user.Role || '').toUpperCase(),
      OldValue: oldValue == null ? '' : String(oldValue),
      NewValue: newValue == null ? '' : String(newValue),
      Note: note || '',
      Timestamp: now()
    });
  },

  /* ---------------------------- shapes ----------------------------- */
  publicTicket: function (t) {
    var dueMs = toMs(t.DueAt);
    var status = String(t.Status || '').toUpperCase();
    var slaState = (status === 'CLOSED' || status === 'RESOLVED') ? 'MET'
      : (!dueMs ? '-' : (Date.now() > dueMs ? 'BREACHED'
        : (dueMs - Date.now() < 4 * 3600000 ? 'DUE_SOON' : 'ON_TRACK')));
    return {
      ticketId: t.TicketID,
      title: t.Title,
      description: t.Description,
      category: t.Category || 'Other',
      priority: t.Priority || 'Medium',
      status: status,
      raisedByEmail: normEmail(t.RaisedByEmail),
      raisedByName: t.RaisedByName || '',
      raisedByPhone: t.RaisedByPhone || '',
      department: t.Department || '',
      clusterId: t.ClusterID || '',
      cbaEmail: normEmail(t.CBA_Email),
      analystEmail: normEmail(t.AnalystEmail),
      approvalRequired: String(t.ApprovalRequired).toUpperCase() === 'TRUE',
      approvalStatus: t.ApprovalStatus || 'NONE',
      approvedBy: normEmail(t.ApprovedBy),
      attachments: t.AttachmentLinks ? String(t.AttachmentLinks).split(',').filter(Boolean) : [],
      dueAt: t.DueAt || '',
      createdAt: t.CreatedAt || '',
      updatedAt: t.UpdatedAt || '',
      resolvedAt: t.ResolvedAt || '',
      closedAt: t.ClosedAt || '',
      rating: t.Rating || '',
      feedback: t.Feedback || '',
      slaState: slaState
    };
  },

  /* ---------------------------- create ----------------------------- */
  create: function (user, p) {
    if (!p.title || !String(p.title).trim()) throw new Error('Title is required.');
    if (!p.description || !String(p.description).trim()) throw new Error('Description is required.');

    var priority = PRIORITIES.indexOf(p.priority) >= 0 ? p.priority
      : (PRIORITIES.indexOf(user.DefaultPriority) >= 0 ? user.DefaultPriority : 'Medium');
    var title = String(p.title).trim();

    // Duplicate guard: same requester, same title, still open.
    if (!p.force) {
      var dup = Db.findOne(SHEETS.TICKETS, function (t) {
        return normEmail(t.RaisedByEmail) === normEmail(user.Email) &&
          String(t.Title).trim().toLowerCase() === title.toLowerCase() &&
          String(t.Status).toUpperCase() !== 'CLOSED';
      });
      if (dup) {
        return { duplicate: true, existingTicketId: dup.TicketID,
          message: 'You already have an open ticket with this title (' + dup.TicketID + ').' };
      }
    }

    var cluster = Db.findOne(SHEETS.CLUSTERS, function (c) { return String(c.ClusterID) === String(user.ClusterID); });
    var cbaEmail = cluster ? normEmail(cluster.CBA_Email) : '';
    var due = slaDueDate(priority);

    var ticket = withLock(function () {
      var id = Db.nextId('TKT-' + new Date().getFullYear() + '-', SHEETS.TICKETS, 'TicketID');
      var t = {
        TicketID: id,
        Title: title,
        Description: String(p.description).trim(),
        Category: String(p.category || 'Other').trim(),
        Priority: priority,
        Status: 'NEW',
        RaisedByEmail: normEmail(user.Email),
        RaisedByName: user.Name,
        RaisedByPhone: user.Phone || '',
        Department: String(p.department || user.Department || '').trim(),
        ClusterID: user.ClusterID || '',
        CBA_Email: cbaEmail,
        AnalystEmail: '',
        ApprovalRequired: 'FALSE',
        ApprovalStatus: 'NONE',
        ApprovedBy: '',
        AttachmentLinks: '',
        DueAt: due,
        CreatedAt: now(),
        UpdatedAt: now(),
        ResolvedAt: '',
        ClosedAt: '',
        Rating: '',
        Feedback: ''
      };
      Db.insert(SHEETS.TICKETS, t);
      return t;
    });

    Tickets.log(ticket.TicketID, user, 'CREATED', '', priority, 'Ticket raised');
    Auth.logActivity(user, 'TICKET_CREATE', ticket.TicketID);
    try {
      mailNewTicketToCba(ticket, cbaEmail);
      mailTicketCreatedToUser(ticket);
    } catch (e) { logErr('createMail', e); }

    return Tickets.publicTicket(ticket);
  },

  /* ----------------------------- list ------------------------------ */
  list: function (user, f) {
    f = f || {};
    var rows = Db.all(SHEETS.TICKETS).filter(function (t) { return Tickets.canSee(user, t); });

    if (f.status) rows = rows.filter(function (t) { return String(t.Status) === f.status; });
    if (f.priority) rows = rows.filter(function (t) { return String(t.Priority) === f.priority; });
    if (f.clusterId && user.Role === 'ADMIN') {
      rows = rows.filter(function (t) { return String(t.ClusterID) === String(f.clusterId); });
    }
    if (f.analyst) rows = rows.filter(function (t) { return normEmail(t.AnalystEmail) === normEmail(f.analyst); });
    if (f.from) rows = rows.filter(function (t) { return toMs(t.CreatedAt) >= toMs(f.from); });
    if (f.to) rows = rows.filter(function (t) { return toMs(t.CreatedAt) <= toMs(f.to); });
    if (f.q) {
      var q = String(f.q).toLowerCase();
      rows = rows.filter(function (t) {
        return (t.TicketID + ' ' + t.Title + ' ' + t.Description + ' ' + t.RaisedByName +
          ' ' + t.Department).toLowerCase().indexOf(q) >= 0;
      });
    }

    rows.sort(function (a, b) { return toMs(b.UpdatedAt || b.CreatedAt) - toMs(a.UpdatedAt || a.CreatedAt); });
    var total = rows.length;

    var page = Math.max(1, Number(f.page) || 1);
    var pageSize = Math.max(1, Number(f.pageSize) || 20);
    var start = (page - 1) * pageSize;
    var slice = rows.slice(start, start + pageSize).map(Tickets.publicTicket);

    return { rows: slice, total: total, page: page, pageSize: pageSize };
  },

  /* ----------------------------- get ------------------------------- */
  get: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (!Tickets.canSee(user, t)) throw new Error('You do not have access to this ticket.');

    var logs = Db.find(SHEETS.LOGS, function (l) { return String(l.TicketID) === String(p.ticketId); })
      .sort(function (a, b) { return toMs(a.Timestamp) - toMs(b.Timestamp); })
      .map(function (l) {
        return { action: l.Action, byEmail: normEmail(l.ByEmail), byRole: l.ByRole,
          oldValue: l.OldValue, newValue: l.NewValue, note: l.Note, at: l.Timestamp };
      });

    var comments = Db.find(SHEETS.COMMENTS, function (c) { return String(c.TicketID) === String(p.ticketId); })
      .sort(function (a, b) { return toMs(a.Timestamp) - toMs(b.Timestamp); })
      .map(function (c) {
        return { commentId: c.CommentID, byEmail: normEmail(c.ByEmail), byName: c.ByName,
          text: c.Text, at: c.Timestamp };
      });

    var approvals = Db.find(SHEETS.APPROVALS, function (a) { return String(a.TicketID) === String(p.ticketId); })
      .map(function (a) {
        return { approvalId: a.ApprovalID, approverEmail: normEmail(a.ApproverEmail),
          requestedBy: normEmail(a.RequestedByEmail), note: a.RequestNote, status: a.Status,
          decisionNote: a.DecisionNote, requestedAt: a.RequestedAt, expiresAt: a.ExpiresAt,
          decidedAt: a.DecidedAt };
      });

    var reassigns = Db.find(SHEETS.REASSIGN, function (r) { return String(r.TicketID) === String(p.ticketId); })
      .map(function (r) {
        return { reqId: r.ReqID, fromAnalyst: normEmail(r.FromAnalyst), toAnalyst: normEmail(r.ToAnalyst),
          reason: r.Reason, status: r.Status, decisionNote: r.DecisionNote,
          requestedAt: r.RequestedAt, decidedAt: r.DecidedAt };
      });

    return Object.assign(Tickets.publicTicket(t), {
      logs: logs, comments: comments, approvals: approvals, reassignRequests: reassigns
    });
  },

  /* ---------------------------- assign ----------------------------- */
  assign: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (!Tickets.canSee(user, t)) throw new Error('This ticket is outside your cluster.');
    var st = String(t.Status).toUpperCase();
    if (['CLOSED', 'RESOLVED'].indexOf(st) >= 0) throw new Error('Cannot assign a ' + st + ' ticket.');

    var analyst = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === normEmail(p.analystEmail); });
    if (!analyst || String(analyst.Role).toUpperCase() !== 'ANALYST') {
      throw new Error('Selected user is not an Associate Analyst.');
    }
    if (String(analyst.Status).toUpperCase() !== 'ACTIVE') throw new Error('That analyst is inactive.');
    if (String(analyst.ClusterID) !== String(t.ClusterID)) {
      throw new Error('That analyst is not in this ticket\'s cluster.');
    }

    var old = t.AnalystEmail || '';
    Db.update(SHEETS.TICKETS, t._row, {
      AnalystEmail: normEmail(analyst.Email), Status: 'ASSIGNED', UpdatedAt: now()
    });
    Tickets.log(t.TicketID, user, 'ASSIGNED', old, normEmail(analyst.Email), p.note || '');
    Auth.logActivity(user, 'ASSIGN', t.TicketID + ' -> ' + analyst.Email);

    var fresh = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    try {
      mailAssignedToAnalyst(fresh, normEmail(analyst.Email), user.Name);
      mailAssignedToRequester(fresh);
    } catch (e) { logErr('assignMail', e); }
    return Tickets.publicTicket(fresh);
  },

  /** Analysts a CBA/admin can assign to (same cluster). */
  myAnalysts: function (user) {
    var role = String(user.Role).toUpperCase();
    return Db.all(SHEETS.USERS).filter(function (u) {
      if (String(u.Role).toUpperCase() !== 'ANALYST') return false;
      if (String(u.Status).toUpperCase() !== 'ACTIVE') return false;
      if (role === 'ADMIN') return true;
      return String(u.ClusterID) === String(user.ClusterID);
    }).map(function (u) {
      return { email: normEmail(u.Email), name: u.Name, clusterId: u.ClusterID };
    });
  },

  /* -------------------------- status flow -------------------------- */
  updateStatus: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (!Tickets.canSee(user, t)) throw new Error('Access denied.');

    var to = String(p.status || '').toUpperCase();
    var from = String(t.Status || '').toUpperCase();
    if (TICKET_STATUSES.indexOf(to) === -1) throw new Error('Invalid status.');

    var role = String(user.Role).toUpperCase();
    if (role === 'ANALYST' && normEmail(t.AnalystEmail) !== normEmail(user.Email)) {
      throw new Error('This ticket is not assigned to you.');
    }
    if (role === 'ANALYST' || role === 'CBA') {
      var allowed = {
        ASSIGNED: ['IN_PROGRESS'],
        IN_PROGRESS: ['ON_HOLD', 'RESOLVED'],
        ON_HOLD: ['IN_PROGRESS'],
        PENDING_APPROVAL: ['IN_PROGRESS'],
        REOPENED: ['IN_PROGRESS', 'ASSIGNED'],
        NEW: ['IN_PROGRESS']
      };
      var list = allowed[from] || [];
      if (list.indexOf(to) === -1) throw new Error('Cannot move from ' + from + ' to ' + to + '.');
    }

    var patch = { Status: to, UpdatedAt: now() };
    if (to === 'RESOLVED') patch.ResolvedAt = now();
    Db.update(SHEETS.TICKETS, t._row, patch);
    Tickets.log(t.TicketID, user, 'STATUS_CHANGED', from, to, p.note || '');
    Auth.logActivity(user, 'TICKET_UPDATE', t.TicketID + ' -> ' + to);

    var fresh = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    try { mailStatusChange(fresh, to, user); } catch (e) { logErr('statusMail', e); }
    return Tickets.publicTicket(fresh);
  },

  /* ------------------------- close / reopen ------------------------ */
  close: function (user, p) {
    var t = Tickets.mustOwn(user, p.ticketId);
    if (String(t.Status).toUpperCase() !== 'RESOLVED') {
      throw new Error('Only a resolved ticket can be closed.');
    }
    Db.update(SHEETS.TICKETS, t._row, { Status: 'CLOSED', ClosedAt: now(), UpdatedAt: now() });
    Tickets.log(t.TicketID, user, 'CLOSED', 'RESOLVED', 'CLOSED', p.note || '');
    return Tickets.publicTicket(Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(t.TicketID); }));
  },

  reopen: function (user, p) {
    var t = Tickets.mustOwn(user, p.ticketId);
    var st = String(t.Status).toUpperCase();
    if (['RESOLVED', 'CLOSED'].indexOf(st) === -1) throw new Error('Only resolved/closed tickets can be reopened.');
    if (!p.reason || !String(p.reason).trim()) throw new Error('Please give a reason for reopening.');
    Db.update(SHEETS.TICKETS, t._row, { Status: 'REOPENED', ClosedAt: '', ResolvedAt: '', UpdatedAt: now() });
    Tickets.log(t.TicketID, user, 'REOPENED', st, 'REOPENED', String(p.reason).trim());
    var fresh = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(t.TicketID); });
    try { mailStatusChange(fresh, 'REOPENED', user); } catch (e) { logErr('reopenMail', e); }
    return Tickets.publicTicket(fresh);
  },

  rate: function (user, p) {
    var t = Tickets.mustOwn(user, p.ticketId);
    if (String(t.Status).toUpperCase() !== 'CLOSED') throw new Error('You can rate only closed tickets.');
    if (t.Rating !== '' && t.Rating != null) throw new Error('This ticket is already rated.');
    var rating = Number(p.rating);
    if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be between 1 and 5.');
    Db.update(SHEETS.TICKETS, t._row, { Rating: rating, Feedback: String(p.feedback || '').trim() });
    Tickets.log(t.TicketID, user, 'RATED', '', String(rating), String(p.feedback || '').trim());
    return { rating: rating };
  },

  mustOwn: function (user, ticketId) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(ticketId); });
    if (!t) throw new Error('Ticket not found.');
    var role = String(user.Role).toUpperCase();
    var owner = normEmail(t.RaisedByEmail) === normEmail(user.Email);
    if (role !== 'ADMIN' && !owner) throw new Error('Only the requester can do this.');
    return t;
  },

  /* --------------------------- comments ---------------------------- */
  addComment: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (!Tickets.canSee(user, t)) throw new Error('Access denied.');
    if (!p.text || !String(p.text).trim()) throw new Error('Comment cannot be empty.');

    Db.insert(SHEETS.COMMENTS, {
      CommentID: randomToken().slice(0, 12),
      TicketID: t.TicketID,
      ByEmail: normEmail(user.Email),
      ByName: user.Name,
      Text: String(p.text).trim(),
      Timestamp: now()
    });
    Db.update(SHEETS.TICKETS, t._row, { UpdatedAt: now() });
    Tickets.log(t.TicketID, user, 'COMMENT', '', '', String(p.text).trim().slice(0, 120));
    Auth.logActivity(user, 'COMMENT', t.TicketID);
    try { mailComment(t, user, String(p.text).trim()); } catch (e) { logErr('commentMail', e); }
    return { commentId: 'ok' };
  },

  /* --------------------------- dashboard --------------------------- */
  dashboard: function (user) {
    var role = String(user.Role).toUpperCase();
    var tickets = Db.all(SHEETS.TICKETS).filter(function (t) { return Tickets.canSee(user, t); });
    var byStatus = {}, byPriority = {}, byCluster = {};
    var open = 0, closed = 0, unassigned = 0, mine = 0, overdue = 0;
    var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'ON_HOLD', 'RESOLVED', 'REOPENED'];
    tickets.forEach(function (t) {
      var st = String(t.Status).toUpperCase();
      byStatus[st] = (byStatus[st] || 0) + 1;
      byPriority[t.Priority] = (byPriority[t.Priority] || 0) + 1;
      byCluster[t.ClusterID] = (byCluster[t.ClusterID] || 0) + 1;
      if (openStates.indexOf(st) >= 0) open++; else if (st === 'CLOSED') closed++;
      if (!t.AnalystEmail) unassigned++;
      if (normEmail(t.AnalystEmail) === normEmail(user.Email)) mine++;
      if (toMs(t.DueAt) && Date.now() > toMs(t.DueAt) && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
    });
    var recent = tickets
      .sort(function (a, b) { return toMs(b.CreatedAt) - toMs(a.CreatedAt); })
      .slice(0, 5).map(Tickets.publicTicket);

    var out = {
      total: tickets.length, open: open, closed: closed, unassigned: unassigned,
      assignedToMe: mine, overdue: overdue, byStatus: byStatus, byPriority: byPriority,
      byCluster: byCluster, recent: recent, role: role, clusterId: user.ClusterID || ''
    };
    if (role === 'CBA' || role === 'ADMIN') {
      out.pendingReassignments = Db.find(SHEETS.REASSIGN, function (r) {
        if (String(r.Status).toUpperCase() !== 'PENDING') return false;
        if (role === 'ADMIN') return true;
        return normEmail(r.CBA_Email) === normEmail(user.Email);
      }).length;
      out.pendingApprovals = tickets.filter(function (t) {
        return String(t.ApprovalStatus).toUpperCase() === 'PENDING';
      }).length;
    }
    return out;
  }
};
