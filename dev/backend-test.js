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

const call = (name, token, payload) => ctx.handle({ api: name, token: token || '', payload: payload || {} });
const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const get = (params) => ctx.doGet({ parameter: params });

console.log(C.b + '\nPW Ticket Portal — backend JSON API test suite' + C.x);

/* ------------------------------- setup ------------------------------- */
t.section('setup + seed');
ctx.setup();
t.ok('setup() runs without throwing', true);
t.ok('admin seeded', ctx.Db.all(ctx.SHEETS.USERS).length >= 1, 'got ' + ctx.Db.all(ctx.SHEETS.USERS).length);

/* ------------------------------ envelope ----------------------------- */
t.section('response envelope');
const unknown = call('nope', '', {});
t.eq('unknown api -> ok:false', unknown.ok, false);
t.ok('unknown api -> error string', typeof unknown.error === 'string' && unknown.error.length > 0);

const emptyClusters = call('getClusters', '', {});
t.eq('public getClusters -> ok:true', emptyClusters.ok, true);
t.ok('getClusters returns an array', Array.isArray(emptyClusters.data));

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

/* ------------------------------- report ------------------------------ */
console.log('\n' + C.b + '────────────────────────────' + C.x);
console.log(C.b + 'Passed: ' + C.g + pass + C.x + C.b + '   Failed: ' + (fail ? C.r : C.g) + fail + C.x);
if (fail) {
  console.log(C.r + '\nFailures:' + C.x);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(C.g + '\nAll good ✓' + C.x);
