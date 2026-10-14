/**
 * dev/backend-test.js
 * Loads the backend/ JSON API into a mocked Apps Script context and exercises
 * the router end-to-end (handle / doPost / doGet), including the guarantees the
 * static front-end depends on:
 *   - every response is { ok, data|error }
 *   - internal _row keys never leak
 *   - the OTP is never returned to the client
 *   - role checks are enforced
 *
 *   node dev/backend-test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildGlobals } = require('./mock');

const ROOT = path.join(__dirname, '..', 'backend');
const FILES = [
  'Config.gs', 'Db.gs', 'Setup.gs', 'Mail.gs', 'Auth.gs',
  'Tickets.gs', 'Approvals.gs', 'Reassign.gs', 'Admin.gs', 'Triggers.gs', 'Api.gs',
];

let pass = 0, fail = 0;
const failures = [];
const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const t = {
  section(name) { console.log('\n' + C.b + '▸ ' + name + C.x); },
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ' + C.g + '✓' + C.x + ' ' + name); }
    else { fail++; failures.push(name); console.log('  ' + C.r + '✗ ' + name + C.x + (extra ? C.d + ' — ' + extra + C.x : '')); }
  },
  eq(name, a, b) { t.ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); },
};

const globals = buildGlobals();
const ctx = vm.createContext(globals);
for (const f of FILES) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try { vm.runInContext(code, ctx, { filename: f }); }
  catch (e) { console.error(C.r + 'Failed to load ' + f + ': ' + e.message + C.x); process.exit(1); }
}

// Tests assert on the mock outbox, so send mail inline instead of queueing it.
ctx.MAIL_QUEUE_ENABLED = false;

const call = (name, token, payload) => ctx.handle({ api: name, token: token || '', payload: payload || {} });
const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const get = (params) => ctx.doGet({ parameter: params });

console.log(C.b + '\nPW Ticket Portal — backend JSON API test suite' + C.x);

/* ------------------------------- setup ------------------------------- */
t.section('setup + seed');
ctx.setup();
t.ok('setup() runs without throwing', true);
t.ok('admin seeded', ctx.Db.all(ctx.SHEETS.USERS).length >= 1, 'got ' + ctx.Db.all(ctx.SHEETS.USERS).length);
t.ok('Admin cluster seeded', ctx.Db.all(ctx.SHEETS.CLUSTERS).some((c) => String(c.ClusterID) === 'CL-ADMIN'));
t.ok('admin lives in the Admin cluster', ctx.Db.all(ctx.SHEETS.USERS).some((u) => String(u.Role) === 'ADMIN' && String(u.ClusterID) === 'CL-ADMIN'));

/* ------------------------------ envelope ----------------------------- */
t.section('response envelope');
const unknown = call('nope', '', {});
t.eq('unknown api -> ok:false', unknown.ok, false);
t.ok('unknown api -> error string', typeof unknown.error === 'string' && unknown.error.length > 0);

const emptyClusters = call('getClusters', '', {});
t.eq('public getClusters -> ok:true', emptyClusters.ok, true);
t.ok('getClusters returns an array', Array.isArray(emptyClusters.data));

/* --------------------------- setup version guard --------------------- */
t.section('setup version guard');
const props = ctx.PropertiesService.getScriptProperties();
t.eq('SETUP_DONE recorded after first call', props.getProperty('SETUP_DONE'), '1');
t.eq('SETUP_VERSION recorded', props.getProperty('SETUP_VERSION'), String(ctx.SETUP_VERSION));
props.deleteProperty('SETUP_VERSION');
call('getClusters', '', {});
t.eq('stale version re-runs setup()', props.getProperty('SETUP_VERSION'), String(ctx.SETUP_VERSION));

/* ------------------------------- auth -------------------------------- */
t.section('auth flow (no OTP leak)');
const req = call('requestOtp', '', { email: 'ambikesh.srivastava@pw.live' });
t.eq('requestOtp -> ok:true', req.ok, true);
t.ok('requestOtp does NOT return the code', req.data && req.data.code === undefined && req.data.otp === undefined);
t.ok('requestOtp reports sent', req.data && req.data.sent === true);

// Read the OTP straight from the mock mail outbox (server-side only).
const lastOtp = () => {
  const mails = globals.__test.sentMails;
  const m = String((mails[mails.length - 1] || {}).htmlBody || '').match(/>(\d{6})</);
  return m ? m[1] : null;
};
const code = lastOtp();
t.ok('OTP email was sent', !!code, 'no 6-digit code found in mail');

const bad = call('verifyOtp', '', { email: 'ambikesh.srivastava@pw.live', code: '000000' });
t.eq('wrong OTP -> ok:false', bad.ok, false);

