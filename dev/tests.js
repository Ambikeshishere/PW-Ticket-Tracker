/**
 * dev/tests.js
 * End-to-end-ish tests that drive the REAL backend modules (Auth, Tickets,
 * Approvals, Reassign, Admin, the api() router) against the in-memory mock.
 *
 * Run with:  node dev/run.js
 */

module.exports = function runTests(ctx, t) {
  const { ok, eq, throws, section } = t;

  const ADMIN_EMAIL = 'ambikesh.srivastava@pw.live';
  const rawUser = (email) =>
    ctx.Db.findOne(ctx.SHEETS.USERS, (u) => ctx.normEmail(u.Email) === email);
  const lastOtp = (email) => {
    const mails = ctx.__test.sentMails.filter((m) => m.to === email && /Login OTP/.test(m.subject));
    const m = mails[mails.length - 1];
    if (!m) return null;
    // the code sits alone inside a div: >593504</div>
    const match = m.htmlBody.match(/>(\d{6})</);
    return match ? match[1] : null;
  };

  /* ============================ setup ============================ */
  section('Setup');
  ctx.setup();
  const tabNames = ctx.__test.ss.getSheets().map((s) => s.name);
  eq('creates 12 tabs', tabNames.length, 12);
  ok('has Users tab', tabNames.includes('Users'));
  ok('has Config tab', tabNames.includes('Config'));
  ok('has Approvals tab', tabNames.includes('Approvals'));
  ok('has MailQueue tab', tabNames.includes('MailQueue'));

  const salt = ctx.cfg('SALT');
  ok('SALT is generated (not the placeholder)', salt && salt !== 'CHANGE-ME-please-set-a-random-salt');
  ok('admin account seeded', !!rawUser(ADMIN_EMAIL));
  ok('Admin cluster seeded', !!ctx.Db.findOne(ctx.SHEETS.CLUSTERS, (c) => String(c.ClusterID) === 'CL-ADMIN'));
  eq('admin lives in the Admin cluster', String(rawUser(ADMIN_EMAIL).ClusterID), 'CL-ADMIN');
  ok('portalUrl points at the front-end', ctx.portalUrl().indexOf('github.io') !== -1, ctx.portalUrl());
  ok('ticketUrl deep-links to a ticket', /#ticket\/TKT-/.test(ctx.ticketUrl('TKT-1')), ctx.ticketUrl('TKT-1'));

  const admin = rawUser(ADMIN_EMAIL);
  admin.Role = 'ADMIN';

  /* ============================ signup =========================== */
  section('Sign-up');
  const su = ctx.Auth.signup({
    name: 'Riya Sharma', email: 'riya@pw.live', phone: '9876543210',
    department: 'Sales', clusterId: '', defaultPriority: 'High',
  });
  ok('valid signup succeeds', su.registered === true);
  const riya = rawUser('riya@pw.live');
  eq('self signup is forced to USER role', riya.Role, 'USER');
  eq('default priority stored', riya.DefaultPriority, 'High');

  throws('rejects non-company domain', () =>
    ctx.Auth.signup({ name: 'X', email: 'x@gmail.com', phone: '9876543210', department: 'Sales' }), 'pw.live');
  throws('rejects duplicate email', () =>
    ctx.Auth.signup({ name: 'Riya', email: 'riya@pw.live', phone: '9876543210', department: 'Sales' }), 'already exists');
  throws('rejects bad phone', () =>
    ctx.Auth.signup({ name: 'Y', email: 'y@pw.live', phone: '12345', department: 'Sales' }), 'mobile');

  /* ============================= OTP ============================= */
  section('OTP login');
  const unknown = ctx.Auth.requestOtp({ email: 'nobody@pw.live' });
  ok('unknown email returns generic success', unknown.sent === true);
  ok('unknown email creates no OTP row',
    !ctx.Db.findOne(ctx.SHEETS.OTP, (r) => ctx.normEmail(r.Email) === 'nobody@pw.live'));

  ctx.Auth.requestOtp({ email: 'riya@pw.live' });
  const otp = lastOtp('riya@pw.live');
  ok('OTP email sent with a 6-digit code', !!otp && otp.length === 6);
  ok('OTP row stored (hashed)', !!ctx.Db.findOne(ctx.SHEETS.OTP, (r) => ctx.normEmail(r.Email) === 'riya@pw.live'));

  throws('wrong OTP is rejected', () => ctx.Auth.verifyOtp({ email: 'riya@pw.live', code: '000000' }), 'Incorrect');
  const login = ctx.Auth.verifyOtp({ email: 'riya@pw.live', code: otp });
  ok('correct OTP returns a token', !!login.token);
  eq('login returns USER role', login.user.role, 'USER');
  ok('OTP row consumed after login',
    !ctx.Db.findOne(ctx.SHEETS.OTP, (r) => ctx.normEmail(r.Email) === 'riya@pw.live'));

  /* =========================== sessions ========================== */
  section('Sessions');
  const sessionUser = ctx.Auth.requireSession(login.token);
  eq('requireSession resolves the user', ctx.normEmail(sessionUser.Email), 'riya@pw.live');
  throws('bad token is rejected', () => ctx.Auth.requireSession('garbage'), 'SESSION_EXPIRED');

  /* ====================== admin: cluster/users =================== */
  section('Admin: clusters & users');
  const cl = ctx.Admin.saveCluster(admin, { cluster: { name: 'Sales Analytics', cbaEmail: 'cba@pw.live' } });
  ok('cluster created', !!cl.clusterId);
  const clusterId = cl.clusterId;

  ctx.Admin.saveUser(admin, { user: { name: 'Cba One', email: 'cba@pw.live', role: 'CBA', clusterId } });
  ctx.Admin.saveUser(admin, { user: { name: 'Ana Lyst', email: 'analyst@pw.live', role: 'ANALYST', clusterId } });
  const cba = rawUser('cba@pw.live'); cba.Role = 'CBA';
  const analyst = rawUser('analyst@pw.live'); analyst.Role = 'ANALYST';
  eq('CBA role stored', cba.Role, 'CBA');
  eq('analyst role stored', analyst.Role, 'ANALYST');

  // put riya in the cluster so her tickets route to the CBA
  ctx.Db.update(ctx.SHEETS.USERS, riya._row, { ClusterID: clusterId });
  const riya2 = rawUser('riya@pw.live');

  /* =========================== tickets =========================== */
  section('Tickets');
  const created = ctx.Tickets.create(riya2, {
    title: 'Need weekly sales report', description: 'Please share the weekly numbers.',
    category: 'Report request', priority: 'High', department: 'Sales',
  });
  ok('ticket created', /^TKT-\d{4}-\d{5}$/.test(created.ticketId));
  eq('new ticket status', created.status, 'NEW');
  eq('SLA due date set', !!created.dueAt, true);
  eq('routed to cluster CBA', created.cbaEmail, 'cba@pw.live');

  const dup = ctx.Tickets.create(riya2, {
    title: 'Need weekly sales report', description: 'again', priority: 'High',
  });
  ok('duplicate guard triggers', dup.duplicate === true);

  const ticketId = created.ticketId;

  // visibility
  const otherUser = { Email: 'someone@pw.live', Role: 'USER' };
  throws('other user cannot see the ticket', () => ctx.Tickets.get(otherUser, { ticketId }), 'access');

  // assign
  const assigned = ctx.Tickets.assign(cba, { ticketId, analystEmail: 'analyst@pw.live' });
  eq('assign sets status ASSIGNED', assigned.status, 'ASSIGNED');
  eq('assign sets analyst', assigned.analystEmail, 'analyst@pw.live');
  throws('cannot assign to a non-analyst', () =>
    ctx.Tickets.assign(cba, { ticketId, analystEmail: 'riya@pw.live' }), 'Associate Analyst');

  // status flow
  const inProg = ctx.Tickets.updateStatus(analyst, { ticketId, status: 'IN_PROGRESS' });
  eq('analyst starts work', inProg.status, 'IN_PROGRESS');
  throws('illegal transition blocked', () =>
    ctx.Tickets.updateStatus(analyst, { ticketId, status: 'CLOSED' }), 'Cannot move');

  // comment
  ctx.Tickets.addComment(analyst, { ticketId, text: 'Working on it.' });
  const detail = ctx.Tickets.get(riya2, { ticketId });
  eq('comment appears in detail', detail.comments.length, 1);
  ok('activity log recorded', detail.logs.length >= 3);

  /* ==================== CBA: create + self-assign ================= */
  section('CBA: create, self-assign, share');
  const cbaTicket = ctx.Tickets.create(cba, {
    title: 'CBA raised request', description: 'Raised by the CBA themselves.',
    category: 'New analysis', priority: 'Medium',
  });
  ok('CBA can create a ticket', /^TKT-\d{4}-\d{5}$/.test(cbaTicket.ticketId));
  eq('CBA ticket requester is the CBA', cbaTicket.raisedByEmail, 'cba@pw.live');
  eq('CBA ticket starts NEW', cbaTicket.status, 'NEW');

  const selfAssigned = ctx.Tickets.assign(cba, { ticketId: cbaTicket.ticketId, analystEmail: 'cba@pw.live' });
  eq('CBA self-assign sets analyst to self', selfAssigned.analystEmail, 'cba@pw.live');
  eq('CBA self-assign -> ASSIGNED', selfAssigned.status, 'ASSIGNED');

  const cbaStart = ctx.Tickets.updateStatus(cba, { ticketId: cbaTicket.ticketId, status: 'IN_PROGRESS' });
  eq('CBA can work on a self-assigned ticket', cbaStart.status, 'IN_PROGRESS');

  const cbaList = ctx.Tickets.myAnalysts(cba);
  ok('CBA myAnalysts offers "me"', cbaList.some((a) => a.email === 'cba@pw.live' && a.self === true));

  const shared = ctx.Tickets.assign(cba, { ticketId: cbaTicket.ticketId, analystEmail: 'analyst@pw.live' });
  eq('CBA can hand it to an analyst', shared.analystEmail, 'analyst@pw.live');

  const createdAssigned = ctx.Tickets.create(cba, {
    title: 'CBA creates and assigns', description: 'Assign on create.',
    priority: 'Low', assignTo: 'analyst@pw.live',
  });
  eq('assignTo on create sets analyst', createdAssigned.analystEmail, 'analyst@pw.live');
  eq('assignTo on create -> ASSIGNED', createdAssigned.status, 'ASSIGNED');
  throws('CBA cannot assign to a non-analyst', () =>
    ctx.Tickets.assign(cba, { ticketId: cbaTicket.ticketId, analystEmail: 'riya@pw.live' }), 'Associate Analyst');

  /* ============ any requester: self-assign + mark done =========== */
  section('Requester self-assign + close (any role)');
  // A USER raises a ticket, takes it, and closes it without an analyst.
  const userTicket = ctx.Tickets.create(riya2, {
    title: 'User takes own ticket', description: 'I will handle this myself.', priority: 'Low',
  });
  ok('USER myAnalysts offers "me"',
    ctx.Tickets.myAnalysts(riya2).some((a) => a.email === 'riya@pw.live' && a.self === true));
  const userTake = ctx.Tickets.assign(riya2, { ticketId: userTicket.ticketId, analystEmail: 'riya@pw.live' });
  eq('USER can self-assign', userTake.analystEmail, 'riya@pw.live');
  eq('USER self-assign -> ASSIGNED', userTake.status, 'ASSIGNED');
  const userDone = ctx.Tickets.close(riya2, { ticketId: userTicket.ticketId });
  eq('USER can mark done from ASSIGNED (no RESOLVED needed)', userDone.status, 'CLOSED');
  throws('cannot close an already-closed ticket', () =>
    ctx.Tickets.close(riya2, { ticketId: userTicket.ticketId }), 'already closed');

  // An ANALYST can open + take a ticket they raised, before any assignment.
  const anTicket = ctx.Tickets.create(analyst, {
    title: 'Analyst raised request', description: 'Raised by an analyst.', priority: 'Low',
  });
  const anSeen = ctx.Tickets.get(analyst, { ticketId: anTicket.ticketId });
  eq('ANALYST can open a ticket they raised', anSeen.ticketId, anTicket.ticketId);
  const anTake = ctx.Tickets.assign(analyst, { ticketId: anTicket.ticketId, analystEmail: 'analyst@pw.live' });
  eq('ANALYST can self-assign', anTake.analystEmail, 'analyst@pw.live');
  const anDone = ctx.Tickets.close(analyst, { ticketId: anTicket.ticketId });
  eq('ANALYST can mark as done', anDone.status, 'CLOSED');

  /* ========================== approvals ========================== */
  section('External approvals');
  const req = ctx.Approvals.request(cba, { ticketId, approverEmail: 'boss@pw.live', note: 'Please approve' });
  ok('approval id returned', /^APR-/.test(req.approvalId));
  const afterReq = ctx.Tickets.get(cba, { ticketId });
  eq('ticket moved to PENDING_APPROVAL', afterReq.status, 'PENDING_APPROVAL');
  eq('approval status PENDING', afterReq.approvalStatus, 'PENDING');

  // recover the raw token from the approval email link
  const apMail = ctx.__test.sentMails.filter((m) => m.to === 'boss@pw.live').pop();
  const tokenMatch = apMail.htmlBody.match(/#approve\/[^\/]+\/([a-f0-9]+)/);
  const rawToken = tokenMatch ? tokenMatch[1] : null;
  ok('approval email carries a token', !!rawToken);

  const info = ctx.Approvals.getInfo(rawToken, req.approvalId);
  ok('getInfo allows decision', info.canDecide === true);
  eq('getInfo shows the ticket', info.ticket.ticketId, ticketId);

  throws('invalid token rejected', () => ctx.Approvals.getInfo('bad', req.approvalId), 'invalid');

  const decided = ctx.Approvals.decide(rawToken, req.approvalId, 'APPROVED', 'Looks good');
  eq('decision recorded', decided.status, 'APPROVED');
  const afterDecide = ctx.Tickets.get(cba, { ticketId });
  eq('approved ticket resumes IN_PROGRESS', afterDecide.status, 'IN_PROGRESS');
  throws('approval is single-use', () => ctx.Approvals.decide(rawToken, req.approvalId, 'APPROVED', ''), 'already');

  /* ========================== reassign =========================== */
  section('Reassignment');
  ctx.Admin.saveUser(admin, { user: { name: 'Ana Two', email: 'analyst2@pw.live', role: 'ANALYST', clusterId } });
  const rr = ctx.Reassign.request(analyst, { ticketId, toAnalystEmail: 'analyst2@pw.live', reason: 'Better fit' });
  eq('reassign request pending', rr.Status, 'PENDING');
  throws('cannot reassign to self', () =>
    ctx.Reassign.request(analyst, { ticketId, toAnalystEmail: 'analyst@pw.live', reason: 'x' }), 'yourself');

  const list = ctx.Reassign.list(cba);
  eq('CBA sees the request', list.length, 1);
  const dec = ctx.Reassign.decide(cba, { reqId: rr.ReqID, approve: true, note: 'ok' });
  eq('reassign approved', dec.status, 'APPROVED');
  const afterReassign = ctx.Tickets.get(cba, { ticketId });
  eq('analyst changed', afterReassign.analystEmail, 'analyst2@pw.live');
  eq('status back to ASSIGNED', afterReassign.status, 'ASSIGNED');

  /* ====================== resolve / close / rate ================= */
  section('Resolve, close, rate');
  const analyst2 = rawUser('analyst2@pw.live'); analyst2.Role = 'ANALYST';
  ctx.Tickets.updateStatus(analyst2, { ticketId, status: 'IN_PROGRESS' });
  const resolved = ctx.Tickets.updateStatus(analyst2, { ticketId, status: 'RESOLVED' });
  eq('resolved', resolved.status, 'RESOLVED');
  throws('non-owner cannot close', () =>
    ctx.Tickets.close(analyst2, { ticketId }), 'requester');

  const closed = ctx.Tickets.close(riya2, { ticketId });
  eq('owner closes', closed.status, 'CLOSED');
  const rated = ctx.Tickets.rate(riya2, { ticketId, rating: 5, feedback: 'Great' });
  eq('rating stored', rated.rating, 5);
  throws('cannot rate twice', () => ctx.Tickets.rate(riya2, { ticketId, rating: 4 }), 'already');

  /* ====================== admin: role change ===================== */
  section('Admin: role change kills sessions');
  const before = ctx.Db.find(ctx.SHEETS.SESSIONS, (s) => ctx.normEmail(s.Email) === 'riya@pw.live').length;
  ok('riya has a session', before >= 1);
  ctx.Admin.saveUser(admin, { user: { name: 'Riya Sharma', email: 'riya@pw.live', role: 'ANALYST', clusterId } });
  const after = ctx.Db.find(ctx.SHEETS.SESSIONS, (s) => ctx.normEmail(s.Email) === 'riya@pw.live').length;
  eq('sessions killed on role change', after, 0);

  /* ========================== analytics ========================== */
  section('Analytics & export');
  const an = ctx.Admin.analytics(admin, { days: 30 });
  ok('analytics totals present', typeof an.totals.total === 'number');
  ok('analytics has trend', !!an.trend);
  ok('analytics has mostActive', Array.isArray(an.mostActive));
  const csv = ctx.Admin.exportCsv(admin, { type: 'tickets' });
  ok('CSV export has header + rows', csv.csv.split('\n').length >= 2);
  ok('CSV filename', csv.filename === 'tickets.csv');

  /* ===================== my activity (any role) ===================== */
  section('My activity');
  const mine = ctx.Admin.myActivity(admin, { days: 365 });
  ok('myActivity returns the caller email', mine.email === 'ambikesh.srivastava@pw.live');
  ok('myActivity has a today key', /^\d{4}-\d{2}-\d{2}$/.test(mine.today));
  ok('myActivity buckets by day', typeof mine.days === 'object' && mine.days[mine.today] >= 1);
  ok('myActivity counts events', mine.total >= 1 && Object.keys(mine.byEvent).length >= 1);
  ok('myActivity has streaks', typeof mine.streak.current === 'number' && typeof mine.streak.longest === 'number');
  ok('myActivity lists recent events', Array.isArray(mine.recent) && mine.recent.length >= 1);
  // A different user must not see the admin's rows.
  const other = ctx.Admin.myActivity({ Email: 'nobody@pw.live', Name: 'Nobody', Role: 'USER' }, { days: 365 });
  eq('myActivity is scoped to the caller', other.total, 0);

  /* ===================== shared raw cache ===================== */
  section('Shared raw cache');
  // Simulate a fresh execution: drop per-execution state, keep the shared cache.
  const newExec = () => { ctx.Db._cache = {}; ctx.Db._vers = {}; };

  // A warm read is served from the shared cache without touching the sheet.
  ctx.Db._bump(ctx.SHEETS.CLUSTERS);          // force the next read to miss
  newExec();
  let sheetReads = 0;
  const origRead = ctx.Db._readSheet;
  ctx.Db._readSheet = function (n) { sheetReads++; return origRead.call(this, n); };
  ctx.Db.all(ctx.SHEETS.CLUSTERS);            // miss -> reads the sheet, caches it
  newExec();
  ctx.Db.all(ctx.SHEETS.CLUSTERS);            // hit -> no sheet read
  ctx.Db._readSheet = origRead;
  eq('warm read skips the sheet', sheetReads, 1);

  // A write invalidates the shared cache for the next execution.
  newExec();
  const beforeCount = ctx.Db.all(ctx.SHEETS.USERS).length;
  ctx.Db.insert(ctx.SHEETS.USERS, {
    UserID: 'U-CACHE', Name: 'Cache Probe', Email: 'cache-probe@pw.live',
    Role: 'USER', Status: 'ACTIVE',
  });
  newExec();
  eq('write is visible to a new execution', ctx.Db.all(ctx.SHEETS.USERS).length, beforeCount + 1);
  ctx.Db.deleteWhere(ctx.SHEETS.USERS, (u) => u.Email === 'cache-probe@pw.live');
  newExec();
  eq('delete is visible to a new execution', ctx.Db.all(ctx.SHEETS.USERS).length, beforeCount);

  /* ============================ router =========================== */
  section('api() router');
  const pub = ctx.api('getClusters', null, {});
  ok('public getClusters works without token', pub.ok === true && Array.isArray(pub.data));

  const bad = ctx.api('dashboard', 'nope', {});
  eq('private route rejects bad token', bad.ok, false);

  // fresh login for riya (now ANALYST)
  ctx.Auth.requestOtp({ email: 'riya@pw.live' });
  const otp2 = lastOtp('riya@pw.live');
  const login2 = ctx.Auth.verifyOtp({ email: 'riya@pw.live', code: otp2 });
  const dash = ctx.api('dashboard', login2.token, {});
  ok('private dashboard works with token', dash.ok === true && typeof dash.data.total === 'number');

  const denied = ctx.api('adminUsers', login2.token, {});
  eq('role denial for non-admin', denied.ok, false);
  ok('denial message mentions role', /role/i.test(denied.error));

  const adminLogin = ctx.api('adminUsers', null, {});
  eq('admin route needs a token', adminLogin.ok, false);
};
