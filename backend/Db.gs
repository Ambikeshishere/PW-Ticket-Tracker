/**
 * Db.gs
 * The single place that talks to the Google Sheet, plus small shared helpers.
 *
 * Keeping sheet access here means the rest of the code stays readable and we
 * only ever have one implementation of "read a tab as objects".
 */

var Db = {
  /* Per-execution caches. Apps Script reuses the global scope for the whole
   * request, so these make repeated reads free and collapse the many
   * SpreadsheetApp.openById() calls into one. They are cleared on every write. */
  _ss: null,
  _cache: {},

  /**
   * Returns the backing spreadsheet, working for both bound and standalone
   * scripts:
   *   1. SHEET_ID constant (Config.gs), or a remembered script property
   *   2. the bound spreadsheet (Extensions ▸ Apps Script)
   *   3. otherwise creates a new spreadsheet and remembers its ID
   *
   * The result is memoised for the lifetime of the execution: opening a
   * spreadsheet is one of the slowest Apps Script calls, and the old code did
   * it on every single read/write.
   */
  ss: function () {
    if (this._ss) return this._ss;
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SHEET_ID') || SHEET_ID;
    var ss;
    if (id) {
      ss = SpreadsheetApp.openById(id);
    } else {
      var active = SpreadsheetApp.getActiveSpreadsheet();
      if (active) {
        try { props.setProperty('SHEET_ID', active.getId()); } catch (e) {}
        ss = active;
      } else {
        ss = SpreadsheetApp.create('PW Ticket Portal — Database');
        try { props.setProperty('SHEET_ID', ss.getId()); } catch (e) {}
      }
    }
    this._ss = ss;
    return ss;
  },

  sheet: function (name) {
    var sh = this.ss().getSheetByName(name);
    if (!sh) throw new Error('Missing tab "' + name + '". Run setup() once from the editor.');
    return sh;
  },

  /**
   * Reads a tab once per execution and caches its header row + raw values.
   * `all()` rebuilds fresh row objects from this cache, so callers can never
   * mutate shared state.
   */
  _raw: function (name) {
    if (this._cache[name]) return this._cache[name];
    var sh = this.sheet(name);
    var last = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var headers = [];
    var values = [];
    if (last >= 1 && lastCol >= 1) {
      headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      if (last >= 2) values = sh.getRange(2, 1, last - 1, lastCol).getValues();
    }
    var raw = { headers: headers, values: values };
    this._cache[name] = raw;
    return raw;
  },

  /** Drops the cached read for one tab (or all tabs) after a write. */
  _invalidate: function (name) {
    if (name) delete this._cache[name];
    else this._cache = {};
  },

  /** Clears every cached read. Call after writing to a sheet outside Db. */
  clearCache: function () { this._cache = {}; },

  headers: function (name) {
    return this._raw(name).headers.slice();
  },

  all: function (name) {
    var raw = this._raw(name);
    var h = raw.headers;
    var out = [];
    for (var i = 0; i < raw.values.length; i++) {
      var row = raw.values[i];
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
    this._invalidate(name);
    return obj;
  },

  /**
   * Patches one row. A single field is written with one setValue(); a
   * multi-field patch reads the row once and writes it back in a single
   * setValues() call, instead of one setValue() per field (each of which is a
   * separate Sheets round-trip).
   */
  update: function (name, row, patch) {
    var sh = this.sheet(name);
    var h = this.headers(name);
    var keys = Object.keys(patch).filter(function (k) { return h.indexOf(k) > -1; });
    if (keys.length === 1) {
      sh.getRange(row, h.indexOf(keys[0]) + 1).setValue(patch[keys[0]]);
    } else if (keys.length > 1) {
      var lastCol = Math.max(sh.getLastColumn(), h.length, 1);
      var vals = sh.getRange(row, 1, 1, lastCol).getValues()[0];
      keys.forEach(function (k) { vals[h.indexOf(k)] = patch[k]; });
      sh.getRange(row, 1, 1, lastCol).setValues([vals]);
    }
    this._invalidate(name);
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
    this._invalidate(name);
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
 * Order: Config tab PORTAL_URL -> FRONTEND_URL constant -> this web-app URL.
 */
function portalUrl() {
  var u = String(cfg('PORTAL_URL') || '').trim();
  if (u) return u.replace(/\/+$/, '');
  if (typeof FRONTEND_URL === 'string' && FRONTEND_URL) return FRONTEND_URL.replace(/\/+$/, '');
  return webAppUrl();
}

/** Deep link straight to a ticket in the portal: <portal>#ticket/<TICKET-ID>. */
function ticketUrl(ticketId) {
  return portalUrl() + '#ticket/' + encodeURIComponent(String(ticketId));
}

function logErr(where, e) {
  try { console.error(where + ': ' + (e && e.message ? e.message : e)); } catch (_) {}
}