const good = call('verifyOtp', '', { email: 'ambikesh.srivastava@pw.live', code: code });
t.eq('correct OTP -> ok:true', good.ok, true);
t.ok('verifyOtp returns a token', !!(good.data && good.data.token));
t.ok('verifyOtp returns the user', !!(good.data && good.data.user && good.data.user.email));
const adminToken = good.data.token;

/* --------------------------- admin provisioning ---------------------- */
t.section('admin provisioning');
const mkCluster = call('adminSaveCluster', adminToken, { cluster: { name: 'Sales Analytics', cbaEmail: 'cba@pw.live' } });
t.eq('adminSaveCluster -> ok:true', mkCluster.ok, true);
const clusterId = mkCluster.data && mkCluster.data.clusterId;
t.ok('cluster id assigned', /^CL-/.test(String(clusterId)), String(clusterId));

const mkUser = call('adminSaveUser', adminToken, { user: { email: 'riya@pw.live', name: 'Riya', role: 'USER', clusterId: clusterId } });
t.eq('adminSaveUser (USER) -> ok:true', mkUser.ok, true);
const mkAnalyst = call('adminSaveUser', adminToken, { user: { email: 'analyst@pw.live', name: 'Analyst One', role: 'ANALYST', clusterId: clusterId } });
t.eq('adminSaveUser (ANALYST) -> ok:true', mkAnalyst.ok, true);

const clusters = call('getClusters', '', {});
t.ok('getClusters now returns the cluster', Array.isArray(clusters.data) && clusters.data.length >= 1);

/* --------------------------- _row never leaks ------------------------ */
t.section('internal keys are stripped');
const rawUsers = ctx.Db.all(ctx.SHEETS.USERS);
t.ok('Db.all() rows carry _row internally', rawUsers.length > 0 && '_row' in rawUsers[0]);
const adminUsers = call('adminUsers', adminToken, {});
t.ok('adminUsers -> ok:true', adminUsers.ok, true);
t.ok('serialized payload has no _row', JSON.stringify(adminUsers.data).indexOf('"_row"') === -1);

/* --------------------------- role enforcement ------------------------ */
t.section('role enforcement');
const noToken = call('adminUsers', '', {});
t.eq('private api without token -> ok:false', noToken.ok, false);

const me = call('me', adminToken, {});
t.eq('me with token -> ok:true', me.ok, true);
t.eq('me returns ADMIN role', me.data.role, 'ADMIN');

// A USER must not reach an ADMIN-only endpoint.
const userToken = (function () {
  call('requestOtp', '', { email: 'riya@pw.live' });
  return call('verifyOtp', '', { email: 'riya@pw.live', code: lastOtp() }).data.token;
})();
const forbidden = call('adminUsers', userToken, {});
t.eq('USER hitting adminUsers -> ok:false', forbidden.ok, false);
t.ok('forbidden error mentions role', /role/i.test(forbidden.error || ''));

/* ------------------------------ tickets ------------------------------ */
t.section('tickets');
const created = call('createTicket', userToken, {
  title: 'API smoke test ticket', description: 'created via JSON API', priority: 'High', clusterId: 'CL-00001',
});
t.eq('createTicket -> ok:true', created.ok, true);
const ticketId = created.data && created.data.ticketId;
t.ok('createTicket returns an id', !!ticketId, JSON.stringify(created.data));

const list = call('listTickets', userToken, {});
t.eq('listTickets -> ok:true', list.ok, true);
t.ok('listTickets returns rows', !!(list.data && Array.isArray(list.data.rows)));
t.ok('listTickets includes the new ticket', JSON.stringify(list.data.rows).indexOf(ticketId) !== -1);

const dash = call('dashboard', adminToken, {});
t.eq('dashboard -> ok:true', dash.ok, true);
t.ok('dashboard has totals', !!(dash.data && typeof dash.data.total === 'number'));
t.ok('dashboard counts the new ticket', dash.data.total >= 1);

