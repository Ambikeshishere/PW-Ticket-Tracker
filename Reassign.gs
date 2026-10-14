/**
 * Reassign.gs
 * Analyst-to-analyst reassignment. The requesting analyst proposes a change;
 * only a CBA (their cluster) or admin can approve it. Until approval the ticket
 * stays with the original analyst.
 */

var Reassign = {

  request: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (normEmail(t.AnalystEmail) !== normEmail(user.Email)) {
      throw new Error('Only the assigned analyst can request a reassignment.');
    }
    var st = String(t.Status).toUpperCase();
    if (st === 'CLOSED') throw new Error('Closed tickets cannot be reassigned.');

    var toAnalyst = normEmail(p.toAnalystEmail);
    if (!toAnalyst) throw new Error('Select the analyst to reassign to.');
    if (toAnalyst === normEmail(user.Email)) throw new Error('You cannot reassign to yourself.');

    var target = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === toAnalyst; });
    if (!target || String(target.Role).toUpperCase() !== 'ANALYST' || String(target.Status).toUpperCase() !== 'ACTIVE') {
      throw new Error('Target is not an active Associate Analyst.');
    }
    if (String(target.ClusterID) !== String(t.ClusterID)) {
      throw new Error('Target analyst is not in this ticket\'s cluster.');
    }

    var pending = Db.findOne(SHEETS.REASSIGN, function (r) {
      return String(r.TicketID) === String(t.TicketID) && String(r.Status).toUpperCase() === 'PENDING';
    });
    if (pending) throw new Error('A reassignment request is already pending for this ticket.');

    var req = {
      ReqID: 'RR-' + randomToken().slice(0, 10).toUpperCase(),
      TicketID: t.TicketID,
      FromAnalyst: normEmail(user.Email),
      ToAnalyst: toAnalyst,
      Reason: String(p.reason || '').trim(),
      Status: 'PENDING',
      CBA_Email: t.CBA_Email || '',
      DecisionNote: '',
      RequestedAt: now(),
      DecidedAt: ''
    };
    Db.insert(SHEETS.REASSIGN, req);
    Db.update(SHEETS.TICKETS, t._row, { Status: 'PENDING_APPROVAL', UpdatedAt: now() });
    Tickets.log(t.TicketID, user, 'REASSIGN_REQUESTED', normEmail(user.Email), toAnalyst, req.Reason);
    Auth.logActivity(user, 'REASSIGN_REQUEST', t.TicketID + ' -> ' + toAnalyst);

    try { mailReassignRequest(req, t, user); } catch (e) { logErr('reassignReqMail', e); }
    return req;
  },

  list: function (user) {
    var role = String(user.Role).toUpperCase();
    var rows = Db.all(SHEETS.REASSIGN);
    if (role === 'CBA') {
      rows = rows.filter(function (r) { return normEmail(r.CBA_Email) === normEmail(user.Email); });
    }
    return rows
      .sort(function (a, b) { return toMs(b.RequestedAt) - toMs(a.RequestedAt); })
      .map(function (r) {
        var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(r.TicketID); }) || {};
        return {
          reqId: r.ReqID, ticketId: r.TicketID, ticketTitle: t.Title || '',
          fromAnalyst: normEmail(r.FromAnalyst), toAnalyst: normEmail(r.ToAnalyst),
          reason: r.Reason, status: String(r.Status).toUpperCase(),
          decisionNote: r.DecisionNote || '', requestedAt: r.RequestedAt, decidedAt: r.DecidedAt || ''
        };
      });
  },

  decide: function (user, p) {
    var req = Db.findOne(SHEETS.REASSIGN, function (r) { return String(r.ReqID) === String(p.reqId); });
    if (!req) throw new Error('Request not found.');
    if (String(req.Status).toUpperCase() !== 'PENDING') throw new Error('This request was already decided.');
    var role = String(user.Role).toUpperCase();
    if (role === 'CBA' && normEmail(req.CBA_Email) !== normEmail(user.Email)) {
      throw new Error('This request is not assigned to you.');
    }
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(req.TicketID); });
    if (!t) throw new Error('Ticket not found.');

    var approve = p.approve === true || String(p.approve) === 'true';
    Db.update(SHEETS.REASSIGN, req._row, {
      Status: approve ? 'APPROVED' : 'REJECTED',
      DecisionNote: String(p.note || '').trim(),
      DecidedAt: now()
    });
    req.DecisionNote = String(p.note || '').trim();

    if (approve) {
      var target = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === normEmail(req.ToAnalyst); }) || {};
      Db.update(SHEETS.TICKETS, t._row, {
        AnalystEmail: normEmail(req.ToAnalyst), Status: 'ASSIGNED', UpdatedAt: now()
      });
      Tickets.log(t.TicketID, user, 'REASSIGN_APPROVED', normEmail(req.FromAnalyst), normEmail(req.ToAnalyst), req.DecisionNote);
      Auth.logActivity(user, 'REASSIGN_APPROVED', t.TicketID + ' -> ' + req.ToAnalyst);
      try { mailAssignedToAnalyst(
        Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(t.TicketID); }),
        normEmail(target.Email), user.Name); } catch (e) { logErr('reassignApproveMail', e); }
    } else {
      Db.update(SHEETS.TICKETS, t._row, { Status: 'IN_PROGRESS', UpdatedAt: now() });
      Tickets.log(t.TicketID, user, 'REASSIGN_REJECTED', '', '', req.DecisionNote);
      Auth.logActivity(user, 'REASSIGN_REJECTED', t.TicketID);
    }

    try { mailReassignDecision(req, t, user, approve); } catch (e) { logErr('reassignDecisionMail', e); }
    return { status: approve ? 'APPROVED' : 'REJECTED' };
  }
};
