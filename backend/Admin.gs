/**
 * Admin.gs
 * User + cluster management, analytics, activity tracking, workload, and CSV export.
 * Everything here requires the ADMIN role except publicClusters and teamWorkload.
 */

var Admin = {

  /* ------------------------- public / shared ----------------------- */
  /** Cluster list for the sign-up dropdown (no session needed). */
  publicClusters: function () {
    return Db.all(SHEETS.CLUSTERS)
      .filter(function (c) { return !c.Status || String(c.Status).toUpperCase() === 'ACTIVE'; })
      .map(function (c) { return { clusterId: String(c.ClusterID), name: c.ClusterName }; });
  },

  /** Open-ticket workload per analyst (CBA sees their cluster). */
  teamWorkload: function (user) {
    var role = String(user.Role).toUpperCase();
    var analysts = Db.all(SHEETS.USERS).filter(function (u) {
      if (String(u.Role).toUpperCase() !== 'ANALYST') return false;
      if (role === 'ADMIN') return true;
      return String(u.ClusterID) === String(user.ClusterID);
    });
    var tickets = Db.all(SHEETS.TICKETS).filter(function (t) {
      return role === 'ADMIN' ? true : String(t.ClusterID) === String(user.ClusterID);
    });
    var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];
    return analysts.map(function (a) {
      var mine = tickets.filter(function (t) { return normEmail(t.AnalystEmail) === normEmail(a.Email); });
      return {
        email: normEmail(a.Email), name: a.Name, clusterId: a.ClusterID,
        open: mine.filter(function (t) { return openStates.indexOf(String(t.Status).toUpperCase()) >= 0; }).length,
        total: mine.length
      };
    }).sort(function (x, y) { return y.open - x.open; });
  },

  /* ------------------------------ users ---------------------------- */
  listUsers: function () {
    return Db.all(SHEETS.USERS).map(function (u) {
      return {
        userId: u.UserID, name: u.Name || '', email: normEmail(u.Email), phone: u.Phone || '',
        department: u.Department || '', defaultPriority: u.DefaultPriority || 'Medium',
        role: String(u.Role || 'USER').toUpperCase(), clusterId: u.ClusterID || '',
        reportsTo: normEmail(u.ReportsTo), status: String(u.Status || 'ACTIVE').toUpperCase(),
        createdAt: u.CreatedAt || '', lastLoginAt: u.LastLoginAt || ''
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  },

  saveUser: function (user, p) {
    var u = p.user || {};
    var email = normEmail(u.email);
    if (!email) throw new Error('Email is required.');
    var role = String(u.role || 'USER').toUpperCase();
    if ([ROLES.USER, ROLES.CBA, ROLES.ANALYST, ROLES.ADMIN].indexOf(role) === -1) {
      throw new Error('Invalid role.');
    }
    var status = String(u.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    var existing = Db.findOne(SHEETS.USERS, function (x) { return normEmail(x.Email) === email; });

    if (existing) {
      var roleChanged = String(existing.Role).toUpperCase() !== role;
      var statusChanged = String(existing.Status || 'ACTIVE').toUpperCase() !== status;
      Db.update(SHEETS.USERS, existing._row, {
        Name: u.name || existing.Name,
        Phone: u.phone !== undefined ? u.phone : existing.Phone,
        Department: u.department !== undefined ? u.department : existing.Department,
        DefaultPriority: PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : existing.DefaultPriority,
        Role: role,
        ClusterID: u.clusterId !== undefined ? u.clusterId : existing.ClusterID,
        ReportsTo: u.reportsTo !== undefined ? normEmail(u.reportsTo) : existing.ReportsTo,
        Status: status
      });
      // Force re-login if their access level changed.
      if (roleChanged || statusChanged) Auth.killSessions(email);
      Auth.logActivity(user, 'USER_UPDATED', email + ' (' + role + ')');
      return { email: email, updated: true };
    }

    if (!u.name) throw new Error('Name is required for a new user.');
    var fresh = {
      UserID: withLock(function () { return Db.nextId('U-', SHEETS.USERS, 'UserID'); }),
      Name: u.name, Email: email, Phone: u.phone || '', Department: u.department || '',
      DefaultPriority: PRIORITIES.indexOf(u.defaultPriority) >= 0 ? u.defaultPriority : 'Medium',
      Role: role, ClusterID: u.clusterId || '', ReportsTo: normEmail(u.reportsTo),
      Status: status, CreatedAt: now().toISOString(), LastLoginAt: ''
    };
    Db.insert(SHEETS.USERS, fresh);
    Auth.logActivity(user, 'USER_CREATED', email + ' (' + role + ')');
    try { mailWelcome(email, fresh.Name); } catch (e) { logErr('adminWelcomeMail', e); }
    return { email: email, created: true };
  },

  /* ------------------------ cluster analysts ----------------------- */
  /**
   * Analysts a CBA manages in their own cluster (admins see every analyst).
   * This is the roster behind the "My Analysts" screen.
   */
  clusterAnalysts: function (user) {
    var role = String(user.Role).toUpperCase();
    return Db.all(SHEETS.USERS).filter(function (u) {
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

  /**
   * Adds or updates an ANALYST in the acting CBA's cluster. A CBA can only
   * touch analysts in their own cluster and cannot change a user's role; an
   * admin may target any cluster.
   */
  saveAnalyst: function (user, p) {
    var a = p.analyst || {};
    var email = normEmail(a.email);
    if (!email) throw new Error('Email is required.');
    var actorRole = String(user.Role).toUpperCase();
    var clusterId = actorRole === 'ADMIN'
      ? String(a.clusterId || user.ClusterID || ADMIN_CLUSTER_ID)
      : String(user.ClusterID);
    if (!clusterId) throw new Error('You are not assigned to a cluster yet.');
    var status = String(a.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    var existing = Db.findOne(SHEETS.USERS, function (x) { return normEmail(x.Email) === email; });

    if (existing) {
      if (String(existing.Role).toUpperCase() !== 'ANALYST') {
        throw new Error('That email belongs to a ' + String(existing.Role).toUpperCase() +
          ', not an analyst.');
      }
      if (actorRole !== 'ADMIN' && String(existing.ClusterID) !== String(user.ClusterID)) {
        throw new Error('That analyst is not in your cluster.');
      }
      var statusChanged = String(existing.Status || 'ACTIVE').toUpperCase() !== status;
      Db.update(SHEETS.USERS, existing._row, {
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

    if (!a.name || !String(a.name).trim()) throw new Error('Name is required for a new analyst.');
    var fresh = {
      UserID: withLock(function () { return Db.nextId('U-', SHEETS.USERS, 'UserID'); }),
      Name: String(a.name).trim(), Email: email, Phone: a.phone || '',
      Department: a.department || '', DefaultPriority: 'Medium',
      Role: ROLES.ANALYST, ClusterID: clusterId,
      ReportsTo: normEmail(a.reportsTo) || normEmail(user.Email),
      Status: status, CreatedAt: now().toISOString(), LastLoginAt: ''
    };
    Db.insert(SHEETS.USERS, fresh);
    Auth.logActivity(user, 'ANALYST_CREATED', email + ' (' + clusterId + ')');
    try { mailWelcome(email, fresh.Name); } catch (e) { logErr('analystWelcomeMail', e); }
    return { email: email, created: true };
  },

  /** Removes (deactivates) an analyst from the acting CBA's cluster. */
  removeAnalyst: function (user, p) {
    var email = normEmail(p.email);
    if (!email) throw new Error('Email is required.');
    var target = Db.findOne(SHEETS.USERS, function (x) { return normEmail(x.Email) === email; });
    if (!target) throw new Error('Analyst not found.');
    if (String(target.Role).toUpperCase() !== 'ANALYST') throw new Error('That user is not an analyst.');
    var actorRole = String(user.Role).toUpperCase();
    if (actorRole !== 'ADMIN' && String(target.ClusterID) !== String(user.ClusterID)) {
      throw new Error('That analyst is not in your cluster.');
    }
    Db.update(SHEETS.USERS, target._row, { Status: 'INACTIVE' });
    Auth.killSessions(email);
    Auth.logActivity(user, 'ANALYST_REMOVED', email);
    return { email: email, removed: true };
  },

  /* ---------------------------- clusters --------------------------- */
  listClusters: function () {
    return Db.all(SHEETS.CLUSTERS).map(function (c) {
      return { clusterId: String(c.ClusterID), name: c.ClusterName, cbaEmail: normEmail(c.CBA_Email),
        status: String(c.Status || 'ACTIVE').toUpperCase() };
    });
  },

  saveCluster: function (user, p) {
    var c = p.cluster || {};
    var id = String(c.clusterId || '').trim();
    var name = String(c.name || '').trim();
    if (!name) throw new Error('Cluster name is required.');
    var cbaEmail = normEmail(c.cbaEmail);
    var status = String(c.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    if (id) {
      var existing = Db.findOne(SHEETS.CLUSTERS, function (x) { return String(x.ClusterID) === id; });
      if (!existing) throw new Error('Cluster not found.');
      Db.update(SHEETS.CLUSTERS, existing._row, { ClusterName: name, CBA_Email: cbaEmail, Status: status });
      Auth.logActivity(user, 'CLUSTER_UPDATED', id);
      return { clusterId: id, updated: true };
    }
    var newId = withLock(function () { return Db.nextId('CL-', SHEETS.CLUSTERS, 'ClusterID'); });
    Db.insert(SHEETS.CLUSTERS, { ClusterID: newId, ClusterName: name, CBA_Email: cbaEmail, Status: status });
    Auth.logActivity(user, 'CLUSTER_CREATED', newId);
    return { clusterId: newId, created: true };
  },

  /* --------------------------- analytics --------------------------- */
  analytics: function (user, p) {
    var range = Admin.rangeMs_(p);
    var tickets = Db.all(SHEETS.TICKETS).filter(function (t) {
      return toMs(t.CreatedAt) >= range.from && toMs(t.CreatedAt) <= range.to;
    });
    var logs = Db.find(SHEETS.LOGS, function (l) { return toMs(l.Timestamp) >= range.from && toMs(l.Timestamp) <= range.to; });
    var users = Db.all(SHEETS.USERS);

    var byStatus = {}, byPriority = {}, byCluster = {}, byCategory = {}, trend = {};
    var overdue = 0, resolved = 0;
    tickets.forEach(function (t) {
      var st = String(t.Status).toUpperCase();
      byStatus[st] = (byStatus[st] || 0) + 1;
      byPriority[t.Priority] = (byPriority[t.Priority] || 0) + 1;
      byCluster[t.ClusterID || '—'] = (byCluster[t.ClusterID || '—'] || 0) + 1;
      byCategory[t.Category || 'Other'] = (byCategory[t.Category || 'Other'] || 0) + 1;
      var day = String(t.CreatedAt || '').slice(0, 10);
      if (day) trend[day] = (trend[day] || 0) + 1;
      if (st === 'RESOLVED' || st === 'CLOSED') resolved++;
      if (t.DueAt && toMs(t.DueAt) < Date.now() && st !== 'CLOSED' && st !== 'RESOLVED') overdue++;
    });

    // first-assignment time + resolution time + rating, per person
    var assignMs = {};   // ticketId -> ms
    logs.forEach(function (l) {
      if (String(l.Action) === 'ASSIGNED') assignMs[l.TicketID] = toMs(l.Timestamp);
    });
    var createdMs = {};
    Db.all(SHEETS.TICKETS).forEach(function (t) { createdMs[t.TicketID] = toMs(t.CreatedAt); });

    var firstAssignByCba = {};
    var resolveByAnalyst = {};
    var ratingByAnalyst = {};
    tickets.forEach(function (t) {
      var aMs = toMs(t.CreatedAt);
      if (assignMs[t.TicketID] && aMs) {
        var cba = t.CBA_Email || '—';
        firstAssignByCba[cba] = firstAssignByCba[cba] || { totalHrs: 0, count: 0 };
        firstAssignByCba[cba].totalHrs += (assignMs[t.TicketID] - aMs) / 3600000;
        firstAssignByCba[cba].count++;
      }
      if (t.ResolvedAt && aMs) {
        var an = normEmail(t.AnalystEmail) || '—';
        resolveByAnalyst[an] = resolveByAnalyst[an] || { totalHrs: 0, count: 0 };
        resolveByAnalyst[an].totalHrs += (toMs(t.ResolvedAt) - aMs) / 3600000;
        resolveByAnalyst[an].count++;
      }
      if (t.Rating) {
        var an2 = normEmail(t.AnalystEmail) || '—';
        ratingByAnalyst[an2] = ratingByAnalyst[an2] || { total: 0, count: 0 };
        ratingByAnalyst[an2].total += Number(t.Rating);
        ratingByAnalyst[an2].count++;
      }
    });

    function avgHours(obj) {
      var out = {};
      Object.keys(obj).forEach(function (k) {
        out[k] = obj[k].count ? Math.round((obj[k].totalHrs / obj[k].count) * 10) / 10 : 0;
      });
      return out;
    }
    function avgRating(obj) {
      var out = {};
      Object.keys(obj).forEach(function (k) {
        out[k] = obj[k].count ? Math.round((obj[k].total / obj[k].count) * 10) / 10 : 0;
      });
      return out;
    }

    var activity = Db.find(SHEETS.ACTIVITY, function (a) { return toMs(a.Timestamp) >= range.from && toMs(a.Timestamp) <= range.to; });
    var active = Admin.rankActivity_(activity, users);

    var inactive = users.filter(function (u) {
      if (String(u.Status).toUpperCase() !== 'ACTIVE') return true;
      var last = toMs(u.LastLoginAt);
      return last && (Date.now() - last) > 15 * 86400000;
    }).map(function (u) {
      return { name: u.Name, email: normEmail(u.Email), role: String(u.Role).toUpperCase(), lastLoginAt: u.LastLoginAt || '' };
    });

    return {
      range: { from: range.from, to: range.to, days: range.days },
      totals: { total: tickets.length, resolved: resolved, overdue: overdue,
        open: tickets.length - resolved },
      byStatus: byStatus, byPriority: byPriority, byCluster: byCluster, byCategory: byCategory,
      trend: trend,
      avgFirstAssignHrsByCba: avgHours(firstAssignByCba),
      avgResolveHrsByAnalyst: avgHours(resolveByAnalyst),
      avgRatingByAnalyst: avgRating(ratingByAnalyst),
      mostActive: active,
      inactiveMembers: inactive,
      lastLogins: users.map(function (u) {
        return { name: u.Name, email: normEmail(u.Email), role: String(u.Role).toUpperCase(),
          lastLoginAt: u.LastLoginAt || '' };
      }).sort(function (a, b) { return toMs(b.lastLoginAt) - toMs(a.lastLoginAt); })
    };
  },

  activity: function (user, p) {
    var range = Admin.rangeMs_(p);
    var events = Db.find(SHEETS.ACTIVITY, function (a) {
      return toMs(a.Timestamp) >= range.from && toMs(a.Timestamp) <= range.to;
    });
    return { range: range, users: Admin.rankActivity_(events, Db.all(SHEETS.USERS)) };
  },

  /** Ops diagnostic: recent outbound mail + whether the drain trigger is live. */
  mailQueue: function (user, p) {
    var limit = Math.min(Number((p && p.limit) || 20), 100);
    var all = Db.all(SHEETS.MAILQUEUE);
    var rows = all.slice(-limit).map(function (r) {
      return {
        queueId: r.QueueID, to: r.To, subject: r.Subject, status: r.Status,
        attempts: r.Attempts, createdAt: r.CreatedAt, sentAt: r.SentAt, error: r.Error
      };
    });
    var triggers = [];
    try {
      triggers = ScriptApp.getProjectTriggers().map(function (t) {
        try { return t.getHandlerFunction(); } catch (e) { return '?'; }
      });
    } catch (e) {}
    return {
      enabled: MAIL_QUEUE_ENABLED,
      pending: all.filter(function (r) { return String(r.Status || 'PENDING').toUpperCase() === 'PENDING'; }).length,
      total: all.length,
      drainTriggerInstalled: triggers.indexOf('drainMailQueue') >= 0,
      triggers: triggers,
      rows: rows
    };
  },

  rankActivity_: function (events, users) {
    var stats = {};
    function bucket(email, name, role) {
      email = normEmail(email);
      if (!stats[email]) stats[email] = { email: email, name: name || '', role: role || '',
        logins: 0, totalActions: 0, ticketsCreated: 0, comments: 0, lastActive: '', byEvent: {} };
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
      var at = toMs(a.Timestamp);
      if (at && (!s.lastActive || at > toMs(s.lastActive))) s.lastActive = a.Timestamp;
    });
    return Object.keys(stats).map(function (k) { return stats[k]; })
      .sort(function (a, b) { return b.totalActions - a.totalActions; });
  },

  /* ---------------------------- export ----------------------------- */
  exportCsv: function (user, p) {
    var type = String(p.type || 'tickets');
    if (type === 'logs') {
      var rows = Db.all(SHEETS.LOGS).map(function (l) {
        return { TicketID: l.TicketID, Action: l.Action, ByEmail: l.ByEmail, ByRole: l.ByRole,
          OldValue: l.OldValue, NewValue: l.NewValue, Note: l.Note, Timestamp: l.Timestamp };
      });
      return { filename: 'ticket-logs.csv', csv: Admin.toCsv_(rows) };
    }
    if (type === 'activity') {
      var acts = Db.all(SHEETS.ACTIVITY).map(function (a) {
        return { Timestamp: a.Timestamp, Email: a.Email, Role: a.Role, Event: a.Event, Meta: a.Meta };
      });
      return { filename: 'activity-log.csv', csv: Admin.toCsv_(acts) };
    }
    var tickets = Db.all(SHEETS.TICKETS).map(function (t) {
      return { TicketID: t.TicketID, Title: t.Title, Category: t.Category, Priority: t.Priority,
        Status: t.Status, RaisedBy: t.RaisedByEmail, ClusterID: t.ClusterID, Analyst: t.AnalystEmail,
        DueAt: t.DueAt, CreatedAt: t.CreatedAt, ResolvedAt: t.ResolvedAt, ClosedAt: t.ClosedAt,
        Rating: t.Rating };
    });
    return { filename: 'tickets.csv', csv: Admin.toCsv_(tickets) };
  },

  toCsv_: function (rows) {
    if (!rows.length) return '';
    var headers = Object.keys(rows[0]);
    function cell(v) {
      var s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    return headers.join(',') + '\n' + rows.map(function (r) {
      return headers.map(function (h) { return cell(r[h]); }).join(',');
    }).join('\n');
  },

  rangeMs_: function (p) {
    p = p || {};
    var to = p.to ? toMs(p.to) : Date.now();
    var from;
    if (p.from) from = toMs(p.from);
    else from = to - (Number(p.days) || 30) * 86400000;
    return { from: from, to: to, days: Math.round((to - from) / 86400000) };
  }
};
