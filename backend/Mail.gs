/**
 * Mail.gs
 * All outbound email. Every workflow mail funnels through here so failures
 * never break a user action (a failed mail returns false, it never throws).
 */

function sendMail(opts) {
  try {
    MailApp.sendEmail({
      to: opts.to,
      subject: opts.subject,
      htmlBody: opts.htmlBody,
      name: cfg('APP_NAME'),
      replyTo: opts.replyTo || undefined
    });
    return true;
  } catch (e) {
    logErr('sendMail', e);
    return false;
  }
}

function shell(title, bodyHtml) {
  return '' +
    '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:0 auto;' +
    'border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">' +
    '<div style="background:#111827;color:#fff;padding:16px 22px;font-size:18px;font-weight:600">' +
    escHtml(cfg('APP_NAME')) + '</div>' +
    '<div style="padding:22px;color:#111827;font-size:14px;line-height:1.55">' +
    '<h2 style="margin:0 0 12px;font-size:18px">' + escHtml(title) + '</h2>' + bodyHtml +
    '</div>' +
    '<div style="background:#f9fafb;color:#6b7280;padding:12px 22px;font-size:12px">' +
    'This is an automated message from ' + escHtml(cfg('APP_NAME')) + '.</div></div>';
}

function kvTable(rows) {
  return '<table style="border-collapse:separate;border-spacing:0 4px;width:100%">' +
    rows.map(function (r) {
      return '<tr><td style="padding:6px 10px;background:#f3f4f6;font-weight:600;width:160px;' +
        'border-radius:6px 0 0 6px">' + escHtml(r[0]) + '</td>' +
        '<td style="padding:6px 10px;background:#f9fafb">' + escHtml(r[1] || '-') + '</td></tr>';
    }).join('') + '</table>';
}

function button(label, url, color) {
  if (!url) return '';
  return '<p style="margin:18px 0"><a href="' + url + '" style="background:' +
    (color || '#111827') + ';color:#fff;padding:11px 20px;border-radius:8px;' +
    'text-decoration:none;font-weight:600">' + escHtml(label) + '</a></p>';
}

/* ------------------------------- OTP ------------------------------- */
function mailOtp(email, name, code) {
  var html = shell('Your login code',
    '<p>Hi ' + escHtml(name || 'there') + ',</p>' +
    '<p>Use the code below to sign in. It expires in ' + escHtml(cfg('OTP_EXPIRY_MIN')) +
    ' minutes.</p>' +
    '<div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;' +
    'padding:16px;background:#f3f4f6;border-radius:10px;margin:16px 0">' + escHtml(code) + '</div>' +
    '<p style="color:#6b7280;font-size:12px">If you did not request this, ignore this email.</p>');
  return sendMail({ to: email, subject: cfg('APP_NAME') + ' - Login OTP', htmlBody: html });
}

function mailWelcome(email, name) {
  return sendMail({
    to: email,
    subject: 'Welcome to ' + cfg('APP_NAME'),
    htmlBody: shell('Welcome aboard',
      '<p>Hi ' + escHtml(name) + ',</p><p>Your account is ready. You can now raise ' +
      'requests to the Analytics team and track them.</p>' +
      button('Open the portal', portalUrl()))
  });
}

/* --------------------------- ticket mails -------------------------- */
function mailNewTicketToCba(ticket, cbaEmail) {
  if (!cbaEmail) return false;
  return sendMail({
    to: cbaEmail,
    subject: '[New Ticket] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('New ticket in your cluster',
      '<p>A new request needs triage.</p>' +
      kvTable([
        ['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Category', ticket.Category],
        ['Requester', ticket.RaisedByName + ' (' + ticket.RaisedByEmail + ')']
      ]) + button('Open ticket', ticketUrl(ticket.TicketID)))
  });
}

function mailTicketCreatedToUser(ticket) {
  return sendMail({
    to: normEmail(ticket.RaisedByEmail),
    subject: '[Received] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('We received your request',
      '<p>Your ticket has been logged and routed to the right team.</p>' +
      kvTable([
        ['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Due by', fmtDate(ticket.DueAt)]
      ]) + button('Track it', ticketUrl(ticket.TicketID)))
  });
}

function mailAssignedToAnalyst(ticket, analystEmail, actorName) {
  return sendMail({
    to: analystEmail,
    subject: '[Assigned] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('A ticket was assigned to you',
      '<p>' + escHtml(actorName) + ' assigned this ticket to you.</p>' +
      kvTable([
        ['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Requester', ticket.RaisedByName],
        ['Due by', fmtDate(ticket.DueAt)]
      ]) + button('Open ticket', ticketUrl(ticket.TicketID)))
  });
}

function mailAssignedToRequester(ticket) {
  return sendMail({
    to: normEmail(ticket.RaisedByEmail),
    subject: 'Update on ' + ticket.TicketID,
    htmlBody: shell('Your request is being worked on',
      '<p>Hi ' + escHtml(ticket.RaisedByName) + ',</p>' +
      '<p>Your ticket has been assigned to ' + escHtml(ticket.AnalystEmail) + '.</p>' +
      kvTable([['Ticket', ticket.TicketID], ['Title', ticket.Title]]))
  });
}

function mailStatusChange(ticket, status, actor) {
  var to = recipientsForTicket(ticket, actor.Email);
  if (!to) return false;
  return sendMail({
    to: to,
    subject: '[' + status + '] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('Ticket status updated',
      '<p>' + escHtml(actor.Name || actor.Email) + ' moved this ticket to <b>' +
      escHtml(status) + '</b>.</p>' +
      kvTable([['Ticket', ticket.TicketID], ['Title', ticket.Title], ['New status', status]]))
  });
}

