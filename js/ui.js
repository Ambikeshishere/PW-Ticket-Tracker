/* ============================================================
   ui.js — the client app (HTML/CSS/JS, no framework)
   Talks to the in-browser API via call(name, payload).
   ============================================================ */
(function () {
  'use strict';

  var state = {
    token: null, user: null, view: 'dashboard',
    tickets: [], filters: { q: '', status: '', priority: '', page: 1, pageSize: 20 },
    total: 0, pendingCount: 0, approval: null
  };

  /* ------------------------------ utils ------------------------------ */
  function $(id) { return document.getElementById(id); }
  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getDate()) + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() +
      ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add('hidden'); }, 4000);
  }
  function spin() { return '<span class="spinner"></span>'; }
  function statusBadge(s) { return '<span class="badge b-' + h(s) + '">' + h(String(s || '').replace(/_/g, ' ')) + '</span>'; }
  function priorityBadge(p) { return '<span class="badge p-' + h(p) + '">' + h(p) + '</span>'; }
  function approvalBadge(s) { return s && s !== 'NONE' ? '<span class="badge ap-' + h(s) + '">' + h(s) + '</span>' : '<span class="muted">—</span>'; }
  function slaBadge(s) { return s && s !== '-' ? '<span class="badge ap-' + h(s) + '">' + h(String(s).replace('_', ' ')) + '</span>' : ''; }
  function debounce(fn, ms) { var t; return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); }; }

  /* --------------------------- api bridge ---------------------------- */
  function call(name, payload) {
    return API.call(name, state.token, payload || {}).then(function (res) {
      if (res.ok) return res.data;
      if (res.error === 'SESSION_EXPIRED') { doLogout(true); throw new Error('Session expired'); }
      throw new Error(res.error || 'Request failed');
    });
  }

  /* ------------------------------ theme ------------------------------ */
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('pw_theme', t); } catch (e) {} }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

  /* --------------------------- approval url -------------------------- */
  function approvalFromUrl() {
    var hash = location.hash || '';
    var m = hash.match(/#approve\/([^/]+)\/([^/&]+)/);
    if (m) return { id: m[1], token: m[2] };
    var q = new URLSearchParams(location.search);
    if (q.get('a') && q.get('t')) return { id: q.get('a'), token: q.get('t') };
    return null;
  }

  /* ------------------------------ boot ------------------------------- */
  function boot() {
    try { applyTheme(localStorage.getItem('pw_theme') || 'light'); } catch (e) { applyTheme('light'); }
    $('btnTheme').onclick = toggleTheme;

    var ap = approvalFromUrl();
    if (ap) { state.approval = ap; showApproval(); return; }

    var t = localStorage.getItem('pw_token');
    if (t) {
      API.call('me', t, {}).then(function (me) {
        if (me.ok) { state.token = t; state.user = me.data; enterApp(); }
        else { localStorage.removeItem('pw_token'); showAuth(); wireAuth(); }
      });
      return;
    }
    showAuth();
    wireAuth();
  }

  function showAuth() {
    $('authScreen').classList.remove('hidden');
    $('mainScreen').classList.add('hidden');
    loadClustersInto('suCluster');
  }

  /* ------------------------------ auth ------------------------------- */
  function wireAuth() {
    $('toSignup').onclick = function (e) { e.preventDefault(); toggleAuth(true); };
    $('toLogin').onclick = function (e) { e.preventDefault(); toggleAuth(false); };
    $('btnSendOtp').onclick = sendOtp;
    $('btnResendOtp').onclick = sendOtp;
    $('btnVerifyOtp').onclick = verifyOtp;
    $('btnSignup').onclick = doSignup;
    $('loginOtp').addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyOtp(); });
  }
  function toggleAuth(signup) {
    $('loginPane').classList.toggle('hidden', signup);
    $('signupPane').classList.toggle('hidden', !signup);
  }
  function loadClustersInto(id) {
    call('getClusters', {}).then(function (list) {
      var sel = $(id); if (!sel) return;
      sel.innerHTML = '<option value="">Select…</option>' + list.map(function (c) {
        return '<option value="' + h(c.clusterId) + '">' + h(c.name) + '</option>';
      }).join('');
    }).catch(function () {});
  }
  function sendOtp() {
    var email = $('loginEmail').value.trim();
    if (!email) { toast('Enter your email', 'err'); return; }
    var b = $('btnSendOtp'); b.disabled = true; b.innerHTML = spin() + ' Sending…';
    call('requestOtp', { email: email }).then(function (d) {
      $('otpBlock').classList.remove('hidden');
      $('otpReveal').classList.remove('hidden');
      $('otpReveal').innerHTML = d.message || 'If this email is registered, we\'ve sent a one-time code. Check your inbox.';
      toast('If registered, an OTP was sent', 'ok');
      $('loginOtp').focus();
    }).catch(function (e) { toast(e.message, 'err'); })
      .then(function () { b.disabled = false; b.textContent = 'Send OTP'; });
  }
  function verifyOtp() {
    var email = $('loginEmail').value.trim();
    var code = $('loginOtp').value.trim();
    if (!code) { toast('Enter the OTP', 'err'); return; }
    var b = $('btnVerifyOtp'); b.disabled = true; b.innerHTML = spin() + ' Verifying…';
    call('verifyOtp', { email: email, code: code }).then(function (d) {
      state.token = d.token; state.user = d.user;
      localStorage.setItem('pw_token', d.token);
      enterApp();
    }).catch(function (e) { toast(e.message, 'err'); })
      .then(function () { b.disabled = false; b.textContent = 'Verify & Sign in'; });
  }
  function doSignup() {
    var payload = {
      name: $('suName').value.trim(), email: $('suEmail').value.trim(),
      phone: $('suPhone').value.trim(), department: $('suDepartment').value,
      clusterId: $('suCluster').value, defaultPriority: $('suPriority').value
    };
    var b = $('btnSignup'); b.disabled = true; b.innerHTML = spin() + ' Creating…';
    call('signup', payload).then(function () {
      toast('Account created. Sign in with OTP.', 'ok');
      toggleAuth(false);
      $('loginEmail').value = payload.email;
      $('otpBlock').classList.add('hidden');
      $('otpReveal').classList.add('hidden');
    }).catch(function (e) { toast(e.message, 'err'); })
      .then(function () { b.disabled = false; b.textContent = 'Create account'; });
  }
  function doLogout(silent) {
    if (!silent && state.token) { try { API.call('logout', state.token, { token: state.token }); } catch (e) {} }
    localStorage.removeItem('pw_token');
    state.token = null; state.user = null;
    location.hash = '';
    location.reload();
  }

  /* ------------------------------ app -------------------------------- */
  function enterApp() {
    $('authScreen').classList.add('hidden');
    $('mainScreen').classList.remove('hidden');
    $('userChip').textContent = state.user.name + ' · ' + state.user.role;
    $('btnLogout').onclick = function () { doLogout(false); };
    $('btnMenu').onclick = function () { $('sidebar').classList.toggle('open'); };
    renderNav();
    setView('dashboard');
  }

  function navItems() {
    var r = state.user.role;
    var items = [{ id: 'dashboard', label: 'Dashboard', icon: '▦' }];
    if (r === 'USER') items.push({ id: 'tickets', label: 'My Tickets', icon: '🗂' });
    if (r === 'ANALYST') items.push({ id: 'tickets', label: 'Assigned to me', icon: '🗂' });
    if (r === 'CBA') items.push({ id: 'tickets', label: 'Cluster Tickets', icon: '🗂' });
    if (r === 'ADMIN') items.push({ id: 'tickets', label: 'All Tickets', icon: '🗂' });
    if (r === 'USER' || r === 'CBA' || r === 'ADMIN') items.push({ id: 'new', label: 'Raise a ticket', icon: '＋' });
    if (r === 'CBA' || r === 'ADMIN') {
      items.push({ id: 'approvals', label: 'Approvals', icon: '✓', badge: true });
      items.push({ id: 'reassign', label: 'Reassign Requests', icon: '⇄' });
      items.push({ id: 'workload', label: 'Team Workload', icon: '⚖' });
    }
    if (r === 'ADMIN') {
      items.push({ id: 'users', label: 'Users', icon: '👥' });
      items.push({ id: 'clusters', label: 'Clusters', icon: '🧩' });
      items.push({ id: 'activity', label: 'Activity', icon: '📊' });
      items.push({ id: 'analytics', label: 'Analytics', icon: '📈' });
    }
    return items;
  }
  function renderNav() {
    var nav = $('navList');
    nav.innerHTML = navItems().map(function (it) {
      var badge = (it.badge && state.pendingCount) ? '<span class="nav-badge">' + state.pendingCount + '</span>' : '';
      return '<button class="nav-item' + (state.view === it.id ? ' active' : '') + '" data-view="' + it.id + '">' +
        it.icon + ' <span>' + h(it.label) + '</span>' + badge + '</button>';
    }).join('');
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (b) {
      b.onclick = function () { setView(b.getAttribute('data-view')); $('sidebar').classList.remove('open'); };
    });
  }
  function setView(v) {
    state.view = v;
    renderNav();
    $('content').innerHTML = '<div class="loading">' + spin() + ' Loading…</div>';
    var map = {
      dashboard: renderDashboard, tickets: renderTickets, new: renderNewTicket,
      approvals: renderApprovals, reassign: renderReassign, workload: renderWorkload,
      users: renderUsers, clusters: renderClusters, activity: renderActivity,
      analytics: renderAnalytics
    };
    (map[v] || function () { $('content').innerHTML = '<div class="empty">Unknown view</div>'; })();
    refreshBadge();
  }
  function refreshBadge() {
    var r = state.user.role;
    if (r !== 'CBA' && r !== 'ADMIN') return;
    call('dashboard', {}).then(function (d) { state.pendingCount = d.pendingReassignments || 0; renderNav(); }).catch(function () {});
  }

  /* ---------------------------- dashboard ---------------------------- */
  function renderDashboard() {
    call('dashboard', {}).then(function (d) {
      var r = state.user.role;
      var cards = [
        { n: d.total, l: r === 'ADMIN' ? 'Total tickets' : 'Tickets in view' },
        { n: d.open, l: 'Open' }, { n: d.closed, l: 'Closed' }
      ];
      if (r === 'CBA' || r === 'ADMIN') {
        cards.push({ n: d.unassigned, l: 'Unassigned' });
        cards.push({ n: d.pendingReassignments || 0, l: 'Pending reassign' });
        cards.push({ n: d.pendingApprovals || 0, l: 'Awaiting approval' });
      }
      if (r === 'ANALYST') cards.push({ n: d.assignedToMe, l: 'Assigned to me' });
      cards.push({ n: d.overdue, l: 'Overdue' });

      var statusBars = Object.keys(d.byStatus || {}).map(function (k) {
        return '<div class="inline" style="justify-content:space-between"><span>' + statusBadge(k) + '</span><b>' + d.byStatus[k] + '</b></div>';
      }).join('') || '<p class="muted">No tickets yet.</p>';
      var prioBars = Object.keys(d.byPriority || {}).map(function (k) {
        return '<div class="inline" style="justify-content:space-between">' + priorityBadge(k) + '<b>' + d.byPriority[k] + '</b></div>';
      }).join('') || '<p class="muted">No tickets yet.</p>';

      var recent = (d.recent || []).map(function (t) {
        return '<tr data-id="' + h(t.ticketId) + '"><td class="tid">' + h(t.ticketId) + '</td><td>' + h(t.title) + '</td>' +
          '<td>' + priorityBadge(t.priority) + '</td><td>' + statusBadge(t.status) + '</td><td class="muted">' + fmt(t.createdAt) + '</td></tr>';
      }).join('');

      $('content').innerHTML =
        '<div class="page-head"><h2>Hello, ' + h(state.user.name.split(' ')[0]) + ' 👋</h2><span class="pill">' + h(r) + '</span></div>' +
        '<div class="stats">' + cards.map(function (c) { return '<div class="stat"><div class="num">' + c.n + '</div><div class="lbl">' + h(c.l) + '</div></div>'; }).join('') + '</div>' +
        '<div class="grid2">' +
          '<div class="section"><h4>By status</h4><div class="stack">' + statusBars + '</div></div>' +
          '<div class="section"><h4>By priority</h4><div class="stack">' + prioBars + '</div></div>' +
        '</div>' +
        '<div class="section"><h4>Recent tickets</h4><div class="table-wrap">' +
          (recent ? '<table class="tbl"><thead><tr><th>ID</th><th>Title</th><th>Priority</th><th>Status</th><th>Created</th></tr></thead><tbody>' + recent + '</tbody></table>' : '<div class="empty">No tickets yet.</div>') +
        '</div></div>';

      bindRowClicks();
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }

  function bindRowClicks() {
    Array.prototype.forEach.call(document.querySelectorAll('table.tbl tbody tr[data-id]'), function (tr) {
      tr.onclick = function () { openTicket(tr.getAttribute('data-id')); };
    });
  }

  /* ----------------------------- tickets ----------------------------- */
  function navLabel() {
    var r = state.user.role;
    return r === 'USER' ? 'My Tickets' : r === 'ANALYST' ? 'Assigned to me' : r === 'CBA' ? 'Cluster Tickets' : 'All Tickets';
  }
  function renderTickets() {
    call('listTickets', state.filters).then(function (res) {
      state.tickets = res.rows; state.total = res.total;
      var rows = res.rows.map(function (t) {
        return '<tr data-id="' + h(t.ticketId) + '"' + (t.slaState === 'BREACHED' ? ' class="overdue"' : '') + '>' +
          '<td class="tid">' + h(t.ticketId) + '</td>' +
          '<td><b>' + h(t.title) + '</b><div class="muted" style="font-size:12px">' + h(t.department || '') + (t.raisedByName ? ' · ' + h(t.raisedByName) : '') + '</div></td>' +
          '<td>' + priorityBadge(t.priority) + '</td><td>' + statusBadge(t.status) + '</td>' +
          '<td>' + h(t.analystEmail || '—') + '</td><td>' + slaBadge(t.slaState) + '</td>' +
          '<td class="muted" style="white-space:nowrap">' + fmt(t.updatedAt || t.createdAt) + '</td></tr>';
      }).join('');
      var pages = Math.max(1, Math.ceil(res.total / state.filters.pageSize));

      $('content').innerHTML =
        '<div class="page-head"><h2>' + h(navLabel()) + '</h2>' +
          ((state.user.role === 'USER' || state.user.role === 'CBA' || state.user.role === 'ADMIN') ? '<button class="btn primary" onclick="__setView(\'new\')">＋ Raise a ticket</button>' : '') + '</div>' +
        '<div class="toolbar">' +
          '<input id="fQ" placeholder="Search id, title, requester…" value="' + h(state.filters.q) + '">' +
          '<select id="fStatus"><option value="">All statuses</option>' +
            ['NEW','ASSIGNED','IN_PROGRESS','PENDING_APPROVAL','ON_HOLD','RESOLVED','CLOSED','REOPENED'].map(function (s) {
              return '<option value="' + s + '"' + (state.filters.status === s ? ' selected' : '') + '>' + s.replace(/_/g, ' ') + '</option>';
            }).join('') + '</select>' +
          '<select id="fPriority"><option value="">All priorities</option>' +
            ['Low','Medium','High'].map(function (p) { return '<option value="' + p + '"' + (state.filters.priority === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select>' +
          '<span class="pill">' + res.total + ' result(s)</span>' +
        '</div>' +
        '<div class="card"><div class="table-wrap">' +
          (res.rows.length ? '<table class="tbl"><thead><tr><th>ID</th><th>Title</th><th>Priority</th><th>Status</th><th>Analyst</th><th>SLA</th><th>Updated</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">No tickets found.</div>') +
        '</div></div>' +
        (pages > 1 ? '<div class="toolbar" style="justify-content:center;margin-top:14px">' +
          '<button class="btn small" id="pgPrev"' + (state.filters.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
          '<span class="pill">Page ' + state.filters.page + ' / ' + pages + '</span>' +
          '<button class="btn small" id="pgNext"' + (state.filters.page >= pages ? ' disabled' : '') + '>Next ›</button></div>' : '');

      $('fQ').oninput = debounce(function (e) { state.filters.q = e.target.value; state.filters.page = 1; renderTickets(); }, 350);
      $('fStatus').onchange = function (e) { state.filters.status = e.target.value; state.filters.page = 1; renderTickets(); };
      $('fPriority').onchange = function (e) { state.filters.priority = e.target.value; state.filters.page = 1; renderTickets(); };
      if ($('pgPrev')) $('pgPrev').onclick = function () { state.filters.page--; renderTickets(); };
      if ($('pgNext')) $('pgNext').onclick = function () { state.filters.page++; renderTickets(); };
      bindRowClicks();
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }
  window.__setView = setView;

  /* --------------------------- new ticket ---------------------------- */
  function renderNewTicket() {
    var canAssign = state.user.role === 'CBA' || state.user.role === 'ADMIN';
    $('content').innerHTML =
      '<div class="page-head"><h2>Raise a ticket</h2></div>' +
      '<div class="card" style="padding:22px;max-width:720px">' +
        '<div class="field"><label>Title</label><input id="ntTitle" placeholder="Short summary"></div>' +
        '<div class="grid2">' +
          '<div class="field"><label>Category</label><select id="ntCategory">' +
            ['Report request','Data issue','Dashboard bug','New analysis','Other'].map(function (c) { return '<option>' + c + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label>Priority</label><select id="ntPriority">' +
            ['Low','Medium','High'].map(function (p) { return '<option' + (p === (state.user.defaultPriority || 'Medium') ? ' selected' : '') + '>' + p + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label>Department</label><input id="ntDept" value="' + h(state.user.department || '') + '"></div>' +
        (canAssign ? '<div class="field"><label>Assign to</label><select id="ntAssign"><option value="">Leave unassigned</option></select>' +
          '<div class="muted" style="font-size:12px;margin-top:4px">Take it yourself, or hand it to an analyst in your cluster.</div></div>' : '') +
        '<div class="field"><label>Description</label><textarea id="ntDesc" placeholder="Describe your request in detail…"></textarea></div>' +
        '<div class="inline" style="justify-content:flex-end">' +
          '<button class="btn" id="ntCancel">Cancel</button>' +
          '<button class="btn primary" id="ntSubmit">Submit ticket</button></div>' +
      '</div>';
    $('ntCancel').onclick = function () { setView('tickets'); };
    $('ntSubmit').onclick = function () { submitTicket(false); };
    if (canAssign) {
      call('myAnalysts', {}).then(function (list) {
        var sel = $('ntAssign');
        if (!sel) return;
        sel.innerHTML = '<option value="">Leave unassigned</option>' +
          list.map(function (a) { return '<option value="' + h(a.email) + '">' + h(a.name) + ' (' + h(a.email) + ')</option>'; }).join('');
      }).catch(function () {});
    }
  }
  function submitTicket(force) {
    var b = $('ntSubmit'); b.disabled = true; b.innerHTML = spin() + ' Submitting…';
    call('createTicket', {
      title: $('ntTitle').value, category: $('ntCategory').value, priority: $('ntPriority').value,
      department: $('ntDept').value, description: $('ntDesc').value, force: force,
      assignTo: $('ntAssign') ? $('ntAssign').value : ''
    }).then(function (t) {
      if (t && t.duplicate) {
        b.disabled = false; b.textContent = 'Submit ticket';
        if (window.confirm(t.message + '\n\nCreate another anyway?')) submitTicket(true);
        return;
      }
      toast('Ticket ' + t.ticketId + ' created', 'ok');
      setView('tickets');
    }).catch(function (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Submit ticket'; });
  }

  /* ---------------------------- approvals ---------------------------- */
  function renderApprovals() {
    Promise.all([call('listReassign', {}), call('listTickets', { status: 'PENDING_APPROVAL' })]).then(function (res) {
      var reqs = res[0];
      var pending = res[1].rows.filter(function (t) { return String(t.approvalStatus).toUpperCase() === 'PENDING'; });
      state.pendingCount = reqs.filter(function (r) { return r.status === 'PENDING'; }).length;
      renderNav();

      var reqRows = reqs.map(function (r) {
        var actions = r.status === 'PENDING'
          ? '<div class="row-actions"><button class="btn success small" data-approve="' + h(r.reqId) + '">Approve</button><button class="btn danger small" data-reject="' + h(r.reqId) + '">Reject</button></div>'
          : '<span class="badge ap-' + h(r.status) + '">' + h(r.status) + '</span>';
        return '<tr><td class="tid">' + h(r.ticketId) + '</td><td>' + h(r.ticketTitle) + '</td>' +
          '<td>' + h(r.fromAnalyst) + ' → <b>' + h(r.toAnalyst) + '</b>' + (r.reason ? '<div class="muted" style="font-size:12px">' + h(r.reason) + '</div>' : '') + '</td>' +
          '<td class="muted">' + fmt(r.requestedAt) + '</td><td>' + actions + '</td></tr>';
      }).join('');

      var extRows = pending.map(function (t) {
        return '<tr data-id="' + h(t.ticketId) + '"><td class="tid">' + h(t.ticketId) + '</td><td>' + h(t.title) + '</td>' +
          '<td>' + h(t.approvedBy || '—') + '</td><td>' + approvalBadge(t.approvalStatus) + '</td><td class="muted">' + fmt(t.updatedAt) + '</td></tr>';
      }).join('');

      $('content').innerHTML =
        '<div class="page-head"><h2>Approvals</h2></div>' +
        '<div class="section"><h4>Reassignment requests</h4><div class="table-wrap">' +
          (reqs.length ? '<table class="tbl"><thead><tr><th>Ticket</th><th>Title</th><th>Move</th><th>Requested</th><th>Action</th></tr></thead><tbody>' + reqRows + '</tbody></table>' : '<div class="empty">No reassignment requests.</div>') +
        '</div></div>' +
        '<div class="section"><h4>External approvals awaiting response</h4><div class="table-wrap">' +
          (pending.length ? '<table class="tbl"><thead><tr><th>Ticket</th><th>Title</th><th>Approver</th><th>Status</th><th>Updated</th></tr></thead><tbody>' + extRows + '</tbody></table>' : '<div class="empty">No pending external approvals.</div>') +
        '</div></div>';

      Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (b) { b.onclick = function () { decideReassign(b.getAttribute('data-approve'), true); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-reject]'), function (b) { b.onclick = function () { decideReassign(b.getAttribute('data-reject'), false); }; });
      bindRowClicks();
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }
  function decideReassign(reqId, approve) {
    var note = window.prompt(approve ? 'Optional note:' : 'Reason for rejection:', '');
    if (note === null) return;
    call('decideReassign', { reqId: reqId, approve: approve, note: note })
      .then(function () { toast('Reassignment ' + (approve ? 'approved' : 'rejected'), 'ok'); renderApprovals(); })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  /* ---------------------------- reassign ----------------------------- */
  function renderReassign() {
    call('listReassign', {}).then(function (reqs) {
      var rows = reqs.map(function (r) {
        return '<tr><td class="tid">' + h(r.ticketId) + '</td><td>' + h(r.ticketTitle) + '</td>' +
          '<td>' + h(r.fromAnalyst) + ' → ' + h(r.toAnalyst) + '</td><td>' + h(r.reason || '—') + '</td>' +
          '<td><span class="badge ap-' + h(r.status) + '">' + h(r.status) + '</span></td><td class="muted">' + fmt(r.requestedAt) + '</td></tr>';
      }).join('');
      $('content').innerHTML =
        '<div class="page-head"><h2>Reassign Requests</h2></div>' +
        '<div class="card"><div class="table-wrap">' +
          (reqs.length ? '<table class="tbl"><thead><tr><th>Ticket</th><th>Title</th><th>Move</th><th>Reason</th><th>Status</th><th>Requested</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">No reassignment requests.</div>') +
        '</div></div>';
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }

  /* ---------------------------- workload ----------------------------- */
  function renderWorkload() {
    call('teamWorkload', {}).then(function (list) {
      var max = Math.max.apply(null, list.map(function (x) { return x.open; }).concat([1]));
      var rows = list.map(function (a) {
        var pct = Math.round((a.open / max) * 100);
        return '<tr><td><b>' + h(a.name) + '</b><div class="muted" style="font-size:12px">' + h(a.email) + '</div></td>' +
          '<td>' + h(a.clusterId || '—') + '</td><td><b>' + a.open + '</b></td><td>' + a.total + '</td>' +
          '<td style="min-width:160px"><div class="bars"><span style="width:' + pct + '%;background:var(--brand)"></span></div></td></tr>';
      }).join('');
      $('content').innerHTML =
        '<div class="page-head"><h2>Team Workload</h2><span class="pill">Open tickets per analyst</span></div>' +
        '<div class="card"><div class="table-wrap">' +
          (list.length ? '<table class="tbl"><thead><tr><th>Analyst</th><th>Cluster</th><th>Open</th><th>Total</th><th>Load</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">No analysts in your cluster yet.</div>') +
        '</div></div>';
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }

  /* ------------------------------ users ------------------------------ */
  function renderUsers() {
    Promise.all([call('adminUsers', {}), call('adminClusters', {})]).then(function (res) {
      var users = res[0], clusters = res[1];
      var rows = users.map(function (u) {
        return '<tr><td><b>' + h(u.name) + '</b><div class="muted" style="font-size:12px">' + h(u.email) + '</div></td>' +
          '<td>' + h(u.role) + '</td><td>' + h(u.clusterId || '—') + '</td><td>' + h(u.department || '—') + '</td>' +
          '<td>' + h(u.phone || '—') + '</td><td class="muted" style="font-size:12px">' + fmt(u.lastLoginAt) + '</td>' +
          '<td>' + (u.status === 'ACTIVE' ? '<span class="badge ap-APPROVED">Active</span>' : '<span class="badge ap-REJECTED">Inactive</span>') + '</td>' +
          '<td><button class="btn small" data-edit="' + h(u.email) + '">Edit</button></td></tr>';
      }).join('');
      $('content').innerHTML =
        '<div class="page-head"><h2>Users</h2><button class="btn primary" id="btnAddUser">＋ Add user</button></div>' +
        '<div class="card"><div class="table-wrap"><table class="tbl"><thead><tr>' +
          '<th>Name</th><th>Role</th><th>Cluster</th><th>Department</th><th>Phone</th><th>Last login</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      $('btnAddUser').onclick = function () { userModal(null, clusters); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () {
          var e = b.getAttribute('data-edit');
          userModal(users.filter(function (x) { return x.email === e; })[0], clusters);
        };
      });
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }
  function userModal(u, clusters) {
    u = u || { email: '', name: '', phone: '', department: '', role: 'USER', clusterId: '', reportsTo: '', status: 'ACTIVE', defaultPriority: 'Medium' };
    openModal('User', '' +
      '<div class="grid2"><div class="field"><label>Name</label><input id="mName" value="' + h(u.name) + '"></div>' +
      '<div class="field"><label>Email</label><input id="mEmail" value="' + h(u.email) + '"' + (u.email ? ' disabled' : '') + '></div></div>' +
      '<div class="grid2"><div class="field"><label>Role</label><select id="mRole">' +
        ['USER','CBA','ANALYST','ADMIN'].map(function (r) { return '<option' + (u.role === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
      '</select></div><div class="field"><label>Cluster</label><select id="mCluster"><option value="">—</option>' +
        clusters.map(function (c) { return '<option value="' + h(c.clusterId) + '"' + (u.clusterId === c.clusterId ? ' selected' : '') + '>' + h(c.name) + '</option>'; }).join('') +
      '</select></div></div>' +
      '<div class="grid2"><div class="field"><label>Phone</label><input id="mPhone" value="' + h(u.phone) + '"></div>' +
      '<div class="field"><label>Department</label><input id="mDept" value="' + h(u.department) + '"></div></div>' +
      '<div class="grid2"><div class="field"><label>Reports to (CBA email)</label><input id="mReports" value="' + h(u.reportsTo) + '"></div>' +
      '<div class="field"><label>Status</label><select id="mStatus">' +
        ['ACTIVE','INACTIVE'].map(function (s) { return '<option' + (u.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
      '</select></div></div>',
      '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="mSave">Save</button>');
    $('mSave').onclick = function () {
      call('adminSaveUser', { user: {
        email: $('mEmail').value, name: $('mName').value, phone: $('mPhone').value,
        department: $('mDept').value, role: $('mRole').value, clusterId: $('mCluster').value,
        reportsTo: $('mReports').value, status: $('mStatus').value
      } }).then(function () { closeModal(); toast('User saved', 'ok'); renderUsers(); })
        .catch(function (e) { toast(e.message, 'err'); });
    };
  }

  /* ---------------------------- clusters ----------------------------- */
  function renderClusters() {
    call('adminClusters', {}).then(function (list) {
      var rows = list.map(function (c) {
        return '<tr><td class="tid">' + h(c.clusterId) + '</td><td><b>' + h(c.name) + '</b></td>' +
          '<td>' + h(c.cbaEmail || '—') + '</td><td>' + h(c.status) + '</td>' +
          '<td><button class="btn small" data-edit="' + h(c.clusterId) + '">Edit</button></td></tr>';
      }).join('');
      $('content').innerHTML =
        '<div class="page-head"><h2>Clusters</h2><button class="btn primary" id="btnAddCluster">＋ Add cluster</button></div>' +
        '<div class="card"><div class="table-wrap">' +
          (list.length ? '<table class="tbl"><thead><tr><th>ID</th><th>Name</th><th>CBA</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">No clusters yet.</div>') +
        '</div></div>';
      $('btnAddCluster').onclick = function () { clusterModal(null); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () { clusterModal(list.filter(function (x) { return x.clusterId === b.getAttribute('data-edit'); })[0]); };
      });
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }
  function clusterModal(c) {
    c = c || { clusterId: '', name: '', cbaEmail: '', status: 'ACTIVE' };
    openModal('Cluster', '' +
      '<div class="field"><label>Name</label><input id="cName" value="' + h(c.name) + '"></div>' +
      '<div class="field"><label>CBA email</label><input id="cCba" value="' + h(c.cbaEmail) + '" placeholder="cba@pw.live"></div>' +
      '<div class="field"><label>Status</label><select id="cStatus">' +
        ['ACTIVE','INACTIVE'].map(function (s) { return '<option' + (c.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
      '</select></div>',
      '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="cSave">Save</button>');
    $('cSave').onclick = function () {
      call('adminSaveCluster', { cluster: { clusterId: c.clusterId, name: $('cName').value, cbaEmail: $('cCba').value, status: $('cStatus').value } })
        .then(function () { closeModal(); toast('Cluster saved', 'ok'); renderClusters(); })
        .catch(function (e) { toast(e.message, 'err'); });
    };
  }

  /* ---------------------------- activity ----------------------------- */
  function renderActivity() {
    call('adminActivity', { days: 30 }).then(function (d) {
      var rows = d.users.map(function (u) {
        var ev = Object.keys(u.byEvent || {}).map(function (k) { return '<span class="pill">' + h(k) + ': ' + u.byEvent[k] + '</span>'; }).join(' ');
        return '<tr><td><b>' + h(u.name || u.email) + '</b><div class="muted" style="font-size:12px">' + h(u.email) + '</div></td>' +
          '<td>' + h(u.role || '—') + '</td><td><b>' + u.logins + '</b></td><td><b>' + u.totalActions + '</b></td>' +
          '<td>' + u.ticketsCreated + '</td><td>' + u.comments + '</td><td class="muted">' + fmt(u.lastActive) + '</td><td>' + (ev || '—') + '</td></tr>';
      }).join('');
      $('content').innerHTML =
        '<div class="page-head"><h2>Activity (last 30 days)</h2></div>' +
        '<div class="card"><div class="table-wrap"><table class="tbl"><thead><tr>' +
          '<th>User</th><th>Role</th><th>Logins</th><th>Actions</th><th>Tickets</th><th>Comments</th><th>Last active</th><th>Events</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }

  /* ---------------------------- analytics ---------------------------- */
  function renderAnalytics() {
    call('adminAnalytics', { days: 30 }).then(function (d) {
      var t = d.totals;
      var cards = [{ n: t.total, l: 'Tickets (30d)' }, { n: t.open, l: 'Open' }, { n: t.resolved, l: 'Resolved' }, { n: t.overdue, l: 'Overdue' }];
      var trendKeys = Object.keys(d.trend).sort();
      var maxT = Math.max.apply(null, trendKeys.map(function (k) { return d.trend[k]; }).concat([1]));
      var chart = trendKeys.map(function (k) { return '<div class="bar" style="height:' + Math.round((d.trend[k] / maxT) * 100) + '%" data-v="' + h(k) + ': ' + d.trend[k] + '"></div>'; }).join('');
      function tableFrom(obj, label) {
        var keys = Object.keys(obj);
        if (!keys.length) return '<p class="muted">No data.</p>';
        return '<table class="tbl"><thead><tr><th>' + label + '</th><th>Value</th></tr></thead><tbody>' +
          keys.map(function (k) { return '<tr><td>' + h(k) + '</td><td><b>' + h(obj[k]) + '</b></td></tr>'; }).join('') + '</tbody></table>';
      }
      var active = d.mostActive.slice(0, 8).map(function (u) { return '<tr><td>' + h(u.name || u.email) + '</td><td>' + h(u.role) + '</td><td>' + u.logins + '</td><td>' + u.totalActions + '</td></tr>'; }).join('');
      var inactive = d.inactiveMembers.map(function (u) { return '<tr><td>' + h(u.name) + '</td><td>' + h(u.email) + '</td><td>' + h(u.role) + '</td><td class="muted">' + fmt(u.lastLoginAt) + '</td></tr>'; }).join('');

      $('content').innerHTML =
        '<div class="page-head"><h2>Analytics</h2><div class="inline">' +
          '<button class="btn small" id="expTickets">Export tickets CSV</button>' +
          '<button class="btn small" id="expLogs">Export logs CSV</button></div></div>' +
        '<div class="stats">' + cards.map(function (c) { return '<div class="stat"><div class="num">' + c.n + '</div><div class="lbl">' + h(c.l) + '</div></div>'; }).join('') + '</div>' +
        '<div class="section"><h4>Daily trend</h4><div class="chart">' + (chart || '<span class="muted">No data</span>') + '</div></div>' +
        '<div class="grid2"><div class="section"><h4>By status</h4>' + tableFrom(d.byStatus, 'Status') + '</div>' +
        '<div class="section"><h4>By priority</h4>' + tableFrom(d.byPriority, 'Priority') + '</div></div>' +
        '<div class="grid2"><div class="section"><h4>By cluster</h4>' + tableFrom(d.byCluster, 'Cluster') + '</div>' +
        '<div class="section"><h4>By category</h4>' + tableFrom(d.byCategory, 'Category') + '</div></div>' +
        '<div class="grid2"><div class="section"><h4>Avg first-assign (hrs) by CBA</h4>' + tableFrom(d.avgFirstAssignHrsByCba, 'CBA') + '</div>' +
        '<div class="section"><h4>Avg resolution (hrs) by analyst</h4>' + tableFrom(d.avgResolveHrsByAnalyst, 'Analyst') + '</div></div>' +
        '<div class="section"><h4>Avg rating by analyst</h4>' + tableFrom(d.avgRatingByAnalyst, 'Analyst') + '</div>' +
        '<div class="section"><h4>Most active (30d)</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Logins</th><th>Actions</th></tr></thead><tbody>' + (active || '<tr><td colspan="4" class="muted">No data</td></tr>') + '</tbody></table></div></div>' +
        '<div class="section"><h4>Inactive members (15+ days)</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th></tr></thead><tbody>' + (inactive || '<tr><td colspan="4" class="muted">None</td></tr>') + '</tbody></table></div></div>';

      $('expTickets').onclick = function () { exportCsv('tickets'); };
      $('expLogs').onclick = function () { exportCsv('logs'); };
    }).catch(function (e) { $('content').innerHTML = '<div class="empty">' + h(e.message) + '</div>'; });
  }
  function exportCsv(type) {
    call('adminExportCsv', { type: type }).then(function (r) {
      var blob = new Blob([r.csv], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = r.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('Downloaded ' + r.filename, 'ok');
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  /* --------------------------- ticket drawer ------------------------- */
  function openTicket(id) {
    $('drawer').classList.remove('hidden');
    $('drawerPanel').innerHTML = '<div class="drawer-body"><div class="loading">' + spin() + ' Loading…</div></div>';
    call('getTicket', { ticketId: id }).then(renderTicketDetail)
      .catch(function (e) { $('drawerPanel').innerHTML = '<div class="drawer-body"><div class="empty">' + h(e.message) + '</div></div>'; });
  }
  function closeDrawer() { $('drawer').classList.add('hidden'); $('drawerPanel').innerHTML = ''; }

  function renderTicketDetail(t) {
    var u = state.user, role = u.role;
    var isCba = role === 'CBA' || role === 'ADMIN';
    var isAssignee = !!t.analystEmail && t.analystEmail === u.email;
    var isOwner = t.raisedByEmail === u.email;

    var actions = [];
    if (isCba && ['CLOSED','RESOLVED'].indexOf(t.status) < 0) {
      actions.push('<button class="btn primary small" id="actAssign">' + (t.analystEmail ? 'Reassign' : 'Assign / take') + '</button>');
      actions.push('<button class="btn small" id="actApproval">Request external approval</button>');
    }
    if (isAssignee) {
      if (['ASSIGNED','NEW','REOPENED'].indexOf(t.status) >= 0) actions.push('<button class="btn primary small" id="actStart">Start work</button>');
      if (t.status === 'IN_PROGRESS') {
        actions.push('<button class="btn small" id="actHold">Put on hold</button>');
        actions.push('<button class="btn success small" id="actResolve">Mark resolved</button>');
      }
      if (t.status === 'ON_HOLD') actions.push('<button class="btn primary small" id="actResume">Resume</button>');
      if (role === 'ANALYST' && t.status !== 'CLOSED') actions.push('<button class="btn small" id="actReassign">Request reassignment</button>');
    }
    if (isOwner && t.status === 'RESOLVED') actions.push('<button class="btn success small" id="actClose">Accept &amp; close</button>');
    if (isOwner && ['RESOLVED','CLOSED'].indexOf(t.status) >= 0) actions.push('<button class="btn small" id="actReopen">Reopen</button>');
    if (isOwner && t.status === 'CLOSED' && !t.rating) actions.push('<button class="btn primary small" id="actRate">Rate this ticket</button>');

    var approvals = (t.approvals || []).length ? t.approvals.map(function (a) {
      return '<div class="comment"><div class="c-top"><span>' + h(a.approverEmail) + '</span>' + approvalBadge(a.status) + '</div>' +
        '<div class="c-body muted">' + (a.note ? 'Note: ' + h(a.note) + '<br>' : '') +
        'Requested by ' + h(a.requestedBy) + ' · ' + fmt(a.requestedAt) + (a.decidedAt ? '<br>Decided ' + fmt(a.decidedAt) : '') +
        (a.decisionNote ? '<br>Comment: ' + h(a.decisionNote) : '') + '</div></div>';
    }).join('') : '<p class="muted">No approval requests yet.</p>';

    var reassigns = (t.reassignRequests || []).length ? t.reassignRequests.map(function (r) {
      return '<div class="comment"><div class="c-top"><span>' + h(r.fromAnalyst) + ' → ' + h(r.toAnalyst) + '</span><span class="badge ap-' + h(r.status) + '">' + h(r.status) + '</span></div>' +
        '<div class="c-body muted">' + (r.reason ? h(r.reason) + ' · ' : '') + fmt(r.requestedAt) + '</div></div>';
    }).join('') : '';

    var comments = (t.comments || []).length ? t.comments.map(function (c) {
      return '<div class="comment"><div class="c-top"><span>' + h(c.byName || c.byEmail) + '</span><span class="muted">' + fmt(c.at) + '</span></div><div class="c-body">' + h(c.text) + '</div></div>';
    }).join('') : '<p class="muted">No comments yet.</p>';

    var timeline = (t.logs || []).map(function (l) {
      var diff = (l.oldValue || l.newValue) ? ' (' + h(l.oldValue || '—') + ' → ' + h(l.newValue || '—') + ')' : '';
      return '<li><div class="tl-top"><span class="tl-what">' + h(l.action) + '</span><span class="tl-when">' + fmt(l.at) + '</span></div>' +
        '<div class="tl-det">' + h(l.byEmail) + (l.byRole ? ' · ' + h(l.byRole) : '') + diff + (l.note ? ' — ' + h(l.note) : '') + '</div></li>';
    }).join('') || '<li><div class="tl-det">No activity yet.</div></li>';

    $('drawerPanel').innerHTML =
      '<div class="drawer-head"><div><div class="tid">' + h(t.ticketId) + '</div>' +
        '<h3 style="margin:4px 0 0">' + h(t.title) + '</h3>' +
        '<div class="inline" style="margin-top:8px">' + statusBadge(t.status) + priorityBadge(t.priority) + slaBadge(t.slaState) + '<span class="pill">' + h(t.category) + '</span></div></div>' +
        '<button class="close-x" data-close-drawer>✕</button></div>' +
      '<div class="drawer-body">' +
        '<div class="section"><h4>Details</h4><div class="kv">' +
          '<div class="k">Requester</div><div class="v">' + h(t.raisedByName) + ' (' + h(t.raisedByEmail) + ')</div>' +
          '<div class="k">Contact</div><div class="v">' + h(t.raisedByPhone || '—') + '</div>' +
          '<div class="k">Department</div><div class="v">' + h(t.department || '—') + '</div>' +
          '<div class="k">Cluster</div><div class="v">' + h(t.clusterId || '—') + '</div>' +
          '<div class="k">Analyst</div><div class="v">' + h(t.analystEmail || 'Unassigned') + '</div>' +
          '<div class="k">Approval</div><div class="v">' + approvalBadge(t.approvalStatus) + (t.approvedBy ? ' by ' + h(t.approvedBy) : '') + '</div>' +
          '<div class="k">Due by</div><div class="v">' + fmt(t.dueAt) + '</div>' +
          '<div class="k">Created</div><div class="v">' + fmt(t.createdAt) + '</div>' +
          (t.rating ? '<div class="k">Rating</div><div class="v">' + h(t.rating) + '/5 ' + h(t.feedback || '') + '</div>' : '') +
        '</div><p style="white-space:pre-wrap;margin-top:12px">' + h(t.description) + '</p></div>' +
        (actions.length ? '<div class="section"><h4>Actions</h4><div class="row-actions">' + actions.join('') + '</div></div>' : '') +
        '<div class="section"><h4>External approvals</h4>' + approvals + '</div>' +
        (reassigns ? '<div class="section"><h4>Reassignment requests</h4>' + reassigns + '</div>' : '') +
        '<div class="section"><h4>Comments</h4>' + comments +
          '<div class="field" style="margin-top:12px"><textarea id="cmtBody" placeholder="Add a comment…"></textarea></div>' +
          '<div class="inline" style="justify-content:flex-end"><button class="btn primary small" id="cmtSend">Add comment</button></div></div>' +
        '<div class="section"><h4>Activity log</h4><ul class="timeline">' + timeline + '</ul></div>' +
      '</div>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-close-drawer]'), function (x) { x.onclick = closeDrawer; });
    $('cmtSend').onclick = function () {
      call('addComment', { ticketId: t.ticketId, text: $('cmtBody').value })
        .then(function () { toast('Comment added', 'ok'); openTicket(t.ticketId); })
        .catch(function (e) { toast(e.message, 'err'); });
    };
    if ($('actAssign')) $('actAssign').onclick = function () { assignModal(t); };
    if ($('actApproval')) $('actApproval').onclick = function () { approvalModal(t); };
    if ($('actReassign')) $('actReassign').onclick = function () { reassignModal(t); };
    if ($('actStart')) $('actStart').onclick = function () { doStatus(t, 'IN_PROGRESS'); };
    if ($('actHold')) $('actHold').onclick = function () { doStatus(t, 'ON_HOLD'); };
    if ($('actResume')) $('actResume').onclick = function () { doStatus(t, 'IN_PROGRESS'); };
    if ($('actResolve')) $('actResolve').onclick = function () { doStatus(t, 'RESOLVED'); };
    if ($('actClose')) $('actClose').onclick = function () { doClose(t); };
    if ($('actReopen')) $('actReopen').onclick = function () { doReopen(t); };
    if ($('actRate')) $('actRate').onclick = function () { rateModal(t); };
  }
  function doStatus(t, status) {
    call('updateStatus', { ticketId: t.ticketId, status: status })
      .then(function () { toast('Status updated', 'ok'); openTicket(t.ticketId); })
      .catch(function (e) { toast(e.message, 'err'); });
  }
  function doClose(t) {
    call('closeTicket', { ticketId: t.ticketId })
      .then(function () { toast('Ticket closed', 'ok'); openTicket(t.ticketId); })
      .catch(function (e) { toast(e.message, 'err'); });
  }
  function doReopen(t) {
    var reason = window.prompt('Reason for reopening:', '');
    if (reason === null) return;
    call('reopenTicket', { ticketId: t.ticketId, reason: reason })
      .then(function () { toast('Ticket reopened', 'ok'); openTicket(t.ticketId); })
      .catch(function (e) { toast(e.message, 'err'); });
  }
  function rateModal(t) {
    openModal('Rate this ticket', '' +
      '<div class="field"><label>Rating (1–5)</label><select id="rVal">' +
        [5,4,3,2,1].map(function (n) { return '<option value="' + n + '">' + n + ' ★</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Feedback (optional)</label><textarea id="rFb"></textarea></div>',
      '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="rGo">Submit</button>');
    $('rGo').onclick = function () {
      call('rateTicket', { ticketId: t.ticketId, rating: $('rVal').value, feedback: $('rFb').value })
        .then(function () { closeModal(); toast('Thanks for the feedback', 'ok'); openTicket(t.ticketId); })
        .catch(function (e) { toast(e.message, 'err'); });
    };
  }
  function assignModal(t) {
    call('myAnalysts', {}).then(function (analysts) {
      if (!analysts.length) { toast('No analysts in this cluster yet.', 'err'); return; }
      openModal('Assign / take ticket', '<p class="muted">Ticket ' + h(t.ticketId) + ' · ' + h(t.clusterId) + '</p>' +
        '<div class="field"><label>Assign to</label><select id="selAnalyst">' +
          analysts.map(function (a) { return '<option value="' + h(a.email) + '">' + h(a.name) + ' (' + h(a.email) + ')</option>'; }).join('') +
        '</select></div><div class="field"><label>Note (optional)</label><input id="assignNote"></div>',
        '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="assignGo">Assign</button>');
      $('assignGo').onclick = function () {
        call('assignTicket', { ticketId: t.ticketId, analystEmail: $('selAnalyst').value, note: $('assignNote').value })
          .then(function () { closeModal(); toast('Ticket assigned', 'ok'); openTicket(t.ticketId); refreshBadge(); })
          .catch(function (e) { toast(e.message, 'err'); });
      };
    });
  }
  function reassignModal(t) {
    call('myAnalysts', {}).then(function (analysts) {
      var others = analysts.filter(function (a) { return a.email !== state.user.email; });
      if (!others.length) { toast('No other analysts available.', 'err'); return; }
      openModal('Request reassignment', '<p class="muted">This goes to your CBA for approval.</p>' +
        '<div class="field"><label>Reassign to</label><select id="selTo">' +
          others.map(function (a) { return '<option value="' + h(a.email) + '">' + h(a.name) + ' (' + h(a.email) + ')</option>'; }).join('') +
        '</select></div><div class="field"><label>Reason</label><textarea id="reassignReason"></textarea></div>',
        '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="reassignGo">Send request</button>');
      $('reassignGo').onclick = function () {
        call('requestReassign', { ticketId: t.ticketId, toAnalystEmail: $('selTo').value, reason: $('reassignReason').value })
          .then(function () { closeModal(); toast('Reassignment requested', 'ok'); openTicket(t.ticketId); })
          .catch(function (e) { toast(e.message, 'err'); });
      };
    });
  }
  function approvalModal(t) {
    openModal('Request external approval', '<p class="muted">The approver receives an email with a secure link to approve or reject.</p>' +
      '<div class="field"><label>Approver email</label><input id="apEmail" placeholder="approver@pw.live"></div>' +
      '<div class="field"><label>Note / what needs approval</label><textarea id="apReason"></textarea></div>',
      '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="apGo">Send request</button>');
    $('apGo').onclick = function () {
      call('requestApproval', { ticketId: t.ticketId, approverEmail: $('apEmail').value, note: $('apReason').value })
        .then(function (r) {
          closeModal();
          toast('Approval request sent to ' + r.approverEmail, 'ok');
          openTicket(t.ticketId);
        })
        .catch(function (e) { toast(e.message, 'err'); });
    };
  }

  /* --------------------------- approval page ------------------------- */
  function showApproval() {
    $('authScreen').classList.add('hidden');
    $('mainScreen').classList.add('hidden');
    $('drawer').classList.add('hidden');
    $('approvalScreen').classList.remove('hidden');
    loadApproval();
  }
  function loadApproval() {
    var ap = state.approval;
    $('approvalBody').innerHTML = '<div class="loading">' + spin() + ' Loading…</div>';
    API.call('getApproval', null, { t: ap.token, a: ap.id }).then(function (res) {
      if (!res.ok) { $('approvalBody').innerHTML = '<div class="empty">' + h(res.error) + '</div>'; return; }
      var info = res.data;
      var tk = info.ticket || {};
      var body =
        '<div class="brand"><div class="brand-mark">PW</div><div><h1>Approval request</h1><p class="muted">' + h(info.approvalId) + '</p></div></div>' +
        '<div class="kv">' +
          '<div class="k">Ticket</div><div class="v">' + h(tk.ticketId) + '</div>' +
          '<div class="k">Title</div><div class="v">' + h(tk.title) + '</div>' +
          '<div class="k">Priority</div><div class="v">' + priorityBadge(tk.priority) + '</div>' +
          '<div class="k">Requester</div><div class="v">' + h(tk.raisedByName) + ' (' + h(tk.raisedByEmail) + ')</div>' +
          '<div class="k">Contact</div><div class="v">' + h(tk.raisedByPhone || '—') + '</div>' +
          '<div class="k">Note</div><div class="v">' + h(info.note || '—') + '</div>' +
        '</div>' +
        '<div class="section"><p style="white-space:pre-wrap;margin:0">' + h(tk.description) + '</p></div>';

      if (!info.canDecide) {
        body += '<div class="section"><b>This request is ' + h(String(info.status).toLowerCase()) + '</b>' +
          (info.decidedAt ? ' on ' + fmt(info.decidedAt) : '') +
          (info.decisionNote ? '<div class="muted">Comment: ' + h(info.decisionNote) + '</div>' : '') + '</div>' +
          '<div class="inline" style="margin-top:8px"><a class="btn" href="#" onclick="location.hash=\'\';location.reload();return false;">Back to portal</a></div>';
      } else {
        body += '<div class="field"><label>Comments (optional)</label><textarea id="apComments"></textarea></div>' +
          '<div class="inline"><button class="btn success" id="apApprove">✓ Approve</button><button class="btn danger" id="apReject">✕ Reject</button></div>';
      }
      $('approvalBody').innerHTML = body;
      if (info.canDecide) {
        $('apApprove').onclick = function () { submitApproval('APPROVED'); };
        $('apReject').onclick = function () { submitApproval('REJECTED'); };
      }
    });
  }
  function submitApproval(decision) {
    API.call('decideApproval', null, {
      t: state.approval.token, a: state.approval.id, decision: decision,
      note: $('apComments') ? $('apComments').value : ''
    }).then(function (res) {
      if (!res.ok) { toast(res.error, 'err'); return; }
      toast('Thank you — response recorded', 'ok');
      loadApproval();
    });
  }

  /* ------------------------------ modal ------------------------------ */
  function openModal(title, body, footer) {
    $('modal').classList.remove('hidden');
    $('modalPanel').innerHTML =
      '<div class="modal-head"><h3 style="margin:0">' + h(title) + '</h3><button class="close-x" data-close-modal>✕</button></div>' +
      '<div class="modal-body">' + body + '</div><div class="modal-foot">' + (footer || '') + '</div>';
    Array.prototype.forEach.call($('modalPanel').querySelectorAll('[data-close-modal]'), function (x) { x.onclick = closeModal; });
  }
  function closeModal() { $('modal').classList.add('hidden'); $('modalPanel').innerHTML = ''; }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-close-modal')) closeModal();
    if (t.hasAttribute && t.hasAttribute('data-close-drawer')) closeDrawer();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

  /* ------------------------------ start ------------------------------ */
  boot();
})();