/* --------------------------- email links ----------------------------- */
t.section('email links point at the portal');
t.ok('portalUrl falls back to the front-end (not the API)', ctx.portalUrl().indexOf('github.io') !== -1, ctx.portalUrl());
t.ok('ticketUrl deep-links to the ticket', /#ticket\/TKT-/.test(ctx.ticketUrl('TKT-2026-00001')), ctx.ticketUrl('TKT-2026-00001'));
const sentMails = globals.__test.sentMails;
const receivedMail = sentMails.filter((m) => /^\[Received\]/.test(m.subject || ''));
t.ok('ticket-received mail was sent', receivedMail.length >= 1);
t.ok('ticket-received mail links to the ticket', receivedMail.some((m) => /#ticket\//.test(m.htmlBody || '')));
t.ok('no mail links to the raw API endpoint', !sentMails.some((m) => /script\.google\.com\/macros/.test(m.htmlBody || '')));

/* --------------------------- CBA create + self-assign ---------------- */
t.section('CBA create + self-assign');
const mkCba = call('adminSaveUser', adminToken, { user: { email: 'cba@pw.live', name: 'Priya CBA', role: 'CBA', clusterId: clusterId } });
t.eq('adminSaveUser (CBA) -> ok:true', mkCba.ok, true);
const cbaToken = (function () {
  call('requestOtp', '', { email: 'cba@pw.live' });
  return call('verifyOtp', '', { email: 'cba@pw.live', code: lastOtp() }).data.token;
})();

const cbaCreated = call('createTicket', cbaToken, {
  title: 'CBA raised via API', description: 'raised by the CBA', priority: 'Medium',
});
t.eq('CBA createTicket -> ok:true', cbaCreated.ok, true);
const cbaTicketId = cbaCreated.data && cbaCreated.data.ticketId;
t.ok('CBA ticket has an id', !!cbaTicketId, JSON.stringify(cbaCreated.data));

const cbaAnalysts = call('myAnalysts', cbaToken, {});
t.ok('CBA myAnalysts includes self', Array.isArray(cbaAnalysts.data) && cbaAnalysts.data.some((a) => a.self === true));

const selfAssign = call('assignTicket', cbaToken, { ticketId: cbaTicketId, analystEmail: 'cba@pw.live' });
t.eq('CBA self-assign -> ok:true', selfAssign.ok, true);
t.eq('CBA self-assign sets analyst', selfAssign.data && selfAssign.data.analystEmail, 'cba@pw.live');
t.eq('CBA self-assign -> ASSIGNED', selfAssign.data && selfAssign.data.status, 'ASSIGNED');

const cbaStart = call('updateStatus', cbaToken, { ticketId: cbaTicketId, status: 'IN_PROGRESS' });
t.eq('CBA can start a self-assigned ticket', cbaStart.data && cbaStart.data.status, 'IN_PROGRESS');

const cbaShare = call('assignTicket', cbaToken, { ticketId: cbaTicketId, analystEmail: 'analyst@pw.live' });
t.eq('CBA can hand it to an analyst', cbaShare.data && cbaShare.data.analystEmail, 'analyst@pw.live');

const cbaAssignOnCreate = call('createTicket', cbaToken, {
  title: 'CBA assign-on-create', description: 'x', priority: 'Low', assignTo: 'analyst@pw.live',
});
t.eq('CBA assignTo on create -> ASSIGNED', cbaAssignOnCreate.data && cbaAssignOnCreate.data.status, 'ASSIGNED');
t.eq('CBA assignTo on create sets analyst', cbaAssignOnCreate.data && cbaAssignOnCreate.data.analystEmail, 'analyst@pw.live');

/* -------------------- USER self-assign + mark done ------------------- */
t.section('USER self-assign + close');
const userAnalysts = call('myAnalysts', userToken, {});
t.ok('USER myAnalysts includes self', Array.isArray(userAnalysts.data) && userAnalysts.data.some((a) => a.self === true && a.email === 'riya@pw.live'));
const userSelfAssign = call('assignTicket', userToken, { ticketId, analystEmail: 'riya@pw.live' });
t.eq('USER self-assign -> ok:true', userSelfAssign.ok, true);
t.eq('USER self-assign sets analyst', userSelfAssign.data && userSelfAssign.data.analystEmail, 'riya@pw.live');
t.eq('USER self-assign -> ASSIGNED', userSelfAssign.data && userSelfAssign.data.status, 'ASSIGNED');
const userClose = call('closeTicket', userToken, { ticketId });
t.eq('USER marks done -> CLOSED', userClose.data && userClose.data.status, 'CLOSED');
const userCloseAgain = call('closeTicket', userToken, { ticketId });
t.eq('cannot close twice -> ok:false', userCloseAgain.ok, false);

/* --------------------------- CBA analyst management ------------------ */
t.section('CBA analyst management');
const roster = call('clusterAnalysts', cbaToken, {});
t.eq('clusterAnalysts -> ok:true', roster.ok, true);
t.ok('CBA sees own-cluster analysts', Array.isArray(roster.data) && roster.data.every((a) => a.clusterId === clusterId));

const addAn = call('saveAnalyst', cbaToken, { analyst: { email: 'newanalyst@pw.live', name: 'New Analyst' } });
t.eq('CBA saveAnalyst (create) -> ok:true', addAn.ok, true);
t.eq('CBA saveAnalyst reports created', addAn.data && addAn.data.created, true);
t.ok('new analyst joins the CBA cluster', call('clusterAnalysts', cbaToken, {}).data.some((a) => a.email === 'newanalyst@pw.live' && a.clusterId === clusterId));

const rmAn = call('removeAnalyst', cbaToken, { email: 'newanalyst@pw.live' });
t.eq('CBA removeAnalyst -> ok:true', rmAn.ok, true);
t.ok('removed analyst goes INACTIVE', call('clusterAnalysts', cbaToken, {}).data.some((a) => a.email === 'newanalyst@pw.live' && a.status === 'INACTIVE'));

// a second cluster, so we can prove CBA cannot reach across clusters
const mkCluster2 = call('adminSaveCluster', adminToken, { cluster: { name: 'Marketing Analytics', cbaEmail: 'cba2@pw.live' } });
const cluster2 = mkCluster2.data && mkCluster2.data.clusterId;
call('adminSaveUser', adminToken, { user: { email: 'sneha@pw.live', name: 'Sneha', role: 'ANALYST', clusterId: cluster2 } });
const crossSave = call('saveAnalyst', cbaToken, { analyst: { email: 'sneha@pw.live', name: 'x' } });
t.eq('CBA cannot edit another cluster analyst -> ok:false', crossSave.ok, false);
const crossRemove = call('removeAnalyst', cbaToken, { email: 'sneha@pw.live' });
t.eq('CBA cannot remove another cluster analyst -> ok:false', crossRemove.ok, false);

/* --------------------------- admin cross-cluster assign -------------- */
t.section('admin cross-cluster assign');
const adminAnalysts = call('myAnalysts', adminToken, {});
t.ok('admin myAnalysts spans clusters', Array.isArray(adminAnalysts.data)
  && adminAnalysts.data.some((a) => a.clusterId === clusterId)
  && adminAnalysts.data.some((a) => a.clusterId === cluster2));
const adminTicket = call('createTicket', adminToken, { title: 'Admin dispatch', description: 'x', priority: 'Medium' });
const adminAssign = call('assignTicket', adminToken, { ticketId: adminTicket.data.ticketId, analystEmail: 'sneha@pw.live' });
t.eq('admin can assign across clusters -> ok:true', adminAssign.ok, true);
t.eq('admin cross-cluster assign sets analyst', adminAssign.data && adminAssign.data.analystEmail, 'sneha@pw.live');
t.eq('admin cross-cluster assign -> ASSIGNED', adminAssign.data && adminAssign.data.status, 'ASSIGNED');

/* --------------------------- transport layer ------------------------- */
t.section('transport (doPost / doGet)');
const viaPost = post({ api: 'getClusters', token: '', payload: {} });
t.eq('doPost -> ok:true', viaPost.ok, true);

const viaGet = get({ api: 'getClusters' });
t.eq('doGet (json) -> ok:true', JSON.parse(viaGet.getContent()).ok, true);

const viaJsonp = get({ api: 'getClusters', callback: 'pwcb_1' });
t.eq('doGet (jsonp) mime', viaJsonp.getMimeType(), 'application/javascript');
t.ok('doGet (jsonp) wraps in callback', /^pwcb_1\(/.test(viaJsonp.getContent()));

const badCb = get({ api: 'getClusters', callback: 'alert(1)' });
t.ok('doGet rejects unsafe callback name', !/alert/.test(badCb.getContent()));

const malformed = JSON.parse(ctx.doPost({ postData: { contents: '{not json' } }).getContent());
t.eq('doPost malformed body -> ok:false', malformed.ok, false);

const infoPage = get({});
t.ok('doGet without api returns a page', /API endpoint/.test(infoPage.getContent()));

/* ----------------------------- mail queue ---------------------------- */
t.section('mail queue');
ctx.MAIL_QUEUE_ENABLED = true;
ctx.sendMail({ to: 'queue@pw.live', subject: 'Queued hello', htmlBody: '<p>hi</p>' });
const queued = ctx.Db.find(ctx.SHEETS.MAILQUEUE, (r) => String(r.Status) === 'PENDING');
t.ok('sendMail enqueues when the queue is on', queued.length >= 1);
const outboxBefore = globals.__test.sentMails.length;
const drained = ctx.drainMailQueue(50);
t.ok('drainMailQueue sends pending mail', drained >= 1);
t.ok('queued mail reached the outbox', globals.__test.sentMails.length > outboxBefore);
const stillPending = ctx.Db.find(ctx.SHEETS.MAILQUEUE, (r) => String(r.Status) === 'PENDING');
t.eq('queue is empty after drain', stillPending.length, 0);
ctx.MAIL_QUEUE_ENABLED = false;

/* ------------------------------- report ------------------------------ */
console.log('\n' + C.b + '────────────────────────────' + C.x);
console.log(C.b + 'Passed: ' + C.g + pass + C.x + C.b + '   Failed: ' + (fail ? C.r : C.g) + fail + C.x);
if (fail) {
  console.log(C.r + '\nFailures:' + C.x);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(C.g + '\nAll good ✓' + C.x);
