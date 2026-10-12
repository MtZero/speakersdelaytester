// 开发用，不部署。只依赖 Node 内置模块，不是"外部库"。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// audio.js 也一起加载：它在顶层不碰 document / AudioContext，所以在裸 vm 里能安全求值，
// 顺带把它的语法错误挡在提交之前。
const APP_SCRIPTS = ['i18n.js', 'timing.js', 'audio.js'];

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

// 一条都没跑也算失败 —— 否则 tests.js 被改坏成空文件时，这个运行器会安静地报"全绿"
if (!results.length) {
  console.log('no tests ran');
  process.exit(1);
}

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
