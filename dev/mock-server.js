/**
 * dev/mock-server.js
 * Runs the real backend/ Apps Script code under Node and serves it over HTTP as
 * the JSON API, so the static front-end can be developed and tested locally
 * without deploying to Google.
 *
 *   node dev/mock-server.js            # http://localhost:8090/exec
 *   PORT=9000 node dev/mock-server.js
 *
 * Then open the portal with the API pointed at it:
 *   http://localhost:8080/index.html?api=http://localhost:8090/exec
 *
 * It seeds a small demo org (clusters + users) on boot. OTPs are printed to the
 * console instead of being emailed, so you can sign in locally.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { buildGlobals } = require('./mock');

const PORT = Number(process.env.PORT) || 8090;
const ROOT = path.join(__dirname, '..', 'backend');
const FILES = [
  'Config.gs', 'Db.gs', 'Setup.gs', 'Mail.gs', 'Auth.gs',
  'Tickets.gs', 'Approvals.gs', 'Reassign.gs', 'Admin.gs', 'Triggers.gs', 'Api.gs',
];

/* ------------------------------ boot ------------------------------ */
const globals = buildGlobals();
const ctx = vm.createContext(globals);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
ctx.setup();

/* Print OTPs to the console instead of emailing them. */
const realSend = globals.MailApp.sendEmail;
globals.MailApp.sendEmail = (opts) => {
  const m = String(opts.htmlBody || '').match(/>(\d{6})</);
  if (m) console.log('\n  \x1b[36mOTP for ' + opts.to + ': \x1b[1m' + m[1] + '\x1b[0m');
  realSend(opts);
};

/* --------------------------- demo seed ---------------------------- */
function seedDemo() {
  const admin = ctx.Db.findOne(ctx.SHEETS.USERS, (u) => String(u.Role).toUpperCase() === 'ADMIN');
  const clusters = [
    { name: 'Sales Analytics', cbaEmail: 'cba@pw.live' },
    { name: 'Marketing Analytics', cbaEmail: 'cba2@pw.live' },
    { name: 'Academics Analytics', cbaEmail: 'cba@pw.live' },
  ];
  const ids = clusters.map((c) => ctx.Admin.saveCluster(admin, { cluster: c }).clusterId);
  const users = [
    { email: 'cba@pw.live', name: 'Priya CBA', role: 'CBA', clusterId: ids[0] },
    { email: 'cba2@pw.live', name: 'Rahul CBA', role: 'CBA', clusterId: ids[1] },
    { email: 'analyst@pw.live', name: 'Analyst One', role: 'ANALYST', clusterId: ids[0] },
    { email: 'vikram@pw.live', name: 'Vikram Rao', role: 'ANALYST', clusterId: ids[1] },
    { email: 'sneha@pw.live', name: 'Sneha Gupta', role: 'ANALYST', clusterId: ids[2] },
    { email: 'riya@pw.live', name: 'Riya Sharma', role: 'USER', clusterId: ids[0] },
    { email: 'karan@pw.live', name: 'Karan Mehta', role: 'USER', clusterId: ids[1] },
  ];
  users.forEach((u) => ctx.Admin.saveUser(admin, { user: u }));
  return { clusters: ids.length, users: users.length };
}

const seeded = seedDemo();

/* ------------------------------ server ---------------------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, type) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, CORS));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname !== '/exec') {
    return send(res, 200, JSON.stringify({ ok: true, data: { service: 'PW Ticket Portal mock API', endpoint: '/exec' } }));
  }

  if (req.method === 'GET') {
    const p = Object.fromEntries(url.searchParams.entries());
    if (!p.api) return send(res, 200, '<h1>PW Ticket Portal mock API</h1><p>POST JSON to /exec</p>', 'text/html; charset=utf-8');
    let payload = {};
    try { payload = p.payload ? JSON.parse(p.payload) : {}; } catch (e) {}
    const out = ctx.handle({ api: p.api, token: p.token || '', payload });
    if (p.callback && /^[A-Za-z_$][\w$]*$/.test(p.callback)) {
      return send(res, 200, p.callback + '(' + JSON.stringify(out) + ')', 'application/javascript; charset=utf-8');
    }
    return send(res, 200, JSON.stringify(out));
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reqObj = {};
      try { reqObj = JSON.parse(body || '{}'); } catch (e) {
        return send(res, 200, JSON.stringify({ ok: false, error: 'Malformed request body.' }));
      }
      const out = ctx.handle(reqObj);
      send(res, 200, JSON.stringify(out));
    });
    return;
  }

  send(res, 405, JSON.stringify({ ok: false, error: 'Method not allowed.' }));
});

server.listen(PORT, () => {
  console.log('\n\x1b[1mPW Ticket Portal — mock API\x1b[0m');
  console.log('  listening on \x1b[36mhttp://localhost:' + PORT + '/exec\x1b[0m');
  console.log('  seeded ' + seeded.clusters + ' clusters, ' + seeded.users + ' users');
  console.log('  admin: \x1b[1mambikesh.srivastava@pw.live\x1b[0m (OTP printed here)');
  console.log('\n  open the portal with:');
  console.log('  \x1b[2mhttp://localhost:8080/index.html?api=http://localhost:' + PORT + '/exec\x1b[0m\n');
});
