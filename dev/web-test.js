/* ============================================================
   dev/web-test.js — offline test for the local (browser) backend.
   Loads js/store.js + js/api.local.js in a vm sandbox with a
   localStorage shim, then exercises the real flows.
   (The live portal uses js/api.js, the network client, instead.)
   Run:  node dev/web-test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n▸ ' + t); }

/* ------------------------- sandbox ------------------------- */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

const sandbox = {};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.localStorage = makeStorage();
sandbox.crypto = require('crypto').webcrypto;
sandbox.console = console;
sandbox.Date = Date;
sandbox.Math = Math;
sandbox.JSON = JSON;
sandbox.Number = Number;
sandbox.String = String;
sandbox.Array = Array;
sandbox.Object = Object;
sandbox.isNaN = isNaN;
sandbox.setTimeout = setTimeout;
sandbox.parseInt = parseInt;
vm.createContext(sandbox);

for (const f of ['js/store.js', 'js/api.local.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const Store = sandbox.Store;
const API = sandbox.API;

function call(name, token, payload) { return API.call(name, token, payload || {}); }
function must(name, token, payload) {
  const r = call(name, token, payload);
  if (!r.ok) throw new Error(name + ' failed: ' + r.error);
  return r.data;
}
function login(email) {
  const o = must('requestOtp', null, { email });
  if (!o.demoOtp || !/^\d{6}$/.test(o.demoOtp)) throw new Error('no demoOtp for ' + email);
  return must('verifyOtp', null, { email, code: o.demoOtp });
}

/* ============================ tests ============================ */
section('seed data');
eq(Store.all('users').length, 8, 'seeded 8 users');
eq(Store.all('clusters').length, 3, 'seeded 3 clusters');
eq(Store.all('tickets').length, 4, 'seeded 4 tickets');
eq(typeof Store.cfg('ADMIN_EMAIL'), 'string', 'config ADMIN_EMAIL set');
ok(Store.cfg('ALLOWED_DOMAIN') === '', 'ALLOWED_DOMAIN empty (demo allows any email)');

section('public: getClusters');
const clusters = must('getClusters', null, {});
eq(clusters.length, 3, 'getClusters returns 3');

section('auth: OTP flow');
const otp = must('requestOtp', null, { email: 'riya@pw.live' });
ok(/^\d{6}$/.test(otp.demoOtp), 'requestOtp returns 6-digit demoOtp');
const bad = call('verifyOtp', null, { email: 'riya@pw.live', code: '000000' });
ok(!bad.ok, 'wrong OTP rejected');
const riya = must('verifyOtp', null, { email: 'riya@pw.live', code: otp.demoOtp });
ok(riya.token && riya.token.length > 10, 'verifyOtp returns a session token');
eq(riya.user.role, 'USER', 'riya is USER');
const unknown = must('requestOtp', null, { email: 'nobody@pw.live' });
ok(!unknown.demoOtp, 'unknown email does not leak an OTP');
const meR = must('me', riya.token, {});
eq(meR.email, 'riya@pw.live', 'me returns the session user');

section('role enforcement');
const denied = call('adminUsers', riya.token, {});
ok(!denied.ok && /role/i.test(denied.error), 'USER cannot call adminUsers');
const noAuth = call('listTickets', 'bogus-token', {});
ok(!noAuth.ok && noAuth.error === 'SESSION_EXPIRED', 'bad token -> SESSION_EXPIRED');

section('tickets: create / duplicate / list');
const t1 = must('createTicket', riya.token, { title: 'Need weekly sales report', description: 'x', priority: 'High' });
eq(t1.status, 'NEW', 'new ticket is NEW');
ok(/^TKT-\d{4}-\d{5}$/.test(t1.ticketId), 'ticketId format TKT-YYYY-00000');
const dup = must('createTicket', riya.token, { title: 'Need weekly sales report', description: 'x' });
ok(dup.duplicate === true, 'duplicate title flagged');
const forced = must('createTicket', riya.token, { title: 'Need weekly sales report', description: 'x', force: true });
ok(!forced.duplicate, 'force creates despite duplicate');
const mine = must('listTickets', riya.token, {});
ok(mine.total >= 2, 'listTickets sees own tickets');
ok(mine.rows.every((t) => t.raisedByEmail === 'riya@pw.live'), 'USER sees only own tickets');

section('tickets: detail + comment');
const det = must('getTicket', riya.token, { ticketId: t1.ticketId });
ok(Array.isArray(det.logs) && det.logs.length >= 1, 'ticket has activity logs');
must('addComment', riya.token, { ticketId: t1.ticketId, text: 'Any update?' });
const det2 = must('getTicket', riya.token, { ticketId: t1.ticketId });
eq(det2.comments.length, 1, 'comment recorded');

section('CBA: assign analyst');
const cba = login('cba@pw.live');
eq(cba.user.role, 'CBA', 'cba@pw.live is CBA');
const analysts = must('myAnalysts', cba.token, {});
ok(analysts.length >= 2 && analysts.every((a) => a.clusterId === 'CL-00001'), 'CBA sees CL-00001 analysts');
const assigned = must('assignTicket', cba.token, { ticketId: t1.ticketId, analystEmail: 'analyst@pw.live' });
eq(assigned.status, 'ASSIGNED', 'assign -> ASSIGNED');
eq(assigned.analystEmail, 'analyst@pw.live', 'analyst set');
const crossAssign = call('assignTicket', cba.token, { ticketId: t1.ticketId, analystEmail: 'sneha@pw.live' });
ok(!crossAssign.ok, 'cannot assign analyst from another cluster');

section('CBA: create + self-assign + share');
const cbaTicket = must('createTicket', cba.token, { title: 'CBA self task', description: 'raised by the CBA', priority: 'Medium' });
ok(/^TKT-/.test(cbaTicket.ticketId), 'CBA can create a ticket');
eq(cbaTicket.raisedByEmail, 'cba@pw.live', 'CBA is the requester');
const cbaAnalysts = must('myAnalysts', cba.token, {});
ok(cbaAnalysts.some((a) => a.self === true && a.email === 'cba@pw.live'), 'CBA myAnalysts offers "me"');
const selfA = must('assignTicket', cba.token, { ticketId: cbaTicket.ticketId, analystEmail: 'cba@pw.live' });
eq(selfA.analystEmail, 'cba@pw.live', 'CBA self-assign sets analyst to self');
eq(selfA.status, 'ASSIGNED', 'CBA self-assign -> ASSIGNED');
const cbaStart = must('updateStatus', cba.token, { ticketId: cbaTicket.ticketId, status: 'IN_PROGRESS' });
eq(cbaStart.status, 'IN_PROGRESS', 'CBA can work on a self-assigned ticket');
const cbaShare = must('assignTicket', cba.token, { ticketId: cbaTicket.ticketId, analystEmail: 'analyst@pw.live' });
eq(cbaShare.analystEmail, 'analyst@pw.live', 'CBA can share with an analyst');
const cbaAssignOnCreate = must('createTicket', cba.token, { title: 'CBA assign on create', description: 'x', priority: 'Low', assignTo: 'analyst@pw.live' });
eq(cbaAssignOnCreate.status, 'ASSIGNED', 'assignTo on create -> ASSIGNED');
eq(cbaAssignOnCreate.analystEmail, 'analyst@pw.live', 'assignTo on create sets analyst');

section('ANALYST: status transitions');
const analyst = login('analyst@pw.live');
const t2mine = must('listTickets', analyst.token, {});
ok(t2mine.rows.every((t) => t.analystEmail === 'analyst@pw.live'), 'ANALYST sees only assigned');
const inProg = must('updateStatus', analyst.token, { ticketId: t1.ticketId, status: 'IN_PROGRESS' });
eq(inProg.status, 'IN_PROGRESS', 'ASSIGNED -> IN_PROGRESS');
const illegal = call('updateStatus', analyst.token, { ticketId: t1.ticketId, status: 'CLOSED' });
ok(!illegal.ok, 'illegal transition rejected');
must('updateStatus', analyst.token, { ticketId: t1.ticketId, status: 'RESOLVED' });
const afterResolve = must('getTicket', analyst.token, { ticketId: t1.ticketId });
eq(afterResolve.status, 'RESOLVED', 'IN_PROGRESS -> RESOLVED');

section('USER: close + rate');
const closedR = must('closeTicket', riya.token, { ticketId: t1.ticketId });
eq(closedR.status, 'CLOSED', 'RESOLVED -> CLOSED by requester');
const rate = must('rateTicket', riya.token, { ticketId: t1.ticketId, rating: 5, feedback: 'Fast!' });
eq(Number(rate.rating), 5, 'rating saved');
const rateAgain = call('rateTicket', riya.token, { ticketId: t1.ticketId, rating: 3 });
ok(!rateAgain.ok, 'cannot rate twice');

section('reopen guard');
const reopenNoReason = call('reopenTicket', riya.token, { ticketId: t1.ticketId });
ok(!reopenNoReason.ok, 'reopen requires a reason');
const reopenOk = call('reopenTicket', riya.token, { ticketId: t1.ticketId, reason: 'still broken' });
ok(reopenOk.ok, 'closed ticket can be reopened with a reason');
const reopenAgain = call('reopenTicket', riya.token, { ticketId: t1.ticketId, reason: 'x' });
ok(!reopenAgain.ok, 'cannot reopen a REOPENED ticket');

section('external approval flow');
const cba2 = cba.token;
const appr = must('requestApproval', cba2, { ticketId: t1.ticketId, approverEmail: 'boss@pw.live', note: 'Please sign off' });
ok(appr.approvalId && appr.demoToken, 'requestApproval returns id + token');
const info = must('getApproval', null, { a: appr.approvalId, t: appr.demoToken });
ok(info.canDecide === true, 'approver can decide');
eq(info.ticket.ticketId, t1.ticketId, 'approval links back to ticket');
const dec = must('decideApproval', null, { a: appr.approvalId, t: appr.demoToken, decision: 'APPROVED', note: 'ok' });
eq(dec.status, 'APPROVED', 'approval recorded');
const info2 = must('getApproval', null, { a: appr.approvalId, t: appr.demoToken });
ok(info2.canDecide === false, 'approval cannot be decided twice');
const badLink = call('getApproval', null, { a: appr.approvalId, t: 'wrong' });
ok(!badLink.ok, 'wrong approval token rejected');

section('reassignment flow');
const an = login('analyst@pw.live');
const rr = must('myAnalysts', an.token, {});
ok(rr.length >= 2, 'ANALYST can list colleagues (for reassign)');
const req = must('requestReassign', an.token, { ticketId: det2.ticketId, toAnalystEmail: 'vikram@pw.live', reason: 'capacity' });
ok(req.ReqID, 'reassign request created');
const listRR = must('listReassign', cba2, {});
ok(listRR.some((r) => r.reqId === req.ReqID && r.status === 'PENDING'), 'CBA sees pending reassign');
const decided = must('decideReassign', cba2, { reqId: req.ReqID, approve: true, note: 'ok' });
eq(decided.status, 'APPROVED', 'reassign approved');
const moved = must('getTicket', cba2, { ticketId: det2.ticketId });
eq(moved.analystEmail, 'vikram@pw.live', 'ticket moved to new analyst');

section('admin: users / clusters / analytics / mails / csv');
const admin = login('ambikesh.srivastava@pw.live');
eq(admin.user.role, 'ADMIN', 'admin email is ADMIN');
const users = must('adminUsers', admin.token, {});
eq(users.length, 8, 'adminUsers returns all users');
must('adminSaveUser', admin.token, { user: { email: 'newbie@pw.live', name: 'New Bie', role: 'ANALYST', clusterId: 'CL-00001', status: 'ACTIVE' } });
eq(must('adminUsers', admin.token, {}).length, 9, 'user created');
const cl = must('adminClusters', admin.token, {});
eq(cl.length, 3, 'adminClusters returns 3');
must('adminSaveCluster', admin.token, { cluster: { name: 'Growth Analytics', cbaEmail: 'cba@pw.live' } });
eq(must('adminClusters', admin.token, {}).length, 4, 'cluster created');
const an1 = must('adminAnalytics', admin.token, { days: 30 });
ok(an1.totals.total >= 4, 'analytics totals computed');
ok(Object.keys(an1.trend).length >= 1, 'analytics trend computed');
const act = must('adminActivity', admin.token, { days: 30 });
ok(act.users.length >= 1, 'activity computed');
const dash = must('dashboard', admin.token, {});
ok(dash.total >= 4 && typeof dash.overdue === 'number', 'dashboard aggregates');
const mails = must('adminMails', admin.token, {});
ok(mails.length >= 1 && mails[0].To && mails[0].Subject, 'email log has entries');
const csv = must('adminExportCsv', admin.token, { type: 'tickets' });
ok(csv.csv.split('\n').length >= 2 && /TicketID/.test(csv.csv.split('\n')[0]), 'tickets CSV has header + rows');

section('workload');
const wl = must('teamWorkload', cba2, {});
ok(Array.isArray(wl) && wl.length >= 2, 'teamWorkload lists analysts');

section('logout');
must('logout', admin.token, { token: admin.token });
const afterLogout = call('me', admin.token, {});
ok(!afterLogout.ok && afterLogout.error === 'SESSION_EXPIRED', 'token invalid after logout');

section('reset (regression)');
Store.insert('users', { Name: 'Junk', Email: 'junk@x.com', Role: 'USER', Status: 'ACTIVE' });
Store.reset();
eq(Store.all('users').length, 8, 'reset re-seeds to 8 users');
eq(Store.all('tickets').length, 4, 'reset re-seeds tickets');
const raw = sandbox.localStorage.getItem('pw_portal_db_v1');
ok(raw && raw.indexOf('junk@x.com') === -1, 'reset clears old data from localStorage');

/* ============================ summary ============================ */
console.log('\n' + '='.repeat(52));
console.log('  web-test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('  failures:'); failures.forEach((f) => console.log('   - ' + f)); }
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
