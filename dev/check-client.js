/**
 * dev/check-client.js
 * Static contract checks between the static front-end and the Apps Script API:
 *   1. every call('name') in js/ui.js exists in PUBLIC_API or PRIVATE_API (backend/Api.gs)
 *   2. every <script src="..."> in index.html exists as a file
 *   3. every $('id') the client looks up exists in index.html (soft warning)
 *
 *   node dev/check-client.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let fail = 0;
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (m) => console.log('  ' + C.g + '✓' + C.x + ' ' + m);
const bad = (m) => { fail++; console.log('  ' + C.r + '✗ ' + m + C.x); };
const warn = (m) => console.log('  ' + C.y + '!' + C.x + ' ' + m);

/* ---------- extract router keys from backend/Api.gs ---------- */
function blockKeys(src, varName) {
  const start = src.indexOf('var ' + varName + ' = {');
  if (start < 0) return [];
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  const body = src.slice(i + 1, end);
  const keys = [];
  const re = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys;
}

const apiSrc = read('backend/Api.gs');
const publicKeys = blockKeys(apiSrc, 'PUBLIC_API');
const privateKeys = blockKeys(apiSrc, 'PRIVATE_API');
const allKeys = new Set([...publicKeys, ...privateKeys]);

console.log(C.b + '\nClient ↔ server contract check' + C.x);

/* ---------- 1. call('name') ---------- */
console.log('\n' + C.b + '▸ API calls used by the client' + C.x);
const uiJs = read('js/ui.js');
const calls = new Set();
const callRe = /call\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
let cm;
while ((cm = callRe.exec(uiJs))) calls.add(cm[1]);
// direct API.call('name', ...) sites too
const directRe = /API\.call\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
while ((cm = directRe.exec(uiJs))) calls.add(cm[1]);

if (!calls.size) bad('no call() sites found — did the client change?');
[...calls].sort().forEach((name) => {
  if (allKeys.has(name)) ok("call('" + name + "') is routed");
  else bad("call('" + name + "') has NO route in backend/Api.gs");
});

/* ---------- 2. <script src> ---------- */
console.log('\n' + C.b + '▸ Script includes' + C.x);
const index = read('index.html');
const srcRe = /<script[^>]*\ssrc="([^"]+)"/g;
let sm;
const srcs = [];
while ((sm = srcRe.exec(index))) srcs.push(sm[1]);
srcs.forEach((src) => {
  if (/^https?:/.test(src)) { ok('external script ' + src); return; }
  if (fs.existsSync(path.join(ROOT, src))) ok('script ' + src);
  else bad('missing script ' + src);
});

/* ---------- 3. $('id') lookups (soft) ---------- */
console.log('\n' + C.b + '▸ Element ids referenced by the client' + C.x);
const ids = new Set();
const idRe = /\$\('([A-Za-z0-9_]+)'\)/g;
let idm;
while ((idm = idRe.exec(uiJs))) ids.add(idm[1]);

// ids that the client itself creates dynamically (in innerHTML templates)
const dynamic = new Set();
const dynRe = /id="([A-Za-z0-9_]+)"/g;
let dm;
while ((dm = dynRe.exec(uiJs))) dynamic.add(dm[1]);
const dynRe2 = /id=\\'([A-Za-z0-9_]+)\\'/g;
while ((dm = dynRe2.exec(uiJs))) dynamic.add(dm[1]);

const missing = [];
ids.forEach((id) => {
  const inIndex = new RegExp('id="' + id + '"').test(index);
  if (!inIndex && !dynamic.has(id)) missing.push(id);
});
if (missing.length) warn('ids not found in index.html or client templates: ' + missing.join(', '));
else ok('all ' + ids.size + ' referenced ids resolve (index.html or client templates)');

/* ---------- summary ---------- */
console.log('\n' + C.b + '────────────────────────────' + C.x);
if (fail) { console.log(C.r + fail + ' contract problem(s) found.' + C.x); process.exit(1); }
console.log(C.g + 'Contract OK ✓' + C.x);
