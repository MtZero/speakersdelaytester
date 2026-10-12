'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SCRIPTS = ['i18n.js', 'timing.js'];

const sandbox = { console: console };
vm.createContext(sandbox);
sandbox.window = sandbox;           // 应用脚本用 root.SDT 挂载，浏览器里 root 是 window

for (const file of APP_SCRIPTS) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;   // 允许先写测试、后写实现
  vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: file });
}

if (!sandbox.SDT) sandbox.SDT = {};

const results = [];
sandbox.SDT.test = {
  run(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'tests.js'), 'utf8'), sandbox, { filename: 'tests.js' });

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log('  ok  ' + r.name);
  } else {
    failed++;
    console.log(' FAIL ' + r.name + '\n        ' + r.error);
  }
}
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
