/**
 * Approvals.gs
 * External (email) approval flow. A random token is generated and only its
 * hash is stored; the emailed link carries the raw token. Approvals are
 * single-use and expire.
 */

var Approvals = {

  /** CBA/admin requests sign-off from an email address. */
  request: function (user, p) {
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(p.ticketId); });
    if (!t) throw new Error('Ticket not found.');
    if (!Tickets.canSee(user, t)) throw new Error('Access denied.');

    var approver = normEmail(p.approverEmail);
    if (!approver || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(approver)) {
      throw new Error('A valid approver email is required.');
    }

    var token = randomToken();
    var approvalId = 'APR-' + randomToken().slice(0, 10).toUpperCase();
    var approval = {
      ApprovalID: approvalId,
      TicketID: t.TicketID,
      RequestedByEmail: normEmail(user.Email),
      ApproverEmail: approver,
      TokenHash: sha256(token),                 // only the hash is stored
      Status: 'PENDING',
      RequestNote: String(p.note || '').trim(),
      DecisionNote: '',
      RequestedAt: now(),
      ExpiresAt: addHours(now(), cfgNum('APPROVAL_EXPIRY_HRS')),
      DecidedAt: ''
    };
    Db.insert(SHEETS.APPROVALS, approval);
    Db.update(SHEETS.TICKETS, t._row, {
      ApprovalRequired: 'TRUE', ApprovalStatus: 'PENDING', Status: 'PENDING_APPROVAL', UpdatedAt: now()
    });
    Tickets.log(t.TicketID, user, 'APPROVAL_REQUESTED', '', approver, approval.RequestNote);
    Auth.logActivity(user, 'APPROVAL_SENT', t.TicketID + ' -> ' + approver);

    // Both buttons open the static portal's approval page; the approver then
    // chooses Approve/Reject there (never auto-decided by a GET request).
    var base = portalUrl();
    var approveUrl = base + '#approve/' + approvalId + '/' + token;
    var rejectUrl = approveUrl;
    try { mailApprovalRequest(approval, t, user, approveUrl, rejectUrl); } catch (e) { logErr('approvalMail', e); }

    return { approvalId: approvalId, approverEmail: approver, expiresAt: approval.ExpiresAt };
  },

  /** Public: confirmation page data (no session required). */
  getInfo: function (token, approvalId) {
    var a = Approvals.lookup_(token, approvalId);
    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(a.TicketID); }) || {};
    var requester = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === normEmail(t.RaisedByEmail); }) || {};
    var expired = toMs(a.ExpiresAt) < Date.now() && String(a.Status).toUpperCase() === 'PENDING';
    return {
      approvalId: a.ApprovalID,
      status: expired ? 'EXPIRED' : String(a.Status).toUpperCase(),
      canDecide: String(a.Status).toUpperCase() === 'PENDING' && !expired,
      approverEmail: normEmail(a.ApproverEmail),
      requestedBy: normEmail(a.RequestedByEmail),
      note: a.RequestNote,
      decisionNote: a.DecisionNote || '',
      requestedAt: a.RequestedAt,
      expiresAt: a.ExpiresAt,
      decidedAt: a.DecidedAt || '',
      ticket: {
        ticketId: t.TicketID, title: t.Title, description: t.Description,
        priority: t.Priority, category: t.Category, department: t.Department,
        raisedByName: t.RaisedByName, raisedByEmail: normEmail(t.RaisedByEmail),
        raisedByPhone: requester.Phone || t.RaisedByPhone || ''
      }
    };
  },

  /** Public: the approver confirms Approve/Reject on the page. */
  decide: function (token, approvalId, decision, note) {
    decision = String(decision || '').toUpperCase();
    if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Error('Invalid decision.');

    var a = Approvals.lookup_(token, approvalId);
    if (String(a.Status).toUpperCase() !== 'PENDING') {
      throw new Error('This request has already been ' + String(a.Status).toLowerCase() + '.');
    }
    if (toMs(a.ExpiresAt) < Date.now()) throw new Error('This approval link has expired.');

    var t = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(a.TicketID); });
    if (!t) throw new Error('Ticket not found.');

    Db.update(SHEETS.APPROVALS, a._row, {
      Status: decision, DecisionNote: String(note || '').trim(), DecidedAt: now()
    });
    Db.update(SHEETS.TICKETS, t._row, {
      ApprovalStatus: decision, ApprovedBy: normEmail(a.ApproverEmail),
      Status: decision === 'APPROVED' ? 'IN_PROGRESS' : 'ON_HOLD', UpdatedAt: now()
    });

    var actor = { Email: a.ApproverEmail, Name: a.ApproverEmail, Role: 'APPROVER' };
    Tickets.log(a.TicketID, actor, 'APPROVAL_' + decision, '', decision, String(note || '').trim());
    Auth.logActivity(actor, 'APPROVAL_' + decision, a.TicketID);

    var fresh = Db.findOne(SHEETS.TICKETS, function (x) { return String(x.TicketID) === String(a.TicketID); });
    var freshApproval = Db.findOne(SHEETS.APPROVALS, function (x) { return String(x.ApprovalID) === String(a.ApprovalID); });
    try { mailApprovalDecision(freshApproval, fresh, decision, a.ApproverEmail); } catch (e) { logErr('approvalDecisionMail', e); }

    return { status: decision };
  },

  /** Finds an approval by id and validates the token hash. */
  lookup_: function (token, approvalId) {
    if (!token || !approvalId) throw new Error('Missing approval link details.');
    var a = Db.findOne(SHEETS.APPROVALS, function (x) {
      return String(x.ApprovalID) === String(approvalId) &&
        String(x.TokenHash) === sha256(token);
    });
    if (!a) throw new Error('This approval link is invalid.');
    return a;
  }
};
