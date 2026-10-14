/**
 * dev/mock.js
 * A minimal in-memory emulation of the Google Apps Script runtime, just enough
 * to load the real .gs files and exercise their logic under Node.
 *
 * It is intentionally small: only the APIs this project actually uses.
 */

const crypto = require('crypto');

/* ----------------------------- Sheet model ----------------------------- */
class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const rr = this.row - 1 + r;
        const cc = this.col - 1 + c;
        const row = this.sheet._data[rr];
        rowArr.push(row && row[cc] !== undefined ? row[cc] : '');
      }
      out.push(rowArr);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      for (let c = 0; c < vals[r].length; c++) {
        this.sheet._set(this.row - 1 + r, this.col - 1 + c, vals[r][c]);
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this._data = []; this._frozen = 0; }
  _set(r, c, v) {
    while (this._data.length <= r) this._data.push([]);
    const row = this._data[r];
    while (row.length <= c) row.push('');
    row[c] = v;
  }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    for (let r = 0; r < this._data.length; r++) {
      const row = this._data[r] || [];
      if (row.some((x) => x !== '' && x !== null && x !== undefined)) last = r + 1;
    }
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this._data) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { last = Math.max(last, c + 1); break; }
      }
    }
    return last;
  }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(row, col, numRows, numCols) {
    return new Range(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  appendRow(arr) {
    const r = this.getLastRow();
    for (let c = 0; c < arr.length; c++) this._set(r, c, arr[c]);
  }
  deleteRow(r) { this._data.splice(r - 1, 1); }
  insertColumnsAfter() { /* no-op */ }
  setFrozenRows(n) { this._frozen = n; }
}

class Spreadsheet {
  constructor() { this._sheets = []; this._id = 'MOCK_SHEET_ID'; }
  getId() { return this._id; }
  getSheetByName(name) { return this._sheets.find((s) => s.name === name) || null; }
  insertSheet(name) { const s = new Sheet(name); this._sheets.push(s); return s; }
  getSheets() { return this._sheets.slice(); }
  deleteSheet(s) { this._sheets = this._sheets.filter((x) => x !== s); }
  toast() { /* no-op */ }
}

/* ------------------------------ runtime -------------------------------- */
function buildGlobals() {
  const ss = new Spreadsheet();
  const cache = new Map();
  const scriptProps = new Map();
  const sentMails = [];
  const logs = [];

  const globals = {
    /* spreadsheet */
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      create: () => ss,
      getUi: () => ({ createMenu: () => ({ addItem: () => ({ addItem: () => ({ addToUi: () => {} }) }) }) }),
    },

    /* script properties */
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null),
        setProperty: (k, v) => { scriptProps.set(k, String(v)); },
        deleteProperty: (k) => { scriptProps.delete(k); },
      }),
    },

    /* cache */
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, v); },
        remove: (k) => { cache.delete(k); },
      }),
    },

    /* lock */
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },

    /* mail */
    MailApp: {
      sendEmail: (opts) => { sentMails.push(opts); },
    },

    /* utilities */
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algo, str) => Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest()),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const dt = new Date(d);
        const pad = (n) => String(n).padStart(2, '0');
        return fmt
          .replace('yyyy', dt.getFullYear())
          .replace('MMM', ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()])
          .replace('dd', pad(dt.getDate()))
          .replace('HH', pad(dt.getHours()))
          .replace('mm', pad(dt.getMinutes()));
      },
    },

    /* session */
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },

    /* script app */
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => {
        const b = { timeBased: () => b, everyDays: () => b, everyHours: () => b, everyMinutes: () => b, atHour: () => b, create: () => ({}) };
        return b;
      },
    },

    /* html service (stubs — doGet is not exercised in tests) */
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => ({ setXFrameOptionsMode: () => ({}) }) }) }) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' }),
      createHtmlOutput: (s) => ({ getContent: () => String(s) }),
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    },

    /* content service — used by the JSON API (Api.gs) */
    ContentService: {
      MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript', TEXT: 'text/plain' },
      createTextOutput: (s) => {
        const o = {
          _content: String(s), _mime: 'text/plain',
          setMimeType(m) { o._mime = m; return o; },
          getContent() { return o._content; },
          getMimeType() { return o._mime; },
        };
        return o;
      },
    },

    Logger: { log: (m) => logs.push(String(m)) },
    console: { log: () => {}, error: () => {} },

    /* test introspection */
    __test: { ss, cache, sentMails, logs },
  };

  return globals;
}

module.exports = { buildGlobals, Spreadsheet, Sheet };
