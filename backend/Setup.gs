/**
 * Setup.gs
 * One-time provisioning: creates every tab with the correct headers, seeds the
 * Config tab, and ensures the first admin account exists.
 *
 * Run `setup()` once from the Apps Script editor.
 *
 * IMPORTANT: the header/order tables below are built INSIDE the functions (not
 * as top-level statements). Apps Script runs every file's top-level code, and
 * if this file happens to load before Config.gs then `SHEETS` would still be
 * undefined -> "Cannot read properties of undefined (reading 'USERS')".
 * Building them lazily makes the script independent of file load order.
 */

/** Column headers for every sheet, keyed by sheet name. */
function portalHeaders_() {
  var HEADERS = {};
  HEADERS[SHEETS.USERS] = [
    'UserID', 'Name', 'Email', 'Phone', 'Department', 'DefaultPriority', 'Role',
    'ClusterID', 'ReportsTo', 'Status', 'CreatedAt', 'LastLoginAt'
  ];
  HEADERS[SHEETS.CLUSTERS] = ['ClusterID', 'ClusterName', 'CBA_Email', 'Status'];
  HEADERS[SHEETS.TICKETS] = [
    'TicketID', 'Title', 'Description', 'Category', 'Priority', 'Status',
    'RaisedByEmail', 'RaisedByName', 'RaisedByPhone', 'Department', 'ClusterID',
    'CBA_Email', 'AnalystEmail', 'ApprovalRequired', 'ApprovalStatus', 'ApprovedBy',
    'AttachmentLinks', 'DueAt', 'CreatedAt', 'UpdatedAt', 'ResolvedAt', 'ClosedAt',
    'Rating', 'Feedback'
  ];
  HEADERS[SHEETS.LOGS] = [
    'LogID', 'TicketID', 'Action', 'ByEmail', 'ByRole', 'OldValue', 'NewValue', 'Note', 'Timestamp'
  ];
  HEADERS[SHEETS.COMMENTS] = ['CommentID', 'TicketID', 'ByEmail', 'ByName', 'Text', 'Timestamp'];
  HEADERS[SHEETS.APPROVALS] = [
    'ApprovalID', 'TicketID', 'RequestedByEmail', 'ApproverEmail', 'TokenHash', 'Status',
    'RequestNote', 'DecisionNote', 'RequestedAt', 'ExpiresAt', 'DecidedAt'
  ];
  HEADERS[SHEETS.REASSIGN] = [
    'ReqID', 'TicketID', 'FromAnalyst', 'ToAnalyst', 'Reason', 'Status', 'CBA_Email',
    'DecisionNote', 'RequestedAt', 'DecidedAt'
  ];
  HEADERS[SHEETS.OTP] = ['Email', 'OtpHash', 'ExpiresAt', 'Attempts', 'CreatedAt'];
  HEADERS[SHEETS.SESSIONS] = ['TokenHash', 'Email', 'Role', 'CreatedAt', 'ExpiresAt', 'LastSeenAt'];
  HEADERS[SHEETS.ACTIVITY] = ['Timestamp', 'Email', 'Role', 'Event', 'Meta'];
  HEADERS[SHEETS.CONFIG] = ['Key', 'Value'];
  return HEADERS;
}

/** The order in which sheets should be created. */
function portalSheetOrder_() {
  return [
    SHEETS.USERS, SHEETS.CLUSTERS, SHEETS.TICKETS, SHEETS.LOGS, SHEETS.COMMENTS,
    SHEETS.APPROVALS, SHEETS.REASSIGN, SHEETS.OTP, SHEETS.SESSIONS,
    SHEETS.ACTIVITY, SHEETS.CONFIG
  ];
}

