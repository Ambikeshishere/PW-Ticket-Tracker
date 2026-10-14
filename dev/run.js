/**
 * dev/run.js
 * Loads the real .gs files into a mocked Apps Script context and runs the tests.
 *
 *   node dev/run.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildGlobals } = require('./mock');

const ROOT = path.join(__dirname, '..', 'appsscript');

// Load order matters only where a file reads another at load time
// (Setup.gs reads SHEETS from Config.gs), so Config/Db/Setup come first.
const FILES = [
  'Config.gs', 'Db.gs', 'Setup.gs', 'Mail.gs', 'Auth.gs',
  'Tickets.gs', 'Approvals.gs', 'Reassign.gs', 'Admin.gs', 'Triggers.gs', 'Code.gs',
];

/* --------------------------- test framework --------------------------- */
let pass = 0, fail = 0;
const failures = [];
const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

const t = {
  section(name) { console.log('\n' + C.b + '▸ ' + name + C.x); },
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ' + C.g + '✓' + C.x + ' ' + name); }
    else { fail++; failures.push(name); console.log('  ' + C.r + '✗ ' + name + C.x + (extra ? C.d + ' — ' + extra + C.x : '')); }
  },
  eq(name, a, b) { t.ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); },
  throws(name, fn, match) {
    try { fn(); t.ok(name, false, 'did not throw'); }
    catch (e) {
      const msg = String(e && e.message ? e.message : e);
      t.ok(name, !match || msg.toLowerCase().includes(String(match).toLowerCase()), 'threw: ' + msg);
    }
  },
};

/* ------------------------------ bootstrap ----------------------------- */
const globals = buildGlobals();
const ctx = vm.createContext(globals);

for (const f of FILES) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.error(C.r + 'Failed to load ' + f + ': ' + e.message + C.x);
    process.exit(1);
  }
}

/* -------------------------------- run --------------------------------- */
console.log(C.b + '\nPW Ticket Portal — backend test suite' + C.x);

try {
  require('./tests')(ctx, t);
} catch (e) {
  console.error(C.r + '\nUnexpected error: ' + (e && e.stack ? e.stack : e) + C.x);
  process.exit(1);
}

console.log('\n' + C.b + '────────────────────────────' + C.x);
console.log(C.b + 'Passed: ' + C.g + pass + C.x + C.b + '   Failed: ' + (fail ? C.r : C.g) + fail + C.x);
if (fail) {
  console.log(C.r + '\nFailures:' + C.x);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(C.g + '\nAll good ✓' + C.x);
