/**
 * Config.gs
 * Sheet names, roles, and Config-tab backed settings.
 *
 * Settings live in the `Config` tab (Key | Value) so a non-developer admin can
 * change them without touching code. Values are cached for 5 minutes.
 */

var SHEETS = {
  USERS: 'Users',
  CLUSTERS: 'Clusters',
  TICKETS: 'Tickets',
  LOGS: 'TicketLogs',
  COMMENTS: 'Comments',
  APPROVALS: 'Approvals',
  REASSIGN: 'ReassignRequests',
  OTP: 'OTP',
  SESSIONS: 'Sessions',
  ACTIVITY: 'ActivityLog',
  CONFIG: 'Config'
};

var ROLES = { USER: 'USER', CBA: 'CBA', ANALYST: 'ANALYST', ADMIN: 'ADMIN' };

var TICKET_STATUSES = [
  'NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_APPROVAL',
  'ON_HOLD', 'RESOLVED', 'CLOSED', 'REOPENED'
];

var PRIORITIES = ['Low', 'Medium', 'High'];

/** Fallback values — used if the Config tab is missing or a key is absent. */
var DEFAULT_CONFIG = {
  APP_NAME: 'PW Analytics Ticket Portal',
  ADMIN_EMAIL: 'ambikesh.srivastava@pw.live',
  ALLOWED_DOMAIN: 'pw.live',          // '' to allow any email
  OTP_EXPIRY_MIN: '5',
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_SEC: '60',
  SESSION_HOURS: '12',
  SILENT_SESSION_MIN: '5',            // how often LastSeenAt is refreshed
  SLA_HIGH_HRS: '24',
  SLA_MED_HRS: '72',
  SLA_LOW_HRS: '168',                 // 7 days
  APPROVAL_EXPIRY_HRS: '72',
  AUTO_CLOSE_DAYS: '3',
  SALT: 'CHANGE-ME-please-set-a-random-salt'
};

/** Returns a single config value (string), or undefined. */
function cfg(key) {
  var map = allCfg_();
  return map[key] !== undefined ? map[key] : DEFAULT_CONFIG[key];
}

/** Returns a numeric config value with a fallback. */
function cfgNum(key) {
  var v = Number(cfg(key));
  return isNaN(v) ? Number(DEFAULT_CONFIG[key]) : v;
}

/** Sets a config value (admin/editor use) and clears the cache. */
function setCfg(key, value) {
  Db.upsert(SHEETS.CONFIG, 'Key', key, { Key: key, Value: String(value) });
  invalidateCfg_();
  return true;
}

function allCfg_() {
  var cache = CacheService.getScriptCache();
  var raw = null;
  try { raw = cache.get('CFG'); } catch (e) {}
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  var map = {};
  try {
    Db.all(SHEETS.CONFIG).forEach(function (r) {
      if (r.Key) map[String(r.Key)] = String(r.Value);
    });
  } catch (e) {
    // Config tab not created yet — fall back to defaults only.
    map = {};
  }
  try { cache.put('CFG', JSON.stringify(map), 300); } catch (e) {}
  return map;
}

function invalidateCfg_() {
  try { CacheService.getScriptCache().remove('CFG'); } catch (e) {}
}

/** SLA due date (Date) for a priority, measured from `from` (default now). */
function slaDueDate(priority, from) {
  var base = from ? new Date(from) : new Date();
  var hrs = priority === 'High' ? cfgNum('SLA_HIGH_HRS')
    : priority === 'Low' ? cfgNum('SLA_LOW_HRS')
    : cfgNum('SLA_MED_HRS');
  return new Date(base.getTime() + hrs * 3600000);
}