/** Creates/repairs every sheet, seeds Config + admin. Safe to re-run. */
function setup() {
  var ss = Db.ss();
  var HEADERS = portalHeaders_();
  var SHEET_ORDER = portalSheetOrder_();

  SHEET_ORDER.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    var headers = HEADERS[name];
    var current = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String)
      : [];
    var matches = current.length === headers.length &&
      headers.every(function (h, i) { return current[i] === h; });
    if (!matches && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else if (!matches) {
      Logger.log('WARNING: tab "' + name + '" has data but headers do not match. Expected: ' +
        headers.join(', '));
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground('#111827').setFontColor('#ffffff');
    if (sh.getMaxColumns() < headers.length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    }
  });

  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  seedConfig_();
  seedAdminCluster_();
  seedAdmin_();

  try { ss.toast('Ticket Portal setup complete.', 'Setup', 5); } catch (e) {}
  return true;
}

/**
 * Run this ONCE from the Apps Script editor right after deploying (or any time
 * `appsscript.json` scopes change). It touches every Google service the portal
 * needs so Google grants the full scope set, then returns without side effects.
 * Safe to run repeatedly — it never writes data.
 *
 * Why: a Web App keeps running with the OAuth grant that existed when it was
 * authorized. If the manifest's `oauthScopes` later grows (e.g. we moved from a
 * bound Sheet to a standalone one and widened to full `spreadsheets`), the old
 * grant no longer covers the new scope and every call fails with
 * "You do not have permission to call SpreadsheetApp.openById". Running this
 * function re-triggers the consent screen and refreshes the grant.
 */
function authorize() {
  var id = Db.ss().getId();                       // https://www.googleapis.com/auth/spreadsheets
  var quota = MailApp.getRemainingDailyQuota();   // https://www.googleapis.com/auth/script.send_mail
  var triggers = ScriptApp.getProjectTriggers().length; // script.scriptapp
  var msg = 'Portal authorized. Spreadsheet: ' + id + ' | mail quota: ' + quota +
    ' | triggers: ' + triggers;
  Logger.log(msg);
  return msg;
}

/** Writes any missing Config defaults (never overwrites existing keys). */
function seedConfig_() {
  var existing = {};
  Db.all(SHEETS.CONFIG).forEach(function (r) { existing[String(r.Key)] = true; });
  Object.keys(DEFAULT_CONFIG).forEach(function (k) {
    if (existing[k]) return;
    var v = DEFAULT_CONFIG[k];
    if (k === 'SALT' && (v === DEFAULT_CONFIG.SALT)) v = randomToken();
    Db.insert(SHEETS.CONFIG, { Key: k, Value: v });
  });
  invalidateCfg_();
}

/** Ensures the built-in "Admin" cluster exists. */
function seedAdminCluster_() {
  var existing = Db.findOne(SHEETS.CLUSTERS, function (c) {
    return String(c.ClusterID) === ADMIN_CLUSTER_ID;
  });
  if (existing) return existing;
  var cluster = {
    ClusterID: ADMIN_CLUSTER_ID,
    ClusterName: ADMIN_CLUSTER_NAME,
    CBA_Email: normEmail(cfg('ADMIN_EMAIL')),
    Status: 'ACTIVE'
  };
  Db.insert(SHEETS.CLUSTERS, cluster);
  return cluster;
}

/** Ensures the admin account exists. */
function seedAdmin_() {
  var email = normEmail(cfg('ADMIN_EMAIL'));
  var existing = Db.findOne(SHEETS.USERS, function (u) { return normEmail(u.Email) === email; });
  if (existing) {
    // Keep the admin in the built-in Admin cluster (repairs older installs).
    if (String(existing.ClusterID) !== ADMIN_CLUSTER_ID) {
      Db.update(SHEETS.USERS, existing._row, { ClusterID: ADMIN_CLUSTER_ID });
    }
    return existing;
  }
  var admin = {
    UserID: Db.nextId('U-', SHEETS.USERS, 'UserID'),
    Name: 'Ambikesh Srivastava',
    Email: email,
    Phone: '',
    Department: 'Analytics',
    DefaultPriority: 'Medium',
    Role: ROLES.ADMIN,
    ClusterID: ADMIN_CLUSTER_ID,
    ReportsTo: '',
    Status: 'ACTIVE',
    CreatedAt: now().toISOString(),
    LastLoginAt: ''
  };
  Db.insert(SHEETS.USERS, admin);
  return admin;
}
