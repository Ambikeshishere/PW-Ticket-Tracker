/**
 * Triggers.gs
 * Time-driven automation. Run setupTriggers() once from the editor.
 *   - dailyReminders  : 09:00 daily — pending work digests
 *   - hourlySlaCheck  : hourly — SLA warnings + overdue escalation e.g. every hour
 *   - cleanupExpired  : 02:00 daily — expired OTP/sessions, auto-close resolved tickets
 */

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyReminders').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('hourlySlaCheck').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('cleanupExpired').timeBased().everyDays(1).atHour(2).create();
  return true;
}

/** Daily digest: unassigned -> CBA, open work -> each analyst. */
function dailyReminders() {
  var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];
  var tickets = Db.all(SHEETS.TICKETS).filter(function (t) {
    return openStates.indexOf(String(t.Status).toUpperCase()) >= 0;
  });

  // Unassigned tickets grouped by cluster -> CBA
  var unassignedByCba = {};
  tickets.forEach(function (t) {
    if (!t.AnalystEmail && t.CBA_Email) {
      unassignedByCba[normEmail(t.CBA_Email)] = unassignedByCba[normEmail(t.CBA_Email)] || [];
      unassignedByCba[normEmail(t.CBA_Email)].push(t);
    }
  });
  Object.keys(unassignedByCba).forEach(function (cbaEmail) {
    var list = unassignedByCba[cbaEmail];
    sendMail({
      to: cbaEmail,
      subject: '[Daily] ' + list.length + ' unassigned ticket(s)',
      htmlBody: shell('Unassigned tickets need triage',
        '<ul>' + list.map(function (t) {
          return '<li><b>' + escHtml(t.TicketID) + '</b> — ' + escHtml(t.Title) +
            ' (' + escHtml(t.Priority) + ')</li>';
        }).join('') + '</ul>' + button('Open portal', portalUrl()))
    });
  });

  // Open tickets grouped by analyst
  var byAnalyst = {};
  tickets.forEach(function (t) {
    if (t.AnalystEmail) {
      var e = normEmail(t.AnalystEmail);
      byAnalyst[e] = byAnalyst[e] || [];
      byAnalyst[e].push(t);
    }
  });
  Object.keys(byAnalyst).forEach(function (analyst) {
    var list = byAnalyst[analyst];
    sendMail({
      to: analyst,
      subject: '[Daily] Your open tickets (' + list.length + ')',
      htmlBody: shell('Your open queue',
        '<ul>' + list.map(function (t) {
          return '<li><b>' + escHtml(t.TicketID) + '</b> — ' + escHtml(t.Title) +
            ' [' + escHtml(t.Status) + ']</li>';
        }).join('') + '</ul>' + button('Open portal', portalUrl()))
    });
  });
  return true;
}

/** Hourly SLA check: warn near deadline, escalate when overdue. */
function hourlySlaCheck() {
  var openStates = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED', 'PENDING_APPROVAL'];
  var warnWindow = 4 * 3600000;
  Db.all(SHEETS.TICKETS).forEach(function (t) {
    var st = String(t.Status).toUpperCase();
    if (openStates.indexOf(st) === -1) return;
    var due = toMs(t.DueAt);
    if (!due) return;
    var remaining = due - Date.now();
    if (remaining < 0) {
      // Overdue is derived from DueAt + Status at read time (see Tickets.publicTicket),
      // so there is no column to write here — just escalate by email.
      var to = [t.CBA_Email, normEmail(cfg('ADMIN_EMAIL'))].filter(Boolean).join(',');
      try { mailOverdue(t, to); } catch (e) { logErr('overdueMail', e); }
    } else if (remaining < warnWindow && t.CBA_Email) {
      try { mailSlaWarning(t, normEmail(t.CBA_Email)); } catch (e) { logErr('slaWarnMail', e); }
    }
  });
  return true;
}

/** Daily cleanup: expired OTP/sessions/approvals, auto-close resolved tickets. */
function cleanupExpired() {
  var nowMs = Date.now();
  Db.deleteWhere(SHEETS.OTP, function (r) { return toMs(r.ExpiresAt) < nowMs; });
  Db.deleteWhere(SHEETS.SESSIONS, function (r) { return toMs(r.ExpiresAt) < nowMs; });
  Db.deleteWhere(SHEETS.APPROVALS, function (a) {
    return String(a.Status).toUpperCase() === 'PENDING' && toMs(a.ExpiresAt) < nowMs;
  });

  var autoCloseMs = cfgNum('AUTO_CLOSE_DAYS') * 86400000;
  Db.all(SHEETS.TICKETS).forEach(function (t) {
    if (String(t.Status).toUpperCase() !== 'RESOLVED') return;
    if (toMs(t.ResolvedAt) && (nowMs - toMs(t.ResolvedAt)) > autoCloseMs) {
      Db.update(SHEETS.TICKETS, t._row, { Status: 'CLOSED', ClosedAt: now(), UpdatedAt: now() });
      Tickets.log(t.TicketID, { Email: 'system', Role: 'SYSTEM' }, 'CLOSED', 'RESOLVED', 'CLOSED', 'Auto-closed after ' + cfg('AUTO_CLOSE_DAYS') + ' days');
    }
  });
  return true;
}
