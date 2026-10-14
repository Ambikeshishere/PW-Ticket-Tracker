/* ============================================================
   api.js — network client for the Apps Script JSON backend
   The UI only ever calls API.call(name, token, payload), which
   returns a Promise resolving to { ok:true, data } or
   { ok:false, error }.

   Transport: POST with Content-Type text/plain (a "simple
   request", so no CORS pre-flight), falling back to a JSONP GET
   when POST is blocked.
   ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.PW_CONFIG || {};
  var API_URL = String(cfg.API_URL || '').trim();

  // Allow ?api=<url> to override for local development / testing.
  try {
    var q = new URLSearchParams(global.location.search);
    if (q.get('api')) API_URL = q.get('api');
  } catch (e) { /* ignore */ }

  function postJson(body) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function jsonp(body) {
    return new Promise(function (resolve, reject) {
      var cb = 'pwcb_' + Math.random().toString(36).slice(2);
      var url = API_URL +
        '?api=' + encodeURIComponent(body.api) +
        '&token=' + encodeURIComponent(body.token || '') +
        '&payload=' + encodeURIComponent(JSON.stringify(body.payload || {})) +
        '&callback=' + cb;
      var s = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('Request timed out.')); }, 30000);
      function cleanup() {
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
      }
      global[cb] = function (res) { cleanup(); resolve(res); };
      s.onerror = function () { cleanup(); reject(new Error('Network error.')); };
      s.src = url;
      document.head.appendChild(s);
    });
  }

  var API = {
    url: API_URL,
    call: function (name, token, payload) {
      if (!API_URL) {
        return Promise.resolve({
          ok: false,
          error: 'API URL is not configured. Set PW_CONFIG.API_URL in js/config.js.'
        });
      }
      var body = { api: name, token: token || '', payload: payload || {} };
      return postJson(body)
        .catch(function () { return jsonp(body); })   // POST blocked -> JSONP
        .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; });
    }
  };

  global.API = API;
})(window);
