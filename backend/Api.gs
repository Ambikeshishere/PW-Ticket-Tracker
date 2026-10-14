/**
 * Api.gs
 * The JSON API for the static front-end (GitHub Pages).
 *
 * Transport
 * ---------
 *  POST  <webapp-url>            body: {"api":name,"token":..,"payload":{..}}
 *  GET   <webapp-url>?api=..&token=..&payload=<json>&callback=cb   (JSONP)
 *
 * The POST body is sent as text/plain so the browser treats it as a "simple
 * request" and skips the CORS pre-flight (Apps Script cannot answer OPTIONS).
 * The JSONP form is the fallback for environments where POST is blocked.
 *
 * Every response is { ok:true, data:... } or { ok:false, error:"..." }.
 * The client only ever calls one function: api(name, token, payload).
 */

/* ----------------------------- API maps ----------------------------- */
/* Wrapped in functions so module objects are resolved at call time. */

var PUBLIC_API = {
  signup:         function (p) { return Auth.signup(p); },
  requestOtp:     function (p) { return Auth.requestOtp(p); },
  verifyOtp:      function (p) { return Auth.verifyOtp(p); },
  getClusters:    function (p) { return Admin.publicClusters(p); },
  getApproval:    function (p) { return Approvals.getInfo(p.t, p.a); },
  decideApproval: function (p) { return Approvals.decide(p.t, p.a, p.decision, p.note); }
};

