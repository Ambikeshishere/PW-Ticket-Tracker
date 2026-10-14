/* ============================================================
   store.js — browser data layer
   A tiny localStorage-backed "database" + shared helpers.
   This replaces the Google Sheet from the Apps Script version.
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'pw_portal_db_v1';

  /* ----------------------------- utils ----------------------------- */
  var U = {
    now: function () { return new Date().toISOString(); },
    addMinutes: function (d, m) { return new Date(new Date(d).getTime() + m * 60000).toISOString(); },
    addHours: function (d, h) { return new Date(new Date(d).getTime() + h * 3600000).toISOString(); },
    addDays: function (d, n) { return new Date(new Date(d).getTime() + n * 86400000).toISOString(); },
    toMs: function (v) {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'number') return v;
      var t = new Date(v).getTime();
      return isNaN(t) ? 0 : t;
    },
    normEmail: function (e) { return String(e || '').trim().toLowerCase(); },
    uid: function (p) {
      var s = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return (p || 'id_') + s;
    },
    randomToken: function () {
      var a = new Uint8Array(24);
      (global.crypto || {}).getRandomValues ? global.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
      return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    },
    randomOtp: function () { return String(Math.floor(100000 + Math.random() * 900000)); },
    escHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    fmtDate: function (v) {
      if (!v) return '—';
      var d = new Date(v);
      if (isNaN(d)) return String(v);
      return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    dayKey: function (v) { return String(v || '').slice(0, 10); }
  };

  /* ------------------------------ db ------------------------------- */
  var TABLES = ['users', 'clusters', 'tickets', 'logs', 'comments',
    'approvals', 'reassign', 'otp', 'sessions', 'activity', 'mails'];

  function blank() {
    var db = { config: {}, seq: {} };
    TABLES.forEach(function (t) { db[t] = []; });
    return db;
  }

  var db = null;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) db = JSON.parse(raw);
    } catch (e) { db = null; }
    if (!db || !db.users) db = blank();
    TABLES.forEach(function (t) { if (!Array.isArray(db[t])) db[t] = []; });
    if (!db.config) db.config = {};
    if (!db.seq) db.seq = {};
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
  }

  var Store = {
    U: U,
    TABLES: TABLES,

    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      db = blank();
      seed();
      save();
    },

    all: function (t) { return db[t] || []; },
    find: function (t, pred) { return this.all(t).filter(pred); },
    findOne: function (t, pred) {
      var rows = this.all(t);
      for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
      return null;
    },
    insert: function (t, obj) {
      if (!obj._id) obj._id = U.uid(t[0]);
      db[t].push(obj);
      save();
      return obj;
    },
    update: function (t, row, patch) {
      if (!row) return;
      Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
      save();
      return row;
    },
    updateWhere: function (t, pred, patch) {
      var rows = this.find(t, pred);
      rows.forEach(function (r) { Store.update(t, r, patch); });
      return rows.length;
    },
    remove: function (t, pred) {
      var before = db[t].length;
      db[t] = db[t].filter(function (r) { return !pred(r); });
      save();
      return before - db[t].length;
    },

    /** Sequential business id, e.g. TKT-2026-00042 */
    nextId: function (prefix, t, idField) {
      var max = 0;
      this.all(t).forEach(function (r) {
        var n = parseInt(String(r[idField]).split('-').pop(), 10);
        if (!isNaN(n) && n > max) max = n;
      });
      return prefix + String(max + 1).padStart(5, '0');
    },

    cfg: function (k, fallback) {
      return db.config[k] !== undefined ? db.config[k] : fallback;
    },
    setCfg: function (k, v) { db.config[k] = String(v); save(); return v; }
  };

  load();

  /* ------------------------------ seed ----------------------------- */
  function seed() {
    if (Store.all('users').length) return;

    Store.setCfg('APP_NAME', 'PW Analytics Ticket Portal');
    Store.setCfg('ADMIN_EMAIL', 'ambikesh.srivastava@pw.live');
    Store.setCfg('ALLOWED_DOMAIN', '');            // demo: allow any email
    Store.setCfg('OTP_EXPIRY_MIN', '10');
    Store.setCfg('OTP_MAX_ATTEMPTS', '5');
    Store.setCfg('SESSION_HOURS', '24');
    Store.setCfg('SLA_HIGH_HRS', '24');
    Store.setCfg('SLA_MED_HRS', '72');
    Store.setCfg('SLA_LOW_HRS', '168');
    Store.setCfg('APPROVAL_EXPIRY_HRS', '72');
    Store.setCfg('AUTO_CLOSE_DAYS', '3');

    var clusters = [
      { ClusterID: 'CL-00001', ClusterName: 'Sales Analytics', CBA_Email: 'cba@pw.live', Status: 'ACTIVE' },
      { ClusterID: 'CL-00002', ClusterName: 'Marketing Analytics', CBA_Email: 'cba2@pw.live', Status: 'ACTIVE' },
      { ClusterID: 'CL-00003', ClusterName: 'Academics Analytics', CBA_Email: 'cba@pw.live', Status: 'ACTIVE' }
    ];
    clusters.forEach(function (c) { Store.insert('clusters', c); });

    function user(name, email, role, clusterId, dept) {
      return Store.insert('users', {
        UserID: Store.nextId('U-', 'users', 'UserID'), Name: name, Email: email, Phone: '9876543210',
        Department: dept || 'Analytics', DefaultPriority: 'Medium', Role: role,
        ClusterID: clusterId || '', ReportsTo: '', Status: 'ACTIVE',
        CreatedAt: U.now(), LastLoginAt: ''
      });
    }

    user('Ambikesh Srivastava', 'ambikesh.srivastava@pw.live', 'ADMIN', '', 'Analytics');
    user('Priya CBA', 'cba@pw.live', 'CBA', 'CL-00001', 'Analytics');
    user('Rahul CBA', 'cba2@pw.live', 'CBA', 'CL-00002', 'Analytics');
    user('Ana Lyst', 'analyst@pw.live', 'ANALYST', 'CL-00001', 'Analytics');
    user('Vikram Analyst', 'vikram@pw.live', 'ANALYST', 'CL-00001', 'Analytics');
    user('Sneha Analyst', 'sneha@pw.live', 'ANALYST', 'CL-00002', 'Analytics');
    user('Riya Sharma', 'riya@pw.live', 'USER', 'CL-00001', 'Sales');
    user('Karan Mehta', 'karan@pw.live', 'USER', 'CL-00002', 'Marketing');

    // a few sample tickets
    function mkTicket(title, desc, cat, prio, raised, cluster, cbaEmail, analyst, status, daysAgo) {
      var created = U.addDays(U.now(), -daysAgo);
      var due = U.addHours(created, prio === 'High' ? 24 : prio === 'Low' ? 168 : 72);
      var t = Store.insert('tickets', {
        TicketID: Store.nextId('TKT-' + new Date().getFullYear() + '-', 'tickets', 'TicketID'),
        Title: title, Description: desc, Category: cat, Priority: prio, Status: status,
        RaisedByEmail: raised.email, RaisedByName: raised.name, RaisedByPhone: raised.phone || '9876543210',
        Department: raised.department, ClusterID: cluster, CBA_Email: cbaEmail, AnalystEmail: analyst,
        ApprovalRequired: 'FALSE', ApprovalStatus: 'NONE', ApprovedBy: '', AttachmentLinks: '',
        DueAt: due, CreatedAt: created, UpdatedAt: created, ResolvedAt: '', ClosedAt: '', Rating: '', Feedback: ''
      });
      Store.insert('logs', {
        LogID: U.uid('L'), TicketID: t.TicketID, Action: 'CREATED', ByEmail: raised.email,
        ByRole: 'USER', OldValue: '', NewValue: prio, Note: 'Ticket raised', Timestamp: created
      });
      return t;
    }

    var riya = Store.findOne('users', function (u) { return u.Email === 'riya@pw.live'; });
    var karan = Store.findOne('users', function (u) { return u.Email === 'karan@pw.live'; });
    mkTicket('Need weekly sales report', 'Please share the weekly sales numbers for my region.',
      'Report request', 'High', riya, 'CL-00001', 'cba@pw.live', '', 'NEW', 0.2);
    mkTicket('Dashboard shows stale data', 'The marketing dashboard is not refreshing since yesterday.',
      'Dashboard bug', 'Medium', karan, 'CL-00002', 'cba2@pw.live', 'sneha@pw.live', 'IN_PROGRESS', 1);
    mkTicket('Churn analysis for Q3', 'Need a churn breakdown by cohort for last quarter.',
      'New analysis', 'Medium', riya, 'CL-00001', 'cba@pw.live', 'analyst@pw.live', 'ASSIGNED', 2);
    mkTicket('Duplicate rows in export', 'The CSV export has duplicate rows for a few users.',
      'Data issue', 'Low', karan, 'CL-00002', 'cba2@pw.live', 'sneha@pw.live', 'RESOLVED', 4);
  }

  seed();

  global.Store = Store;
})(window);
