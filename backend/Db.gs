/**
 * Db.gs
 * The single place that talks to the Google Sheet, plus small shared helpers.
 *
 * Keeping sheet access here means the rest of the code stays readable and we
 * only ever have one implementation of "read a tab as objects".
 */

var Db = {
  /**
   * Returns the backing spreadsheet, working for both bound and standalone
   * scripts:
   *   1. SHEET_ID constant (Config.gs), or a remembered script property
   *   2. the bound spreadsheet (Extensions ▸ Apps Script)
   *   3. otherwise creates a new spreadsheet and remembers its ID
   */
  ss: function () {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SHEET_ID') || SHEET_ID;
    if (id) return SpreadsheetApp.openById(id);

    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      try { props.setProperty('SHEET_ID', active.getId()); } catch (e) {}
      return active;
    }

    var created = SpreadsheetApp.create('PW Ticket Portal — Database');
    try { props.setProperty('SHEET_ID', created.getId()); } catch (e) {}
    return created;
  },

  sheet: function (name) {
    var sh = this.ss().getSheetByName(name);
    if (!sh) throw new Error('Missing tab "' + name + '". Run setup() once from the editor.');
    return sh;
  },

  headers: function (name) {
    var sh = this.sheet(name);
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return [];
    return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  },

  all: function (name) {
    var sh = this.sheet(name);
    var last = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (last < 2 || lastCol < 1) return [];
    var h = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var values = sh.getRange(2, 1, last - 1, lastCol).getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (row.join('') === '') continue;               // skip blank rows
      var o = { _row: i + 2 };
      for (var j = 0; j < h.length; j++) o[h[j]] = row[j];
      out.push(o);
    }
    return out;
  },

  find: function (name, pred) {
    return this.all(name).filter(pred);
  },

  findOne: function (name, pred) {
    var rows = this.all(name);
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
    return null;
  },

  insert: function (name, obj) {
    var h = this.headers(name);
    var row = h.map(function (k) { return obj[k] !== undefined && obj[k] !== null ? obj[k] : ''; });
    this.sheet(name).appendRow(row);
    return obj;
  },

  update: function (name, row, patch) {
    var sh = this.sheet(name);
    var h = this.headers(name);
    Object.keys(patch).forEach(function (k) {
      var col = h.indexOf(k);
      if (col > -1) sh.getRange(row, col + 1).setValue(patch[k]);
    });
  },

  updateWhere: function (name, pred, patch) {
    var rows = this.all(name).filter(pred);
    rows.forEach(function (r) { Db.update(name, r._row, patch); });
    return rows.length;
  },

  upsert: function (name, keyField, keyValue, obj) {
    var existing = this.findOne(name, function (r) { return String(r[keyField]) === String(keyValue); });
    if (existing) { this.update(name, existing._row, obj); return { updated: true }; }
    this.insert(name, obj);
    return { created: true };
  },

  deleteWhere: function (name, pred) {
    var rows = this.all(name).filter(pred);
    // delete bottom-up so row indexes stay valid
    rows.sort(function (a, b) { return b._row - a._row; });
    rows.forEach(function (r) { Db.sheet(name).deleteRow(r._row); });
    return rows.length;
  },

  /** Generates the next sequential id, e.g. "TKT-2026-00042". Call inside withLock. */
  nextId: function (prefix, name, idCol) {
    var rows = this.all(name);
    var max = 0;
    rows.forEach(function (r) {
      var n = parseInt(String(r[idCol]).split('-').pop(), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return prefix + String(max + 1).padStart(5, '0');
  }
};

/* ------------------------- shared helpers ------------------------- */

/** Runs fn while holding the script lock (prevents duplicate ids / races). */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

function now() { return new Date(); }

function addMinutes(d, m) { return new Date(new Date(d).getTime() + m * 60000); }
function addHours(d, h) { return new Date(new Date(d).getTime() + h * 3600000); }
function addDays(d, days) { return new Date(new Date(d).getTime() + days * 86400000); }

/** Normalises Date | ISO | epoch-ms to epoch ms (0 if empty/invalid). */
function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  var s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/** SHA-256 hex digest, salted with Config.SALT. */
function sha256(s) {
  var salt = cfg('SALT') || '';
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(s) + salt, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}

function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** 6-digit numeric OTP (crypto-weak but rate-limited + hashed). */
function randomOtp() {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  return String((parseInt(hex, 16) % 900000) + 100000);
}

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function webAppUrl() {
  try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; }
}

/**
 * The public URL of the static front-end (GitHub Pages), used in email links.
 * Falls back to this Apps Script web-app URL when PORTAL_URL is not set.
 */
function portalUrl() {
  var u = String(cfg('PORTAL_URL') || '').trim();
  if (u) return u.replace(/\/+$/, '');
  return webAppUrl();
}

function logErr(where, e) {
  try { console.error(where + ': ' + (e && e.message ? e.message : e)); } catch (_) {}
}
