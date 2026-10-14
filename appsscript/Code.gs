/**
 * Code.gs
 * Web app entry point + the single API router.
 *
 * The client only ever calls api(name, token, payload).
 * Public endpoints work without a session; every private endpoint checks the
 * session AND the caller's role before running.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};

  var t = HtmlService.createTemplateFromFile('index');
  t.approvalAction = p.action || '';   // 'approve' | 'reject' | ''
  t.approvalToken = p.t || '';
  t.approvalId = p.a || '';
  return t.evaluate()
    .setTitle(cfg('APP_NAME'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets index.html pull in styles.html / app.js.html. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ----------------------------- API maps ----------------------------- */
/* Every fn is wrapped so module objects (const) are resolved at call time,
   never at file-load time. */

var PUBLIC_API = {
  signup:        function (p) { return Auth.signup(p); },
  requestOtp:    function (p) { return Auth.requestOtp(p); },
  verifyOtp:     function (p) { return Auth.verifyOtp(p); },
  getClusters:   function (p) { return Admin.publicClusters(p); },
  getApproval:   function (p) { return Approvals.getInfo(p.t, p.a); },
  decideApproval: function (p) { return Approvals.decide(p.t, p.a, p.decision, p.note); }
};

var PRIVATE_API = {
  logout:           { fn: function (u, p) { return Auth.logout(p.token); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  me:               { fn: function (u, p) { return Auth.me(u); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },

  createTicket:     { fn: function (u, p) { return Tickets.create(u, p); }, roles: ['USER', 'ADMIN'] },
  listTickets:      { fn: function (u, p) { return Tickets.list(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  getTicket:        { fn: function (u, p) { return Tickets.get(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  addComment:       { fn: function (u, p) { return Tickets.addComment(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] },
  assignTicket:     { fn: function (u, p) { return Tickets.assign(u, p); }, roles: ['CBA', 'ADMIN'] },
  updateStatus:     { fn: function (u, p) { return Tickets.updateStatus(u, p); }, roles: ['ANALYST', 'CBA', 'ADMIN'] },
  closeTicket:      { fn: function (u, p) { return Tickets.close(u, p); }, roles: ['USER', 'ADMIN'] },
  reopenTicket:     { fn: function (u, p) { return Tickets.reopen(u, p); }, roles: ['USER', 'ADMIN'] },
  rateTicket:       { fn: function (u, p) { return Tickets.rate(u, p); }, roles: ['USER'] },
  myAnalysts:       { fn: function (u, p) { return Tickets.myAnalysts(u, p); }, roles: ['CBA', 'ADMIN'] },

  requestApproval:  { fn: function (u, p) { return Approvals.request(u, p); }, roles: ['CBA', 'ADMIN'] },
  requestReassign:  { fn: function (u, p) { return Reassign.request(u, p); }, roles: ['ANALYST'] },
  listReassign:     { fn: function (u, p) { return Reassign.list(u, p); }, roles: ['CBA', 'ADMIN'] },
  decideReassign:   { fn: function (u, p) { return Reassign.decide(u, p); }, roles: ['CBA', 'ADMIN'] },
  teamWorkload:     { fn: function (u, p) { return Admin.teamWorkload(u, p); }, roles: ['CBA', 'ADMIN'] },

  adminUsers:       { fn: function (u, p) { return Admin.listUsers(u, p); }, roles: ['ADMIN'] },
  adminSaveUser:    { fn: function (u, p) { return Admin.saveUser(u, p); }, roles: ['ADMIN'] },
  adminClusters:    { fn: function (u, p) { return Admin.listClusters(u, p); }, roles: ['ADMIN'] },
  adminSaveCluster: { fn: function (u, p) { return Admin.saveCluster(u, p); }, roles: ['ADMIN'] },
  adminAnalytics:   { fn: function (u, p) { return Admin.analytics(u, p); }, roles: ['ADMIN'] },
  adminActivity:    { fn: function (u, p) { return Admin.activity(u, p); }, roles: ['ADMIN'] },
  adminExportCsv:   { fn: function (u, p) { return Admin.exportCsv(u, p); }, roles: ['ADMIN'] },

  dashboard:        { fn: function (u, p) { return Tickets.dashboard(u, p); }, roles: ['USER', 'CBA', 'ANALYST', 'ADMIN'] }
};

/** Single entry point used by the client. */
function api(name, token, payload) {
  try {
    payload = payload || {};
    if (PUBLIC_API[name]) {
      return { ok: true, data: PUBLIC_API[name](payload) };
    }
    var route = PRIVATE_API[name];
    if (!route) throw new Error('Unknown API: ' + name);

    var user = Auth.requireSession(token);
    if (route.roles.indexOf(user.Role) === -1) {
      throw new Error('Not allowed for your role (' + user.Role + ').');
    }
    return { ok: true, data: route.fn(user, payload) };
  } catch (err) {
    logErr('api:' + name, err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
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