var PRIVATE_API = {
  logout:           { fn: function (u, p) { return Auth.logout(p.token); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  me:               { fn: function (u) { return Auth.me(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },

  createTicket:     { fn: function (u, p) { return Tickets.create(u, p); }, roles: ['USER', 'CBA', 'ADMIN'] },
  listTickets:      { fn: function (u, p) { return Tickets.list(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  getTicket:        { fn: function (u, p) { return Tickets.get(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  addComment:       { fn: function (u, p) { return Tickets.addComment(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  assignTicket:     { fn: function (u, p) { return Tickets.assign(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  updateStatus:     { fn: function (u, p) { return Tickets.updateStatus(u, p); }, roles: ['ANALYST', 'CBA', 'ADMIN'] },
  closeTicket:      { fn: function (u, p) { return Tickets.close(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  reopenTicket:     { fn: function (u, p) { return Tickets.reopen(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  rateTicket:       { fn: function (u, p) { return Tickets.rate(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  myAnalysts:       { fn: function (u) { return Tickets.myAnalysts(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },

  requestApproval:  { fn: function (u, p) { return Approvals.request(u, p); }, roles: ['CBA', 'ADMIN'] },
  requestReassign:  { fn: function (u, p) { return Reassign.request(u, p); }, roles: ['ANALYST'] },
  listReassign:     { fn: function (u) { return Reassign.list(u); }, roles: ['CBA', 'ADMIN'] },
  decideReassign:   { fn: function (u, p) { return Reassign.decide(u, p); }, roles: ['CBA', 'ADMIN'] },
  teamWorkload:     { fn: function (u) { return Admin.teamWorkload(u); }, roles: ['CBA', 'ADMIN'] },

  clusterAnalysts:  { fn: function (u) { return Admin.clusterAnalysts(u); }, roles: ['CBA', 'ADMIN'] },
  saveAnalyst:      { fn: function (u, p) { return Admin.saveAnalyst(u, p); }, roles: ['CBA', 'ADMIN'] },
  removeAnalyst:    { fn: function (u, p) { return Admin.removeAnalyst(u, p); }, roles: ['CBA', 'ADMIN'] },

  adminUsers:       { fn: function () { return Admin.listUsers(); }, roles: ['ADMIN'] },
  adminSaveUser:    { fn: function (u, p) { return Admin.saveUser(u, p); }, roles: ['ADMIN'] },
  adminClusters:    { fn: function () { return Admin.listClusters(); }, roles: ['ADMIN'] },
  adminSaveCluster: { fn: function (u, p) { return Admin.saveCluster(u, p); }, roles: ['ADMIN'] },
  adminAnalytics:   { fn: function (u, p) { return Admin.analytics(u, p); }, roles: ['ADMIN'] },
  adminActivity:    { fn: function (u, p) { return Admin.activity(u, p); }, roles: ['ADMIN'] },
  adminExportCsv:   { fn: function (u, p) { return Admin.exportCsv(u, p); }, roles: ['ADMIN'] },

  dashboard:        { fn: function (u) { return Tickets.dashboard(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] }
};

/* ------------------------------ router ------------------------------ */

/** Convenience wrapper: api(name, token, payload) -> { ok, data|error }. */
function api(name, token, payload) {
  return handle({ api: name, token: token || '', payload: payload || {} });
}

/**
 * Provisions the sheets on the very first API call, so a fresh deployment works
 * without anyone opening the editor to run setup(). Guarded by a script
 * property + a lock so it runs exactly once even under concurrent requests.
 */
function ensureSetup_() {
  var props = PropertiesService.getScriptProperties();
  var done = props.getProperty('SETUP_DONE') === '1' &&
    props.getProperty('SETUP_VERSION') === String(SETUP_VERSION);
  if (!done) {
    var lock = LockService.getScriptLock();
    try { lock.waitLock(30000); } catch (e) { /* proceed anyway */ }
    try {
      var stillDone = props.getProperty('SETUP_DONE') === '1' &&
        props.getProperty('SETUP_VERSION') === String(SETUP_VERSION);
      if (!stillDone) {
        setup();
        props.setProperty('SETUP_DONE', '1');
        props.setProperty('SETUP_VERSION', String(SETUP_VERSION));
      }
    } finally {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
  ensureMailTrigger_();
}

/**
 * Installs the 1-minute mail-drain trigger once, so queued workflow email is
 * actually delivered. Guarded by a script property; never breaks a request.
 */
function ensureMailTrigger_() {
  if (!MAIL_QUEUE_ENABLED) return;
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('MAIL_TRIGGER_DONE') === '1') return;
    var has = ScriptApp.getProjectTriggers().some(function (t) {
      try { return t.getHandlerFunction && t.getHandlerFunction() === 'drainMailQueue'; }
      catch (e) { return false; }
    });
    if (!has) ScriptApp.newTrigger('drainMailQueue').timeBased().everyMinutes(1).create();
    props.setProperty('MAIL_TRIGGER_DONE', '1');
  } catch (e) { logErr('ensureMailTrigger_', e); }
}

/** Runs one API call and always returns a plain { ok, data|error } object. */
function handle(req) {
  var name = String((req && req.api) || '');
  var token = (req && req.token) || '';
  var payload = (req && req.payload) || {};
  try {
    ensureSetup_();
    if (PUBLIC_API[name]) {
      return { ok: true, data: clean_(PUBLIC_API[name](payload)) };
    }
    var route = PRIVATE_API[name];
    if (!route) throw new Error('Unknown API: ' + name);

    var user = Auth.requireSession(token);
    if (route.roles.indexOf(user.Role) === -1) {
      throw new Error('Not allowed for your role (' + user.Role + ').');
    }
    return { ok: true, data: clean_(route.fn(user, payload)) };
  } catch (err) {
    logErr('api:' + name, err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** Makes a value JSON-safe: Dates -> ISO strings, drops internal _row keys. */
function clean_(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(clean_);
  if (typeof v === 'object') {
    var out = {};
    Object.keys(v).forEach(function (k) { if (k !== '_row') out[k] = clean_(v[k]); });
    return out;
  }
  return v;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------- entry points --------------------------- */

/** POST: the primary transport. Body is JSON sent as text/plain. */
function doPost(e) {
  var req = {};
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    req = JSON.parse(raw);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Malformed request body.' });
  }
  return jsonOut_(handle(req));
}

/** GET: JSONP fallback, plus a friendly page when opened in a browser. */
function doGet(e) {
  var p = (e && e.parameter) || {};

  if (p.api) {
    var payload = {};
    try { payload = p.payload ? JSON.parse(p.payload) : {}; } catch (err) {}
    var res = handle({ api: p.api, token: p.token || '', payload: payload });

    var cb = String(p.callback || '');
    if (/^[A-Za-z_$][\w$]*$/.test(cb)) {
      return ContentService.createTextOutput(cb + '(' + JSON.stringify(res) + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return jsonOut_(res);
  }

  return HtmlService.createHtmlOutput(
    '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:60px auto;' +
    'padding:24px;border:1px solid #e5e7eb;border-radius:12px">' +
    '<h2 style="margin:0 0 8px">' + escHtml(cfg('APP_NAME')) + '</h2>' +
    '<p style="color:#6b7280">This is the API endpoint. The portal itself is served ' +
    'from the static front-end.</p>' +
    '<p><a href="' + escHtml(portalUrl()) + '">Open the portal &rarr;</a></p></div>');
}

/** Sheet menu for the owner. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Ticket Portal')
      .addItem('Setup / repair sheets', 'setup')
      .addItem('Install triggers', 'setupTriggers')
      .addToUi();
  } catch (e) { /* not available in every context */ }
}