function mailComment(ticket, actor, text) {
  var to = recipientsForTicket(ticket, actor.Email);
  if (!to) return false;
  return sendMail({
    to: to,
    subject: '[Comment] ' + ticket.TicketID,
    htmlBody: shell('New comment on ' + ticket.TicketID,
      '<p><b>' + escHtml(actor.Name || actor.Email) + '</b> wrote:</p>' +
      '<blockquote style="border-left:3px solid #2563eb;margin:0;padding:6px 12px;color:#374151">' +
      escHtml(text) + '</blockquote>' + button('View ticket', ticketUrl(ticket.TicketID)))
  });
}

/* ------------------------ approval mails --------------------------- */
function mailApprovalRequest(approval, ticket, requester, approveUrl, rejectUrl) {
  return sendMail({
    to: normEmail(approval.ApproverEmail),
    subject: '[Approval Needed] ' + ticket.TicketID + ': ' + ticket.Title,
    replyTo: normEmail(requester.Email),
    htmlBody: shell('Approval request',
      '<p>A request has been routed to you for approval.</p>' +
      kvTable([
        ['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Details', String(ticket.Description).slice(0, 300)],
        ['Raised by', ticket.RaisedByName + ' (' + ticket.RaisedByEmail + ')'],
        ['Requested by (CBA)', requester.Name + ' (' + requester.Email + ')'],
        ['Note', approval.RequestNote]
      ]) +
      '<p style="margin:18px 0">' +
      '<a href="' + approveUrl + '" style="background:#16a34a;color:#fff;padding:12px 24px;' +
      'text-decoration:none;border-radius:6px;font-weight:600">Approve</a> &nbsp;' +
      '<a href="' + rejectUrl + '" style="background:#dc2626;color:#fff;padding:12px 24px;' +
      'text-decoration:none;border-radius:6px;font-weight:600">Reject</a></p>' +
      '<p style="color:#6b7280;font-size:12px">This link is valid for ' +
      escHtml(cfg('APPROVAL_EXPIRY_HRS')) + ' hours.</p>')
  });
}

function mailApprovalDecision(approval, ticket, decision, decider) {
  var to = [normEmail(approval.RequestedByEmail), normEmail(ticket.AnalystEmail)].filter(Boolean).join(',');
  return sendMail({
    to: to,
    subject: '[Approval ' + decision + '] ' + ticket.TicketID,
    htmlBody: shell('Approval ' + decision.toLowerCase(),
      '<p>' + escHtml(decider || approval.ApproverEmail) + ' has <b>' +
      escHtml(decision.toLowerCase()) + '</b> the request for ' + escHtml(ticket.TicketID) + '.</p>' +
      kvTable([['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Note', approval.DecisionNote || '-']]))
  });
}

/* ------------------------ reassign mails --------------------------- */
function mailReassignRequest(req, ticket, actor) {
  var cbaEmail = req.CBA_Email || normEmail(cfg('ADMIN_EMAIL'));
  return sendMail({
    to: cbaEmail,
    subject: '[Approval needed] Reassign ' + req.TicketID,
    htmlBody: shell('Reassignment approval needed',
      '<p>' + escHtml(actor.Name || actor.Email) + ' wants to hand this ticket to another analyst.</p>' +
      kvTable([
        ['Ticket', req.TicketID], ['Title', ticket.Title],
        ['From', req.FromAnalyst], ['To', req.ToAnalyst], ['Reason', req.Reason]
      ]) + button('Open approvals', portalUrl()))
  });
}

function mailReassignDecision(req, ticket, decider, approved) {
  var to = [normEmail(req.FromAnalyst), normEmail(req.ToAnalyst)].filter(Boolean).join(',');
  return sendMail({
    to: to,
    subject: '[Reassignment ' + (approved ? 'APPROVED' : 'REJECTED') + '] ' + req.TicketID,
    htmlBody: shell('Reassignment ' + (approved ? 'approved' : 'rejected'),
      '<p>' + escHtml(decider.Name || decider.Email) + ' has <b>' +
      (approved ? 'approved' : 'rejected') + '</b> the reassignment for ' +
      escHtml(req.TicketID) + '.</p>' +
      kvTable([['Ticket', req.TicketID], ['To', req.ToAnalyst], ['Note', req.DecisionNote || '-']]))
  });
}

/* -------------------------- automation ----------------------------- */
function mailSlaWarning(ticket, cbaEmail) {
  return sendMail({
    to: cbaEmail,
    subject: '[SLA warning] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('A ticket is nearing its deadline',
      kvTable([['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Due', fmtDate(ticket.DueAt)]]))
  });
}

function mailOverdue(ticket, toEmail) {
  return sendMail({
    to: toEmail,
    subject: '[OVERDUE] ' + ticket.TicketID + ' - ' + ticket.Title,
    htmlBody: shell('This ticket is overdue',
      kvTable([['Ticket', ticket.TicketID], ['Title', ticket.Title],
        ['Priority', ticket.Priority], ['Due', fmtDate(ticket.DueAt)]]))
  });
}

/* ---------------------------- helpers ------------------------------ */
function recipientsForTicket(ticket, excludeEmail) {
  var set = {};
  set[normEmail(ticket.RaisedByEmail)] = true;
  if (ticket.AnalystEmail) set[normEmail(ticket.AnalystEmail)] = true;
  if (ticket.CBA_Email) set[normEmail(ticket.CBA_Email)] = true;
  delete set[normEmail(excludeEmail)];
  return Object.keys(set).filter(Boolean).join(',');
}

function fmtDate(v) {
  if (!v) return '-';
  try {
    return Utilities.formatDate(new Date(v), Session.getScriptTimeZone() || 'Asia/Kolkata',
      'dd MMM yyyy, HH:mm');
  } catch (e) { return String(v); }
}
