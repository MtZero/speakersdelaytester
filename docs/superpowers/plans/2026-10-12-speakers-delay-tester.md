# 无线耳机延迟测试器 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯静态网页测出蓝牙耳机的音频延迟 —— 页面按固定节奏播放“滴嗒嗒哒”，用户调整提前量直到听觉与视觉指示器重合。

**Architecture:** 以 `AudioContext.currentTime` 为唯一主时钟，音频用前瞻调度器排进音频硬件的采样级时间轴，视觉指示器用 `requestAnimationFrame` 读同一个时钟渲染。所有不碰 DOM 和音频硬件的计时数学抽到一个纯函数模块里，这样它既能在浏览器里测、也能在 Node 里测。

**Tech Stack:** 原生 HTML/CSS/JavaScript，无框架、无构建工具、无外部依赖。测试用一个零依赖的断言文件，通过 Node 的 `vm` 模块在终端里跑，同一个文件也供浏览器自检页使用。

**设计文档:** `docs/superpowers/specs/2026-10-12-speakers-delay-tester-design.md`

**与设计文档的两处差异（有意为之）：**
1. 新增 `timing.js`（纯计时数学）。设计文档 §3 原列 5 个文件，把计时数学放在 `app.js` 里。抽出来是为了让 §12 要求的那批测试能在 Node 里真正跑起来 —— 跑不了的测试等于没有测试。
2. 开发期的 Node 测试运行器放在 `tools/`，不参与部署。它用的是 Node 内置模块，不属于"外部库"。

---

## 文件结构

| 文件 | 职责 | 是否部署 |
|---|---|---|
| `index.html` | 只有结构，无逻辑 | ✅ |
| `styles.css` | 全部样式与响应式 | ✅ |
| `i18n.js` | 文案表、`resolve()`、`t()`、`apply()` | ✅ |
| `timing.js` | 纯计时数学，不碰 DOM / AudioContext | ✅ |
| `audio.js` | AudioContext 生命周期、音色合成、前瞻调度器 | ✅ |
| `app.js` | 拍时钟、指示器渲染、控件接线、总装 | ✅ |
| `tests.html` | 浏览器自检页 | ✅ |
| `tests.js` | 断言，浏览器与 Node 共用 | ✅ |
| `tools/run-tests.js` | Node 运行器 | ❌ 开发用 |

各文件对外接口（全部挂在 `window.SDT` 上）：

```
SDT.timing.cycleMs(beatMs, beats)              -> number
SDT.timing.sweepMs(beatMs, segments)           -> number
SDT.timing.delayMax(beatMs)                    -> number
SDT.timing.startLeadMs(beatMs)                 -> number
SDT.timing.visualOffsetMs(n, beatMs)           -> number
SDT.timing.audioOffsetMs(n, beatMs, delayMs)   -> number
SDT.timing.firstFutureIndex(nowMs, originMs, delayMs, beatMs) -> number
SDT.timing.resumeIndex(nextIndex, cancelled, nowMs, originMs, delayMs, beatMs) -> number
SDT.timing.pendingBeats(nextIndex, nowMs, originMs, delayMs, beatMs, horizonMs) -> {indices, nextIndex}
SDT.timing.clampDelay(v, max)                  -> number
SDT.timing.dotPosition(i, segments)            -> number   // 0..1
SDT.timing.beatAgeMs(tMs, i, beatMs, cycle)    -> number
SDT.timing.needles(tMs, beatMs, beats, segments) -> Array(3) of {k, position, opacity} | null

SDT.i18n.strings                               -> {zh:{...}, en:{...}}
SDT.i18n.resolve(stored, navLang)              -> 'zh' | 'en'
SDT.i18n.t(key, lang)                          -> string
SDT.i18n.detect()                              -> 'zh' | 'en'   // 读 localStorage + navigator
SDT.i18n.apply(lang, rootEl)                   -> void          // 写 DOM
SDT.i18n.save(lang)                            -> void

SDT.audio.isSupported()                        -> boolean
SDT.audio.init()                               -> AudioContext
SDT.audio.currentTime()                        -> number  // 秒
SDT.audio.schedule(beatIndex, atSeconds)       -> void
SDT.audio.cancelPending()                      -> number[]  // 被取消的拍号
SDT.audio.prune()                              -> void
SDT.audio.suspend() / resume()                 -> void
SDT.audio.state()                              -> string
```

---

## Task 1: 纯计时数学 + Node 测试运行器

这是整个应用里最容易出错、也最值得测的部分：拍时刻换算、延迟重排、扫描头区间。

**Files:**
- Create: `tools/run-tests.js`
- Create: `tests.js`
- Create: `timing.js`

- [ ] **Step 1: 写 Node 测试运行器**

`tools/run-tests.js` 把应用脚本加载进一个 `vm` 沙箱（因为它们只碰 `window.SDT`，不碰 DOM），然后跑 `tests.js` 里的断言。缺文件时跳过而不报错，这样"先写测试后写实现"的流程能跑通。

```js
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
```

- [ ] **Step 2: 写第一组失败的测试**

创建 `tests.js`。它必须在浏览器和 Node 沙箱里都能跑，所以只依赖 `root.SDT`，不依赖 `document`。

```js
(function (root) {
  'use strict';

  const SDT = root.SDT;
  const T = SDT.timing;          // Task 1 里还不存在 —— 这一步就是要看它失败
  const run = SDT.test.run;

  function eq(actual, expected, what) {
    if (actual !== expected) {
      throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) +
                      ', got ' + JSON.stringify(actual));
    }
  }

  function close(actual, expected, tol, what) {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
      throw new Error((what || 'value') + ': expected ' + expected + ' ±' + tol +
                      ', got ' + JSON.stringify(actual));
    }
  }

  // ─────────── 拍时刻换算 ───────────

  run('visualOffsetMs: 第 0 拍落在 1 个拍间隔处，最左那段是留白', function () {
    eq(T.visualOffsetMs(0, 500), 500);
    eq(T.visualOffsetMs(1, 500), 1000);
    eq(T.visualOffsetMs(4, 500), 2500);
  });

  run('audioOffsetMs: 延迟只把音频往前挪，不动视觉', function () {
    eq(T.audioOffsetMs(0, 500, 0), 500);
    eq(T.audioOffsetMs(0, 500, 200), 300);
    eq(T.audioOffsetMs(4, 500, 200), 2300);
  });

  run('派生常量', function () {
    eq(T.cycleMs(500, 4), 2000);
    eq(T.sweepMs(500, 5), 2500);
    eq(T.delayMax(500), 500);
    eq(T.startLeadMs(500), 1100);
  });

  // ─────────── 延迟钳制 ───────────

  run('clampDelay: 上下界、取整、非法输入', function () {
    eq(T.clampDelay(0, 500), 0);
    eq(T.clampDelay(500, 500), 500);
    eq(T.clampDelay(501, 500), 500);
    eq(T.clampDelay(-5, 500), 0);
    eq(T.clampDelay(12.4, 500), 12);
    eq(T.clampDelay(12.6, 500), 13);
    eq(T.clampDelay(NaN, 500), 0);
    eq(T.clampDelay(undefined, 500), 0);
    eq(T.clampDelay(Infinity, 500), 0);
    // 输入框递过来的是字符串，不能因为类型就把用户的延迟静默清零
    eq(T.clampDelay('12', 500), 12);
    eq(T.clampDelay('12.6', 500), 13);
    eq(T.clampDelay('abc', 500), 0);
  });

  run('DEFAULTS 与页面结构一致：4 个点、5 段、扫描头槽位够用', function () {
    eq(T.DEFAULTS.beats, 4, 'index.html 里正好 4 个 .dot');
    eq(T.DEFAULTS.segments, 5, 'index.html 里正好 4 个 .tick，即 5 段');
    const need = Math.ceil(T.DEFAULTS.segments / T.DEFAULTS.beats);
    eq(T.NEEDLE_SLOTS >= need, true,
       'NEEDLE_SLOTS=' + T.NEEDLE_SLOTS + ' 不够 ' + need + ' 个并行扫描头');
  });

  // ─────────── 延迟改变后的重排起点 ───────────

  run('firstFutureIndex: 启动阶段一律落在第 0 拍', function () {
    eq(T.firstFutureIndex(0, 1100, 0, 500), 0);
    eq(T.firstFutureIndex(0, 1100, 500, 500), 0);
  });

  run('firstFutureIndex: 返回的拍其音频时刻确实在未来，前一拍确实已过去', function () {
    const nowMs = 10000, originMs = 1100, delayMs = 200, beatMs = 500;
    const n = T.firstFutureIndex(nowMs, originMs, delayMs, beatMs);
    const at = function (k) { return originMs + T.audioOffsetMs(k, beatMs, delayMs); };
    eq(n, 18);
    eq(at(n) > nowMs + T.CANCEL_CUTOFF_MS, true, '第 n 拍应在这条线之后');
    eq(at(n - 1) > nowMs + T.CANCEL_CUTOFF_MS, false, '第 n-1 拍不应在这条线之后');
  });

  run('firstFutureIndex: 边界处不会提前半拍', function () {
    // 第 18 拍的音频时刻 = 1100 + (19*500 - 200) = 10400。
    // 分界线是 now+5，所以 now < 10395 时第 18 拍还排得上，到 10395 就必须换成第 19 拍。
    eq(T.firstFutureIndex(10394, 1100, 200, 500), 18);
    eq(T.firstFutureIndex(10395, 1100, 200, 500), 19);
  });

  run('resumeIndex: 什么都没有被取消时，不回退到更小的拍号', function () {
    // now=2600 时第 3 拍还在未来，但当前已经排到第 7 拍。
    // 没有拍被取消就不该回头，否则第 3..6 拍会被重排、多响几声。
    eq(T.resumeIndex(7, [], 2600, 1100, 0, 500), 7);
    eq(T.resumeIndex(7, null, 2600, 1100, 0, 500), 7);
    eq(T.resumeIndex(7, undefined, 2600, 1100, 0, 500), 7);
  });

  run('resumeIndex: 从被取消的最小拍号续排，不丢拍也不重排', function () {
    // 第 3、4 拍被取消 → 从第 3 拍续排（此刻它仍在未来，floor 是 3）
    eq(T.resumeIndex(5, [4, 3], 2600, 1100, 0, 500), 3);
  });

  run('resumeIndex: 拍会被排到过去时，往后跳到未来 —— 这是暂停后改延迟的必经之路', function () {
    // 暂停在 ctx=3000ms 时把延迟从 0 拉到 500：第 3 拍的音频时刻
    // 从 1100+2000=3100 前移到 1100+2000-500=2600，已经是过去。
    // 只取 max(min(cancelled), floor) 才能既不重排已响过的、又不炸响。
    eq(T.resumeIndex(3, [3], 3000, 1100, 500, 500), 4);
    // 对照：同样的取消集合，不改延迟时第 3 拍仍在未来，就该从第 3 拍续
    eq(T.resumeIndex(3, [3], 3000, 1100, 0, 500), 3);
  });

  run('resumeIndex: 仍在未来的拍不能被丢掉 —— 分界线必须和音频层一致', function () {
    // 第 3 拍改延迟后落在 1100+2000-90 = 3010，也就是 now+10ms。
    // 它已经被取消（>now+5ms 才算"可取消"），但完全排得上。
    // 若这条线的定义比音频层的 5ms 宽（比如 20ms），这一拍会被 floor 顶掉 ——
    // 用户听到的就是调延迟时节奏里少了一声，正是设计文档 §5.4 明令禁止的那种。
    eq(T.resumeIndex(3, [3], 3000, 1100, 90, 500), 3);
    // 没有说话被取消的分支也一样：第 5 拍在 4100 = now+10ms，不该被跳过
    eq(T.resumeIndex(5, [], 4090, 1100, 0, 500), 5);
  });

  // ─────────── 点与刻度的位置 ───────────

  run('dotPosition: 5 段 4 点落在 20/40/60/80%', function () {
    close(T.dotPosition(0, 5), 0.2, 1e-12);
    close(T.dotPosition(1, 5), 0.4, 1e-12);
    close(T.dotPosition(2, 5), 0.6, 1e-12);
    close(T.dotPosition(3, 5), 0.8, 1e-12);
  });

  run('beatAgeMs: 取距上一次闪亮的时长，负数时间与跨轮都正确', function () {
    eq(T.beatAgeMs(500, 0, 500, 2000), 0);
    eq(T.beatAgeMs(1000, 1, 500, 2000), 0);
    eq(T.beatAgeMs(2000, 3, 500, 2000), 0);
    eq(T.beatAgeMs(2500, 0, 500, 2000), 0);        // 下一轮的滴
    eq(T.beatAgeMs(2500, 3, 500, 2000), 500);
    eq(T.beatAgeMs(0, 0, 500, 2000), 1500);        // t<0 之前，还没闪过
    eq(T.beatAgeMs(-500, 0, 500, 2000), 1000);     // 负数时间要回绕成正数
  });

  // ─────────── 扫描头 ───────────

  run('needles: t<0 时一个都不亮', function () {
    const list = T.needles(-500, 500, 4, 5);
    eq(list.length, 3, '槽位数固定为 3');
    eq(list[0], null);
    eq(list[1], null);
    eq(list[2], null);
  });

  run('needles: 第 0 拍时扫描头正好走到第 0 个点（20%）', function () {
    const list = T.needles(500, 500, 4, 5);
    eq(list[0].k, 0);
    close(list[0].position, 0.2, 1e-12);
    eq(list[0].opacity, 1);
    eq(list[1], null);
  });

  run('needles: 进入第 5 段时第 1 段同时起跑 —— 两个扫描头并行', function () {
    const list = T.needles(2100, 500, 4, 5);
    eq(list[0].k, 0);
    close(list[0].position, 0.84, 1e-12);
    eq(list[0].opacity, 1);
    eq(list[1].k, 1);
    close(list[1].position, 0.04, 1e-12);
    close(list[1].opacity, 100 / 170, 1e-9, '新头正在淡入');
    eq(list[2], null);
  });

  run('needles: 接力瞬间不跳变 —— 旧头已淡到看不见，新头已全亮', function () {
    const before = T.needles(2499, 500, 4, 5);
    close(before[0].opacity, 1 / 190, 1e-9, '旧头在 100% 处已几乎透明');
    eq(before[1].opacity, 1, '新头已全亮');
    const after = T.needles(2500, 500, 4, 5);
    eq(after[0].k, 1, '槽位 0 接管新一轮');
    close(after[0].position, 0.2, 1e-12);
    eq(after[0].opacity, 1);
    eq(after[1], null);
  });

  run('needles: 全程没有任何一拍出现两个可见扫描头以外的异常', function () {
    for (let t = 0; t < 12000; t += 25) {
      const list = T.needles(t, 500, 4, 5);
      let visible = 0;
      for (const n of list) {
        if (!n) continue;
        visible++;
        if (!(n.position >= 0 && n.position < 1)) {
          throw new Error('t=' + t + ' 位置越界: ' + n.position);
        }
        if (!(n.opacity >= 0 && n.opacity <= 1)) {
          throw new Error('t=' + t + ' 透明度越界: ' + n.opacity);
        }
      }
      if (visible > 2) throw new Error('t=' + t + ' 同时有 ' + visible + ' 个可见扫描头');
    }
  });

  run('needles: 换一组拍间隔，段数关系不变', function () {
    const list = T.needles(600, 300, 4, 5);        // beatMs=300 → cycle 1200 / sweep 1500
    eq(list[0].k, 0);
    close(list[0].position, 0.4, 1e-12);
  });

  // ─────────── 本轮该排哪些拍（调度决策，app.js 的 pump() 全靠它） ───────────

  run('pendingBeats: 只排够得着前瞻窗口的拍', function () {
    // origin=1100, beatMs=500, delay=0 → 各拍时刻 1600 / 2100 / 2600 / 3100
    const r = T.pendingBeats(0, 1500, 1100, 0, 500, 1620);
    eq(r.indices.join(','), '0');
    eq(r.nextIndex, 1);
  });

  run('pendingBeats: 主线程被卡住后补排，过时的拍全部丢掉并干净地接回网格', function () {
    // now=3000，第 0/1/2 拍（1600/2100/2600）已经在过去，只有第 3 拍（3100）还排得上。
    // 全部排出去的话就是好几声挤在一起炸响。
    const r = T.pendingBeats(0, 3000, 1100, 0, 500, 3120);
    eq(r.indices.join(','), '3');
    eq(r.nextIndex, 4);
  });

  run('pendingBeats: 阈值两侧 —— 恰好压线的丢掉，晚一点的留下，没有到点的返回空', function () {
    // 第 0 拍时刻 1600。now=1590 时分界线 1595，排得上。
    eq(T.pendingBeats(0, 1590, 1100, 0, 500, 1740).indices.join(','), '0');
    // now=1596 时分界线 1601，第 0 拍已经被判定为过去，丢掉。
    eq(T.pendingBeats(0, 1596, 1100, 0, 500, 1740).indices.join(','), '');
    // 恰好压线（atMs === now+5）也要丢掉。这里必须和 audio.js 的 cancelPending 用
    // 同一个严格比较：一个说"还算数"、另一个说"已经过去了"，就会两头都不管这一拍。
    eq(T.pendingBeats(0, 1595, 1100, 0, 500, 1740).indices.length, 0);
    // 窗口还没够到任何一拍
    const r = T.pendingBeats(0, 1000, 1100, 0, 500, 1120);
    eq(r.indices.length, 0);
    eq(r.nextIndex, 0, '什么也没排时 nextIndex 不能前进，否则会漏拍');
  });

  // 这台仪器赖以成立的不变量：扫描头压到第 i 个点的**时刻**，
  // 正好就是第 i 个点闪亮的**时刻**。用户就是靠这个重合去调延迟的。
  // 单函数各自钉死绝对值的那些测试挡不住"约定整体偏移"式的重构，这一条可以。
  run('不变量：扫描头压到第 i 个点，正是第 i 个点闪亮的时刻', function () {
    const beatMs = 500, beats = 4, segments = 5;
    const cycle = T.cycleMs(beatMs, beats);
    for (let i = 0; i < beats; i++) {
      const target = T.dotPosition(i, segments);
      for (let m = 0; m < 6; m++) {
        const tMs = T.visualOffsetMs(i, beatMs) + m * cycle;
        eq(T.beatAgeMs(tMs, i, beatMs, cycle), 0, 't=' + tMs + ' 第 ' + i + ' 个点应当刚闪');
        let hit = null;
        for (const n of T.needles(tMs, beatMs, beats, segments)) {
          if (n && Math.abs(n.position - target) < 1e-12) hit = n;
        }
        eq(hit !== null, true, 't=' + tMs + ' 没有扫描头压在第 ' + i + ' 个点上');
        eq(hit.opacity, 1, 't=' + tMs + ' 压点的扫描头应当是全亮的');
      }
    }
  });

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `node tools/run-tests.js`
Expected: 24 个用例全部 `FAIL`，错误信息是 `Cannot read properties of undefined (reading 'visualOffsetMs')` 之类（`timing.js` 还不存在），最后一行 `0 passed, 24 failed`。

（若报的是"找不到 timing.js"，说明运行器的 `existsSync` 跳过逻辑没生效，回 Step 1 检查。）

- [ ] **Step 4: 实现 `timing.js`**

```js
(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};

  const DEFAULTS = {
    beatMs: 500,
    beats: 4,
    segments: 5,
    stepFine: 1,
    stepCoarse: 10
  };

  const NEEDLE_SLOTS = 3;      // 同屏最多 2 个（segments/beats = 5/4），留 1 个余量
  const FADE_IN_MS = 170;
  const FADE_OUT_MS = 190;

  // "这一拍还排得上吗"的分界线，单位毫秒。
  // 这是全应用唯一的定义：audio.js 的取消判定也用它（CANCEL_CUTOFF_SEC 由它算出）。
  // 两边阈值一旦漂移，就会出现"被取消了、却又因为够不着下限而被丢掉"的拍 ——
  // 用户听到的就是调整延迟时节奏里莫名少了一声。
  const CANCEL_CUTOFF_MS = 5;

  function cycleMs(beatMs, beats) { return beatMs * beats; }
  function sweepMs(beatMs, segments) { return beatMs * segments; }
  function delayMax(beatMs) { return beatMs; }
  function startLeadMs(beatMs) { return beatMs + 600; }

  // 第 n 拍相对 origin 的毫秒偏移。
  // 从 (n+1) 起算而不是 n，是为了让 [0, beatMs) 这一段成为时间轴最左侧的留白：
  // 扫描头从 0% 出发跑向第一个点，此时还没有任何一拍发生。
  function visualOffsetMs(n, beatMs) { return (n + 1) * beatMs; }

  // 延迟只移动音频，不动视觉 —— 视觉是那把尺子。
  function audioOffsetMs(n, beatMs, delayMs) { return (n + 1) * beatMs - delayMs; }

  // 满足 audioOffsetMs(n) > (now - origin) + CANCEL_CUTOFF_MS 的最小 n，且不早于 0。
  // 刻意**不**接受阈值参数：这条分界线只能有一处定义，留个参数就等于给"再漂移一次"留了个口子。
  function firstFutureIndex(nowMs, originMs, delayMs, beatMs) {
    const n = Math.floor((nowMs + CANCEL_CUTOFF_MS - originMs + delayMs) / beatMs);
    return n < 0 ? 0 : n;
  }

  // 改延迟之后，下一拍该从哪一号继续排。这是整个调度里最容易出事的一处，
  // 所以它必须是个纯函数、必须被测试覆盖。两个约束缺一不可：
  //
  //   1. 不低于被取消的最小拍号 —— 否则会把"已经响过"的拍再排一次，用户多听到一声。
  //   2. 不低于 firstFutureIndex —— 否则会把拍排到过去。Web Audio 对过去的 start 时刻
  //      不报错，直接立刻播；结果是一声炸响之后节奏被压缩（两拍挤在一起）。
  //      暂停后改延迟必然触发：ctx.currentTime 冻结，而音频时刻随延迟前移。
  function resumeIndex(nextIndex, cancelled, nowMs, originMs, delayMs, beatMs) {
    let n = nextIndex;
    if (cancelled && cancelled.length) {
      let min = cancelled[0];
      for (let i = 1; i < cancelled.length; i++) {
        if (cancelled[i] < min) min = cancelled[i];
      }
      n = min;
    }
    const floor = firstFutureIndex(nowMs, originMs, delayMs, beatMs);
    return n < floor ? floor : n;
  }

  // 本轮该把哪些拍排进音频队列，以及排完之后 nextIndex 走到哪。
  //
  // 这是整套调度里唯一会"做决定"的地方，所以它必须是纯函数、必须有测试。
  // app.js 的 pump() 只负责把返回的拍号交给音频层，不再自己判断 ——
  // 判断逻辑藏在 DOM 胶水里的话，就是这台仪器最要命的一段没有覆盖的代码。
  //
  // 两条规则：
  //   · 够不着 horizonMs 的先不排，留给下一轮（前瞻）。
  //   · 时刻已经到/已过的拍**直接丢掉**，不排。Web Audio 对过去的 start 时刻不报错，
  //     直接立刻播 —— 主线程被卡住时补排的拍会让好几声挤在一起炸响。
  function pendingBeats(nextIndex, nowMs, originMs, delayMs, beatMs, horizonMs) {
    const floorMs = nowMs + CANCEL_CUTOFF_MS;
    const indices = [];
    let n = nextIndex;
    for (;;) {
      const atMs = originMs + audioOffsetMs(n, beatMs, delayMs);
      if (atMs >= horizonMs) break;      // atMs 每轮递增 beatMs > 0，必然终止
      if (atMs > floorMs) indices.push(n);
      n++;
    }
    return { indices: indices, nextIndex: n };
  }

  // Number() 先转一道：调用方可能直接把 input.value（字符串）递进来，
  // 不转的话 "12" 会被判成非法输入、静默把用户的延迟清零。
  function clampDelay(v, max) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    const r = Math.round(n);
    if (r < 0) return 0;
    if (r > max) return max;
    return r;
  }

  function dotPosition(i, segments) { return (i + 1) / segments; }

  function beatAgeMs(tMs, i, beatMs, cycle) {
    let age = (tMs - visualOffsetMs(i, beatMs)) % cycle;
    if (age < 0) age += cycle;
    return age;
  }

  // 返回长度固定为 NEEDLE_SLOTS 的数组，下标 = DOM 里的槽位。
  // 槽位 j 对应第 (k0 + j) 个扫描头 —— 这个对应关系是接力不跳变的关键：
  // 当 k0 递增时，槽位 0 接管的那个新头此刻已经全亮，而被它顶掉的老头已经淡到透明。
  function needles(tMs, beatMs, beats, segments) {
    const cycle = cycleMs(beatMs, beats);
    const sweep = sweepMs(beatMs, segments);
    let k0 = Math.floor((tMs - sweep) / cycle) + 1;
    if (k0 < 0) k0 = 0;

    const out = [];
    for (let j = 0; j < NEEDLE_SLOTS; j++) {
      const elapsed = tMs - (k0 + j) * cycle;
      if (elapsed < 0 || elapsed >= sweep) {
        out.push(null);
        continue;
      }
      let opacity = 1;
      if (elapsed < FADE_IN_MS) opacity = elapsed / FADE_IN_MS;
      const tail = sweep - elapsed;
      if (tail < FADE_OUT_MS) opacity = Math.min(opacity, tail / FADE_OUT_MS);
      out.push({
        k: k0 + j,
        position: elapsed / sweep,
        opacity: opacity
      });
    }
    return out;
  }

  SDT.timing = {
    DEFAULTS: DEFAULTS,
    NEEDLE_SLOTS: NEEDLE_SLOTS,
    FADE_IN_MS: FADE_IN_MS,
    FADE_OUT_MS: FADE_OUT_MS,
    CANCEL_CUTOFF_MS: CANCEL_CUTOFF_MS,
    cycleMs: cycleMs,
    sweepMs: sweepMs,
    delayMax: delayMax,
    startLeadMs: startLeadMs,
    visualOffsetMs: visualOffsetMs,
    audioOffsetMs: audioOffsetMs,
    firstFutureIndex: firstFutureIndex,
    resumeIndex: resumeIndex,
    pendingBeats: pendingBeats,
    clampDelay: clampDelay,
    dotPosition: dotPosition,
    beatAgeMs: beatAgeMs,
    needles: needles
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 5: 运行测试，确认全绿**

Run: `node tools/run-tests.js`
Expected: 全部 `ok`，最后一行 `24 passed, 0 failed`，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add timing.js tests.js tools/run-tests.js
git commit -m "Add pure timing math with a zero-dependency test runner"
```

> 注：若本任务是在代码审查之后重跑的补丁轮，提交信息用
> `Add resumeIndex to prevent scheduling beats into the past`。

---

## Task 2: 多语种

**Files:**
- Create: `i18n.js`
- Modify: `tests.js`（在文件末尾、`})(typeof window ...` 之前追加）

- [ ] **Step 1: 追加失败的测试**

在 `tests.js` 里最后一个 `run(...)` 之后、`})(typeof window !== 'undefined' ? window : globalThis);` 之前插入：

```js
  // ─────────── 多语种 ───────────

  // 遍历文案表本身，而不是写死 zh / en —— 否则加第三门语言时，
  // 一条漏了键的新表会安静地通过，而 README 却向用户承诺这条检查覆盖"所有语言"。
  run('i18n: 所有语言的键集合完全一致，且没有空串', function () {
    const langs = Object.keys(SDT.i18n.strings);
    eq(langs.length >= 2, true, '至少要两种语言，当前 ' + langs.length);
    eq(typeof SDT.i18n.strings[SDT.i18n.FALLBACK], 'object',
       'FALLBACK (' + SDT.i18n.FALLBACK + ') 必须真的在文案表里');

    const reference = langs[0];
    const expected = Object.keys(SDT.i18n.strings[reference]).sort().join(',');
    for (const lang of langs) {
      const table = SDT.i18n.strings[lang];
      eq(Object.keys(table).sort().join(','), expected,
         lang + ' 的键集合应当与 ' + reference + ' 一致');
      for (const k of Object.keys(table)) {
        if (!table[k]) throw new Error(lang + '.' + k + ' 是空的');
      }
    }
  });

  // apply() 是唯一把文案真正写到屏幕上的函数，而它本身没有分支
  // （查表的逻辑在上面的 t() 里）。用一个假节点就能在无 DOM 的环境里钉住它。
  run('i18n.apply: 把文案写进 [data-i18n] 节点，缺键回落成键名', function () {
    const nodes = [
      { textContent: null, getAttribute: function () { return 'app.title'; } },
      { textContent: null, getAttribute: function () { return 'nope.missing'; } }
    ];
    const fakeRoot = { querySelectorAll: function (sel) { return sel === '[data-i18n]' ? nodes : []; } };
    SDT.i18n.apply('zh', fakeRoot);
    eq(nodes[0].textContent, '延迟测试');
    eq(nodes[1].textContent, 'nope.missing');
  });

  run('i18n.resolve: 用户选过的语言优先', function () {
    eq(SDT.i18n.resolve('zh', 'en-US'), 'zh');
    eq(SDT.i18n.resolve('en', 'zh-CN'), 'en');
  });

  run('i18n.resolve: 没选过就看浏览器语言，中文只有 zh 开头才认', function () {
    eq(SDT.i18n.resolve(null, 'zh-CN'), 'zh');
    eq(SDT.i18n.resolve(null, 'zh'), 'zh');
    eq(SDT.i18n.resolve(null, 'zh-Hant-TW'), 'zh');
    eq(SDT.i18n.resolve(null, 'en-US'), 'en');
    eq(SDT.i18n.resolve(null, 'fr-FR'), 'en');
    eq(SDT.i18n.resolve(null, ''), 'en');
    eq(SDT.i18n.resolve(null, undefined), 'en');
  });

  run('i18n.resolve: 非法的已存值当作没存过', function () {
    eq(SDT.i18n.resolve('klingon', 'zh-CN'), 'zh');
    eq(SDT.i18n.resolve(123, 'en-US'), 'en');
  });

  run('i18n.t: 取文案，缺键时回落到键名而不是 undefined', function () {
    eq(SDT.i18n.t('app.title', 'zh'), '延迟测试');
    eq(SDT.i18n.t('app.title', 'en'), 'Latency Test');
    eq(SDT.i18n.t('controls.reset', 'zh'), '归零');
    eq(SDT.i18n.t('nope.missing', 'zh'), 'nope.missing');
    eq(SDT.i18n.t('app.title', 'klingon'), 'Latency Test', '未知语言回落到 en');
    // 原型链上的键不是文案 —— 必须和普通缺键一样回落到键名，
    // 否则会被塞进 textContent 渲染成一段函数源码
    eq(SDT.i18n.t('constructor', 'zh'), 'constructor');
    eq(SDT.i18n.t('toString', 'en'), 'toString');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/run-tests.js`
Expected: 新增 6 个用例 `FAIL`，错误是 `Cannot read properties of undefined (reading 'strings')`；原有 24 个仍 `ok`。

- [ ] **Step 3: 实现 `i18n.js`**

`resolve` 和 `t` 是纯函数（这是它们可测的原因），只有 `detect` / `apply` / `save` 碰浏览器 API。

```js
(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};
  const STORE_KEY = 'sdt.lang';

  const strings = {
    zh: {
      'app.title': '延迟测试',
      'start.title': '戴上耳机，点击开始',
      'start.subtitle': '把“滴嗒嗒哒”调到与闪动的点完全重合',
      'start.button': '开始',
      'controls.reset': '归零',
      'controls.pause': '暂停',
      'controls.resume': '继续',
      'hint': '戴上耳机，把“滴嗒嗒哒”调到与闪动的点完全重合',
      'caveat': '读数还包含设备自身的音频与显示延迟（通常 10–40 ms），适合横向比较耳机，不是实验室级绝对值',
      'error.noAudio': '当前浏览器不支持 Web Audio，无法运行'
    },
    en: {
      'app.title': 'Latency Test',
      'start.title': 'Put on your headphones',
      'start.subtitle': 'Adjust the beat until it lines up with the flashing dots',
      'start.button': 'Start',
      'controls.reset': 'Reset',
      'controls.pause': 'Pause',
      'controls.resume': 'Resume',
      'hint': 'Wear your headphones and adjust until the beat lines up with the dots',
      'caveat': "Includes your device's own audio and display latency (typically 10–40 ms) — good for comparing headphones, not a lab-grade figure",
      'error.noAudio': 'This browser does not support Web Audio'
    }
  };

  const FALLBACK = 'en';

  // 只认自有属性。文案表和语言表都是普通对象，直接 obj[key] 会穿到原型链上 ——
  // 'constructor'、'toString' 这种键会取到 Object 的方法而不是"没有这一项"。
  // 语言维度和键维度都要走这道守卫，只守一边比不守更让人困惑。
  function hasOwn(obj, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 语言身份以文案表为准，这两个函数里不写死任何语言代码 ——
  // 加一门语言 = 往 strings 里加一条，不需要回来改逻辑。
  function hasLanguage(code) { return hasOwn(strings, code); }

  // 纯函数：用户选过的优先，其次看浏览器语言的前两位
  function resolve(stored, navLang) {
    if (hasLanguage(stored)) return stored;
    if (typeof navLang === 'string') {
      const code = navLang.slice(0, 2).toLowerCase();
      if (hasLanguage(code)) return code;
    }
    return FALLBACK;
  }

  // 纯函数：语言不存在时回落到 en；键不存在时回落到键名本身（比 undefined 好排查）。
  // "不存在"以自有属性为准，所以 t('constructor', 'zh') 会返回 'constructor'，
  // 而不是把 Object 构造函数塞进 textContent。
  function t(key, lang) {
    const table = hasLanguage(lang) ? strings[lang] : strings[FALLBACK];
    if (hasOwn(table, key)) return table[key];
    if (hasOwn(strings[FALLBACK], key)) return strings[FALLBACK][key];
    return key;
  }

  function detect() {
    let stored = null;
    try { stored = root.localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式会抛 */ }
    const nav = root.navigator ? root.navigator.language : null;
    return resolve(stored, nav);
  }

  function save(lang) {
    try { root.localStorage.setItem(STORE_KEY, lang); } catch (e) { /* 写不进去就算了 */ }
  }

  // 带 data-i18n 的元素统一刷一遍
  function apply(lang, rootEl) {
    const nodes = rootEl.querySelectorAll('[data-i18n]');
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'), lang);
    }
  }

  SDT.i18n = {
    strings: strings,
    FALLBACK: FALLBACK,
    resolve: resolve,
    t: t,
    detect: detect,
    save: save,
    apply: apply
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: 运行测试，确认全绿**

Run: `node tools/run-tests.js`
Expected: `30 passed, 0 failed`。

- [ ] **Step 5: 提交**

```bash
git add i18n.js tests.js
git commit -m "Add bilingual string table with language resolution"
```

> 注：若本任务是在代码审查之后重跑的补丁轮，提交信息用
> `Make language identity table-driven; localize the tab title`。

---

## Task 3: 页面骨架与样式

没有自动化测试 —— 这一步的产物是结构和样式，验收靠 Task 6 之后的肉眼看。

**Files:**
- Create: `index.html`（同名，直接覆盖现有的原型）
- Create: `styles.css`（新文件；现有的 `app.css` 是原型遗留，在 Task 7 里删除）

- [ ] **Step 1: 写 `index.html`**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<!-- 标签页标题也走 data-i18n：document.querySelectorAll 会遍历到 <head>，
     所以 app.js 里那句 apply(lang, document) 顺手就把它本地化了，不需要额外代码 -->
<title data-i18n="app.title">延迟测试</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>

<div id="start-overlay" class="overlay">
  <div class="overlay-icon">🎧</div>
  <h1 class="overlay-title" data-i18n="start.title"></h1>
  <p class="overlay-sub" data-i18n="start.subtitle"></p>
  <button id="start-btn" class="overlay-btn" type="button" data-i18n="start.button"></button>
  <p id="start-error" class="overlay-error" hidden></p>
</div>

<main id="app" class="app" hidden>
  <header class="topbar">
    <span class="brand" data-i18n="app.title"></span>
    <span class="tools">
      <button id="lang-btn" class="tool" type="button">
        <span data-lang-tag="zh">中</span><i>/</i><span data-lang-tag="en">EN</span>
      </button>
      <button id="pause-btn" class="tool" type="button"></button>
    </span>
  </header>

  <div class="indicator">
    <div class="stage" id="stage">
      <div class="dot" data-beat="0"></div>
      <div class="dot" data-beat="1"></div>
      <div class="dot" data-beat="2"></div>
      <div class="dot" data-beat="3"></div>
      <div class="tick" data-beat="0"></div>
      <div class="tick" data-beat="1"></div>
      <div class="tick" data-beat="2"></div>
      <div class="tick" data-beat="3"></div>
      <div class="track"></div>
      <div class="needle"></div>
      <div class="needle"></div>
      <div class="needle"></div>
    </div>
  </div>

  <div class="readout"><span id="delay-value">0</span><em>ms</em></div>

  <div class="buttons">
    <button class="btn step" type="button" data-step="-10">−10</button>
    <button class="btn step" type="button" data-step="-1">−1</button>
    <button class="btn step" type="button" data-step="1">+1</button>
    <button class="btn step" type="button" data-step="10">+10</button>
  </div>
  <div class="buttons sub">
    <button id="reset-btn" class="btn" type="button" data-i18n="controls.reset"></button>
  </div>

  <footer class="foot">
    <p class="foot-hint" data-i18n="hint"></p>
    <p class="foot-caveat" data-i18n="caveat"></p>
  </footer>
</main>

<!-- 预留：节拍间隔由用户调整。当前 hidden，不对用户开放。见设计文档 §4.1 -->
<div id="interval-slot" hidden>
  <label>节拍间隔
    <input id="interval-input" type="number" min="200" max="1000" step="50" value="500">
  ms</label>
</div>

<script src="i18n.js"></script>
<script src="timing.js"></script>
<script src="audio.js"></script>
<script src="app.js"></script>
</body>
</html>
```

`#pause-btn` **故意不带** `data-i18n` —— 它的文案在"暂停/继续"之间切换，由 `app.js` 按运行状态写，交给 `i18n.apply` 会被覆盖成固定的"暂停"。

- [ ] **Step 2: 写 `styles.css`**

对照已确认的原型（`.superpowers/brainstorm/90265-1791777941/content/page-layout.html`）。颜色只在 `app.js` 里以 RGB 常量定义一次，CSS 这边不重复定义滴/嗒两色，避免两处漂移。

```css
:root {
  --bg: #0d1117;
  --panel: #131a24;
  --slot: #1b2431;
  --line: #2c3949;
  --press: #2f4055;
  --fg: #eaf2fb;
  --fg-dim: #7d8899;
  --fg-faint: #5b6675;

  --dot-size: clamp(26px, 8vw, 38px);
  --tick-h: clamp(16px, 4.6vw, 24px);
  --needle-w: clamp(5px, 1.4vw, 7px);
  --needle-h: clamp(28px, 8vw, 40px);
  --stage-h: clamp(84px, 24vw, 116px);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%;
}

body {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  justify-content: center;
  overflow-x: hidden;
}

/* ─────────── 启动遮罩 ─────────── */

.overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px;
  text-align: center;
}
.overlay[hidden] { display: none; }
.overlay-icon { font-size: 46px; margin-bottom: 6px; }
.overlay-title { margin: 0; font-size: 20px; font-weight: 600; }
.overlay-sub { margin: 0; font-size: 14px; color: var(--fg-dim); line-height: 1.6; }
.overlay-btn {
  margin-top: 20px;
  padding: 14px 40px;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
  background: var(--press);
  border: 1px solid #4a5d75;
  border-radius: 12px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.overlay-btn:active { background: #3a4d66; }
.overlay-error {
  margin: 14px 0 0;
  font-size: 13px;
  color: #ff8f8f;
  line-height: 1.6;
}
.overlay-error[hidden] { display: none; }

/* ─────────── 主体 ─────────── */

.app {
  width: 100%;
  max-width: 520px;
  padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
}
.app[hidden] { display: none; }

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--fg-dim);
}
.topbar .brand { letter-spacing: .06em; }
.topbar .tools { display: flex; align-items: center; gap: 6px; }

.tool {
  font: inherit;
  font-size: 13px;
  color: var(--fg-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.tool:active { background: var(--slot); }
.tool i { font-style: normal; opacity: .35; margin: 0 1px; }
#lang-btn [data-lang-tag] { opacity: .4; }
#lang-btn[data-lang="zh"] [data-lang-tag="zh"],
#lang-btn[data-lang="en"] [data-lang-tag="en"] { opacity: 1; color: var(--fg); font-weight: 600; }
#pause-btn[hidden] { display: none; }

/* ─────────── 指示器 ─────────── */

.indicator {
  background: var(--panel);
  border-radius: 16px;
  padding: 0 20px;
}
.stage { position: relative; height: var(--stage-h); }

/* 点：位置由 JS 写 left，垂直靠负 margin 居中在 19% 这条线上。
   transform 留给 JS 做缩放脉冲，不参与定位。 */
.dot {
  --d: var(--dot-size);
  position: absolute;
  top: 19%;
  left: 0;
  width: var(--d);
  height: var(--d);
  margin-left: calc(var(--d) / -2);
  margin-top: calc(var(--d) / -2);
  border-radius: 50%;
  background: rgba(125, 136, 153, .12);
  will-change: transform, background, box-shadow;
}
.dot[data-beat="0"] { --d: calc(var(--dot-size) * 1.3); }

.track {
  position: absolute;
  left: 0;
  right: 0;
  top: 74%;
  height: 4px;
  margin-top: -2px;
  border-radius: 2px;
  background: var(--slot);
}

.tick {
  position: absolute;
  top: 74%;
  left: 0;
  width: 3px;
  height: var(--tick-h);
  margin-top: calc(var(--tick-h) / -2);
  margin-left: -1.5px;
  border-radius: 2px;
  background: rgba(125, 136, 153, .2);
  will-change: background, box-shadow;
}

.needle {
  position: absolute;
  top: 74%;
  left: 0;
  width: var(--needle-w);
  height: var(--needle-h);
  margin-top: calc(var(--needle-h) / -2);
  margin-left: calc(var(--needle-w) / -2);
  border-radius: 3px;
  background: var(--fg);
  box-shadow: 0 0 14px rgba(234, 242, 251, .7);
  opacity: 0;
  will-change: left, opacity;
}

/* ─────────── 读数与按钮 ─────────── */

.readout {
  text-align: center;
  margin: 20px 0 18px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.readout #delay-value {
  font-size: clamp(44px, 14vw, 60px);
  font-weight: 600;
  letter-spacing: -.02em;
}
.readout em {
  font-style: normal;
  font-size: 15px;
  color: var(--fg-dim);
  margin-left: 6px;
}

.buttons { display: flex; gap: 9px; margin-bottom: 9px; }
.buttons.sub { margin-bottom: 0; }

.btn {
  flex: 1;
  padding: 15px 4px;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  background: var(--slot);
  border: 1px solid var(--line);
  border-radius: 11px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
  transition: background .07s, transform .07s;
}
.btn.held, .btn:active { background: var(--press); border-color: #4a5d75; transform: scale(.97); }
.buttons.sub .btn {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-dim);
  padding: 9px 4px;
  background: transparent;
  border-color: #232e3c;
}

/* ─────────── 底部提示 ─────────── */

.foot { margin-top: auto; padding-top: 18px; text-align: center; }
.foot-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--fg-faint); }
.foot-caveat { margin: 6px 0 0; font-size: 11px; line-height: 1.6; color: #414c5a; }
```

- [ ] **Step 3: 提交**

```bash
git add index.html styles.css
git commit -m "Add page skeleton and styles"
```

（`app.css` 和旧的 `app.js` 先留着不动。`app.js` 在 Task 5 起被逐步重写成新实现，`app.css` 在 Task 7 里删除。）

---

## Task 4: 音频引擎 —— 音色合成

**没有自动化测试**：需要真实音频硬件，见设计文档 §12。验收放在 Task 8 的应用总装之后。

**Files:**
- Create: `audio.js`

- [ ] **Step 1: 写 `audio.js`**

```js
(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};

  // 丙方案：3ms 陡峭起音 + 指数衰减。
  // 延迟测试靠的是起音瞬态 —— 余弦窗虽然也短，但起音被抹圆，
  // 听感上的"时刻"会往后飘十几毫秒，正是我们要测的量级。
  const TONES = {
    di: { freq: 1600, ms: 50, gain: 0.60 },
    da: { freq: 1100, ms: 50, gain: 0.60 }
  };

  const ATTACK_SEC = 0.003;
  const DECAY_SEC = 0.012;
  const TAIL_SEC = 0.002;

  // "这一拍还排得上 / 还取消得掉吗"的分界线。定义在 timing.js 里，这里只做单位换算，
  // 刻意不给默认值 —— 两处阈值必须是同一个数，一旦漂移就会静默丢拍。
  // 顺带：timing.js 没先加载时这里会立刻抛错，比悄悄用一个不一样的值好。
  const CANCEL_CUTOFF_SEC = SDT.timing.CANCEL_CUTOFF_MS / 1000;
  const PRUNE_AFTER_SEC = 0.2;

  let ctx = null;
  let master = null;
  let buffers = { di: null, da: null };
  let pending = [];                  // { src, time, index }

  function isSupported() {
    return !!(root.AudioContext || root.webkitAudioContext);
  }

  function renderTone(spec) {
    const sr = ctx.sampleRate;
    const n = Math.max(2, Math.round(sr * spec.ms / 1000));
    const buf = ctx.createBuffer(1, n, sr);
    const data = buf.getChannelData(0);
    const attack = Math.max(1, Math.round(sr * ATTACK_SEC));
    const tail = Math.max(1, Math.round(sr * TAIL_SEC));
    const decay = sr * DECAY_SEC;

    for (let i = 0; i < n; i++) {
      let env = Math.min(1, i / attack) * Math.exp(-i / decay);
      if (i > n - tail) env *= (n - i) / tail;   // 末端线性归零，杜绝爆音
      data[i] = Math.sin(2 * Math.PI * spec.freq * i / sr) * env * spec.gain;
    }
    return buf;
  }

  function init() {
    if (ctx) return ctx;

    const AC = root.AudioContext || root.webkitAudioContext;
    ctx = new AC();

    // iOS 16.4+：不设成 playback 的话，iPhone 的静音拨片会让 Web Audio 完全没声
    if (root.navigator && root.navigator.audioSession) {
      try { root.navigator.audioSession.type = 'playback'; } catch (e) { /* 不支持就算了 */ }
    }

    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    buffers.di = renderTone(TONES.di);
    buffers.da = renderTone(TONES.da);
    return ctx;
  }

  function currentTime() { return ctx ? ctx.currentTime : 0; }
  function state() { return ctx ? ctx.state : 'none'; }

  function schedule(beatIndex, atSeconds) {
    const src = ctx.createBufferSource();
    src.buffer = (beatIndex % 4 === 0) ? buffers.di : buffers.da;
    src.connect(master);
    src.start(atSeconds);
    pending.push({ src: src, time: atSeconds, index: beatIndex });
  }

  // 取消所有尚未开始播放的已排音频，返回被取消的拍号。
  // 已经开始播的不动 —— 音长只有 50ms，让它自然收尾，避免中途掐断产生爆音。
  function cancelPending() {
    const cutoff = ctx.currentTime + CANCEL_CUTOFF_SEC;
    const kept = [];
    const cancelled = [];
    for (const p of pending) {
      if (p.time > cutoff) {
        try { p.src.stop(); } catch (e) { /* 已经结束的会抛，忽略 */ }
        cancelled.push(p.index);
      } else {
        kept.push(p);
      }
    }
    pending = kept;
    return cancelled;
  }

  function prune() {
    const cutoff = ctx.currentTime - PRUNE_AFTER_SEC;
    pending = pending.filter(function (p) { return p.time > cutoff; });
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  SDT.audio = {
    TONES: TONES,
    isSupported: isSupported,
    init: init,
    currentTime: currentTime,
    state: state,
    schedule: schedule,
    cancelPending: cancelPending,
    prune: prune,
    suspend: suspend,
    resume: resume
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: 确认没有打破已有的测试**

`tools/run-tests.js` 的 `APP_SCRIPTS` 里已经包含 `audio.js`，所以这一步顺带验证了它能在裸 vm 里求值。

Run: `node tools/run-tests.js`
Expected: `30 passed, 0 failed`。

`audio.js` 顶层只有 `const`/`function` 声明和最后的 `SDT.audio = {...}`，不碰 `document` 也不碰 `AudioContext`；`init()` 不会被调用，所以不会抛异常。

- [ ] **Step 3: 提交**

```bash
git add audio.js
git commit -m "Add audio engine: tone synthesis and scheduling primitives"
```

---

## Task 5: 指示器渲染

**Files:**
- Create: `app.js`（同名，整体替换原型遗留的旧文件）

- [ ] **Step 1: 写 `app.js` 的指示器部分**

这个文件后面几个 Task 会继续长，先只写渲染和最小启动骨架，让它能在浏览器里跑起来看动效。

```js
(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};
  const T = SDT.timing;
  const I18N = SDT.i18n;

  // 颜色只在这里定义一次。CSS 里不给滴/嗒上色，也就不会两处漂移。
  const WARM = [255, 209, 102];
  const COOL = [76, 201, 240];
  const IDLE_ALPHA = 0.10;
  const IDLE_ALPHA_DI = 0.12;
  const FLASH_DECAY_MS = 70;
  const GLOW_DOT_PX = 30;
  const GLOW_TICK_PX = 16;

  const LOOKAHEAD_MS = 120;
  const TIMER_MS = 25;

  const state = {
    beatMs: T.DEFAULTS.beatMs,
    beats: T.DEFAULTS.beats,
    segments: T.DEFAULTS.segments,
    delay: 0,
    originMs: 0,
    nextIndex: 0,
    running: false,
    paused: false
  };

  let els = null;
  let timerId = null;
  let lit = [];          // 每个点上一次是否处于"亮"的状态，用来省掉绝大多数重绘

  function rgba(rgb, alpha) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
  }

  function collectElements() {
    const stage = document.getElementById('stage');
    const dots = Array.prototype.slice.call(stage.querySelectorAll('.dot'));
    const ticks = Array.prototype.slice.call(stage.querySelectorAll('.tick'));

    // 点的位置按 i 固定在 20/40/60/80%，只需算一次
    for (let i = 0; i < dots.length; i++) {
      const pct = (T.dotPosition(i, state.segments) * 100).toFixed(4) + '%';
      dots[i].style.left = pct;
      ticks[i].style.left = pct;
    }

    els = {
      stage: stage,
      dots: dots,
      ticks: ticks,
      needles: Array.prototype.slice.call(stage.querySelectorAll('.needle')),
      delayValue: document.getElementById('delay-value')
    };
    lit = new Array(dots.length).fill(false);
  }

  function paintDot(el, rgb, e, idleAlpha) {
    el.style.background = rgba(rgb, idleAlpha + (1 - idleAlpha) * e);
    el.style.transform = 'scale(' + (1 + 0.13 * e).toFixed(4) + ')';
    el.style.boxShadow = e < 0.01 ? 'none'
      : '0 0 ' + (GLOW_DOT_PX * e).toFixed(1) + 'px ' + rgba(rgb, 0.55 * e);
  }

  function paintTick(el, rgb, e) {
    el.style.background = rgba(rgb, 0.22 + 0.78 * e);
    el.style.boxShadow = e < 0.01 ? 'none'
      : '0 0 ' + (GLOW_TICK_PX * e).toFixed(1) + 'px ' + rgba(rgb, 0.7 * e);
  }

  // tMs 是相对 origin 的毫秒时间。tMs < 0 时什么都不会亮 ——
  // 扫描头还没从最左端出发，第一拍也还没发生。
  function renderIndicator(tMs) {
    const beatMs = state.beatMs;
    const cycle = T.cycleMs(beatMs, state.beats);

    for (let i = 0; i < els.dots.length; i++) {
      const e = Math.exp(-T.beatAgeMs(tMs, i, beatMs, cycle) / FLASH_DECAY_MS);
      const rgb = i === 0 ? WARM : COOL;
      const idle = i === 0 ? IDLE_ALPHA_DI : IDLE_ALPHA;

      if (e < 0.01) {
        if (lit[i]) {           // 衰减早已结束，不必每帧重写 —— 一拍里约 85% 的帧走这条路
          lit[i] = false;
          paintDot(els.dots[i], rgb, 0, idle);
        }
      } else {
        lit[i] = true;
        paintDot(els.dots[i], rgb, e, idle);
      }
      paintTick(els.ticks[i], rgb, e);
    }

    const needles = T.needles(tMs, beatMs, state.beats, state.segments);
    for (let j = 0; j < els.needles.length; j++) {
      const n = needles[j];
      if (!n) {
        els.needles[j].style.opacity = 0;
      } else {
        els.needles[j].style.left = (n.position * 100).toFixed(3) + '%';
        els.needles[j].style.opacity = n.opacity.toFixed(3);
      }
    }
  }

  function renderReadout() {
    els.delayValue.textContent = String(state.delay);
  }

  function frame() {
    const tMs = SDT.audio.currentTime() * 1000 - state.originMs;
    renderIndicator(tMs);
    requestAnimationFrame(frame);
  }

  // 临时启动入口。Task 7 会把它换成启动遮罩。
  // 现在点页面任意位置即可启动 —— 必须是真实点击：AudioContext 只允许在用户手势里恢复，
  // 否则上下文一直挂起、currentTime 冻结，指示器根本不会动。
  function tempStart() {
    SDT.audio.init();
    SDT.audio.resume();
    state.originMs = (SDT.audio.currentTime() + T.startLeadMs(state.beatMs) / 1000) * 1000;
    state.nextIndex = 0;
    state.running = true;
    document.getElementById('start-overlay').hidden = true;
    document.getElementById('app').hidden = false;
    requestAnimationFrame(frame);
  }

  document.addEventListener('DOMContentLoaded', function () {
    collectElements();
    renderReadout();
    // 遮罩盖在最上层，但点击会冒泡到 document，所以点遮罩也算数
    document.addEventListener('click', function once() {
      document.removeEventListener('click', once);
      tempStart();
    });
  });

  SDT.app = {
    state: state,
    renderIndicator: renderIndicator,
    renderReadout: renderReadout
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: 在浏览器里看动效对不对**

打开 `index.html`，**点页面任意位置**（遮罩会消失，主体出现）。

Expected（对照原型 `page-layout.html`）：
- 上排 4 个点，第一个更大、暖色；下排一条时间轴，4 个刻度对齐在点的正下方
- 扫描头从最左端出发，压到第 1 个刻度时第 1 个点同时亮起，往后逐个走
- 走到最右端（约 2.5s）时，最左边已经同时冒出一个新扫描头 —— 两个并行约 0.5s，旧的淡出、新的接管，**全程没有任何回跳**

- [ ] **Step 3: 提交**

```bash
git add app.js
git commit -m "Add indicator rendering driven by the audio clock"
```

---

## Task 6: 控件接线 —— 按钮、长按连发、键盘

**Files:**
- Modify: `app.js`

- [ ] **Step 1: 在 `app.js` 里加入延迟控制**

在 `renderReadout` 之后、`frame` 之前插入：

```js
  const HOLD_DELAY_MS = 380;
  // 按住越久连发越快：110ms → 70ms → 40ms → 24ms
  function repeatIntervalMs(heldMs) {
    if (heldMs > 2200) return 24;
    if (heldMs > 1400) return 40;
    if (heldMs > 800) return 70;
    return 110;
  }

  let holdTimer = null;
  let holdButton = null;

  function endHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdButton) { holdButton.classList.remove('held'); holdButton = null; }
  }

  function applyDelay(next) {
    const clamped = T.clampDelay(next, T.delayMax(state.beatMs));
    if (clamped === state.delay) return;
    state.delay = clamped;
    renderReadout();

    if (!state.running) return;
    // 取消已排但还没响的音频，再从"被取消的最小拍号"和"第一个仍在未来的拍号"里取大的那个续排。
    // 两个约束缺一不可（会多一声 / 会炸响），推导见 timing.js 里 resumeIndex 的注释和设计文档 §5.4。
    const cancelled = SDT.audio.cancelPending();
    state.nextIndex = T.resumeIndex(
      state.nextIndex, cancelled,
      SDT.audio.currentTime() * 1000, state.originMs, state.delay, state.beatMs
    );
    pump();
  }

  function beginHold(btn, step) {
    endHold();
    holdButton = btn;
    btn.classList.add('held');
    applyDelay(state.delay + step);

    const t0 = performance.now();
    function tick() {
      applyDelay(state.delay + step);
      holdTimer = setTimeout(tick, repeatIntervalMs(performance.now() - t0));
    }
    holdTimer = setTimeout(tick, HOLD_DELAY_MS);   // 按住 380ms 后开始连发
  }

  function wireControls() {
    const buttons = document.querySelectorAll('.btn.step');
    for (const btn of buttons) {
      const step = parseInt(btn.getAttribute('data-step'), 10);
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();          // 阻止长按选中和双击缩放
        beginHold(btn, step);
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
    // 释放监听到 window 上：手指滑出按钮再松开也要停
    window.addEventListener('pointerup', endHold);
    window.addEventListener('pointercancel', endHold);

    document.getElementById('reset-btn').addEventListener('click', function () {
      endHold();
      applyDelay(0);
    });

    // 桌面键盘：← → 调 1ms，Shift + ← → 调 10ms
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const step = (e.shiftKey ? T.DEFAULTS.stepCoarse : T.DEFAULTS.stepFine) *
                   (e.key === 'ArrowRight' ? 1 : -1);
      e.preventDefault();
      applyDelay(state.delay + step);
    });
  }
```

在 `collectElements()` 末尾（`lit = new Array(...)` 之后）追加一行，把按钮也收进来：

```js
    wireControls();
```

- [ ] **Step 2: 把 `applyDelay` 暴露出来以便调试**

把 `SDT.app` 那一段换成：

```js
  SDT.app = {
    state: state,
    applyDelay: applyDelay,
    renderIndicator: renderIndicator,
    renderReadout: renderReadout
  };
```

- [ ] **Step 3: 在浏览器里验证**

打开 `index.html`，点页面任意位置启动（同 Task 5）。

Expected：
1. 点 `+10`，读数每次加 10；按住不放约 0.4s 后开始连发，越按越快；松手即停
2. 手指/鼠标**按住后滑出按钮再松开**，连发也要停
3. `+10` 连按 50 次以上，读数**停在 500 不动**
4. `−10` 一路按到 0 以下，读数**停在 0**
5. "归零"一键回到 0
6. 桌面按 `←` `→` 各动 1ms，`Shift+←` `Shift+→` 各动 10ms
7. **调延迟时节奏不中断**：连按 `+10` 期间，滴嗒声应当只有一个整体位移，不会出现某一拍重复响或整拍消失
8. 手机上（或 DevTools 设备模拟）长按按钮**不会**触发文字选中、也**不会**触发双击缩放

- [ ] **Step 4: 提交**

```bash
git add app.js
git commit -m "Add delay controls with press-and-hold repeat"
```

---

## Task 7: 总装 —— 启动、暂停、语言切换、前瞻调度

**Files:**
- Modify: `app.js`
- Delete: `app.css`、旧的 `app.js` 内容已被整体替换

- [ ] **Step 1: 加前瞻调度器与启动流程**

删掉 Task 5 留下的 `tempStart()` 以及那段临时的 `document.addEventListener('click', ...)`，换成下面这套：

```js
  // 前瞻调度：提前把音频排进 AudioContext 的采样级时间轴。
  // 绝不能等定时器到点了才发声 —— 移动端 setTimeout 抖动可达几十毫秒，
  // 比我们要测的量级还大。
  // 排哪些拍的判断全在 T.pendingBeats() 里（纯函数、有测试）。
  // 这里只负责把结果交给音频层 —— 判断逻辑一旦长出分支，就等于把最要命的代码
  // 藏进了没有覆盖的 DOM 胶水里。
  function pump() {
    if (!state.running || state.paused) return;
    const nowMs = SDT.audio.currentTime() * 1000;
    const r = T.pendingBeats(state.nextIndex, nowMs, state.originMs, state.delay,
                             state.beatMs, nowMs + LOOKAHEAD_MS);
    for (const n of r.indices) {
      const atMs = state.originMs + T.audioOffsetMs(n, state.beatMs, state.delay);
      SDT.audio.schedule(n, atMs / 1000);
    }
    state.nextIndex = r.nextIndex;
    SDT.audio.prune();
  }

  function restart() {
    SDT.audio.cancelPending();
    state.originMs = (SDT.audio.currentTime() + T.startLeadMs(state.beatMs) / 1000) * 1000;
    state.nextIndex = 0;
    pump();
  }

  function start() {
    if (!SDT.audio.isSupported()) {
      const err = document.getElementById('start-error');
      err.textContent = I18N.t('error.noAudio', currentLang);
      err.hidden = false;
      return;
    }
    SDT.audio.init();
    state.running = true;
    state.paused = false;
    restart();
    if (timerId) clearInterval(timerId);
    timerId = setInterval(pump, TIMER_MS);
    document.getElementById('start-overlay').hidden = true;
    document.getElementById('app').hidden = false;
    requestAnimationFrame(frame);
  }
```

- [ ] **Step 2: 加暂停与语言切换**

```js
  let currentLang = I18N.FALLBACK;

  function setLang(lang) {
    currentLang = lang;
    I18N.apply(lang, document);
    document.documentElement.lang = lang;
    document.getElementById('lang-btn').setAttribute('data-lang', lang);
    // 暂停按钮的文案随运行状态变，data-i18n 会把它写死，所以单独刷
    document.getElementById('pause-btn').textContent =
      I18N.t(state.paused ? 'controls.resume' : 'controls.pause', lang);
    I18N.save(lang);
  }

  function setPaused(paused) {
    state.paused = paused;
    if (paused) SDT.audio.suspend(); else SDT.audio.resume();
    document.getElementById('pause-btn').textContent =
      I18N.t(paused ? 'controls.resume' : 'controls.pause', currentLang);
  }

  function wireChrome() {
    document.getElementById('start-btn').addEventListener('click', start);

    document.getElementById('pause-btn').addEventListener('click', function () {
      setPaused(!state.paused);
    });

    document.getElementById('lang-btn').addEventListener('click', function () {
      setLang(currentLang === 'zh' ? 'en' : 'zh');
    });

    // 切回前台时若音频上下文被挂起，恢复它。
    // 因为一切以 ctx.currentTime 为准，不需要做任何重新对齐。
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.running && !state.paused) SDT.audio.resume();
    });
  }
```

- [ ] **Step 3: 接通预留的节拍间隔控件**

```js
  // 预留位：当前隐藏、不开放。但接线是通的，取消 hidden 即可生效。
  function wireIntervalSlot() {
    const input = document.getElementById('interval-input');
    if (!input) return;
    input.value = String(state.beatMs);
    input.addEventListener('change', function () {
      const v = Math.round(Number(input.value));
      if (!isFinite(v) || v < 200 || v > 1000) {
        input.value = String(state.beatMs);
        return;
      }
      state.beatMs = v;
      state.delay = T.clampDelay(state.delay, T.delayMax(v));
      renderReadout();
      if (state.running) restart();
    });
  }
```

- [ ] **Step 4: 替换初始化入口**

把 Task 5 里那段临时的 `document.addEventListener('DOMContentLoaded', ...)` 换成：

```js
  document.addEventListener('DOMContentLoaded', function () {
    collectElements();
    renderReadout();
    wireChrome();
    wireIntervalSlot();
    setLang(I18N.detect());
  });
```

注意 `wireControls()` 已经在 `collectElements()` 里调用了（Task 6 Step 1），不要重复调用。

- [ ] **Step 5: 删除废弃文件并最终提交**

```bash
git rm app.css
git add app.js index.html
git commit -m "Wire up start, pause, language switching and the lookahead scheduler"
```

`app.js` 是同名替换，`git add` 会记录修改。

- [ ] **Step 6: 全流程人工验收**

Run: `node tools/run-tests.js`
Expected: `30 passed, 0 failed`。

然后起一个本地静态服务（`file://` 下 `AudioContext` 可用，但用 `http://` 更接近真实环境）：

```bash
python3 -m http.server 8000
```

浏览器打开 `http://localhost:8000`，逐条走设计文档 §12 的人工清单：

1. 首屏是启动遮罩，中英双语；点"开始"后遮罩消失、声音立刻起来
2. 未点"开始"之前**完全没有声音**（浏览器自动播放策略）
3. 点"开始"后约 1.1s 静默，然后第一声"滴"响起，同时第 1 个点闪亮
4. 戴上蓝牙耳机，把延迟调到听觉与闪光重合 —— 这就是测量结果
5. 暂停 → 声音和动效**同时**冻结；继续 → 从原处接上，不跳变
6. 切到别的标签页再切回来 → 音画仍然同步（网页保持运行的前提下），并且**不会听到一串挤在一起的连响**（后台标签页的定时器被节流到约 1 秒一次，是这条路径最容易暴露的场景）。回来后音频会稀疏一阵再重新对齐到视觉网格上 —— 这是预期行为，不是故障
7. 点「中/EN」→ 全部文案（含底部两行小字）立即切换，**标签页标题也跟着变**（它靠 `<title data-i18n="app.title">`，容易被漏看），刷新后仍是上次选的语言
8. 手机 Chrome、iOS Safari 各走一遍上述流程；iOS 上确认静音拨片打开时仍有声

- [ ] **Step 7: 提交验收记录**

```bash
git add -A
git commit --allow-empty -m "Verify end-to-end manual acceptance checklist"
```

---

## Task 8: 浏览器自检页

让用户不装 Node 也能验证纯逻辑。

**Files:**
- Create: `tests.html`

- [ ] **Step 1: 写 `tests.html`**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>自检 / Self-test</title>
<style>
  body {
    margin: 0; padding: 24px;
    background: #0d1117; color: #eaf2fb;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px; line-height: 1.7;
  }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p.sub { color: #7d8899; margin: 0 0 18px; }
  .ok::before { content: "ok   "; color: #4cc9f0; }
  .fail::before { content: "FAIL "; color: #ff8f8f; }
  .fail { color: #ff8f8f; }
  .fail .why { display: block; color: #7d8899; padding-left: 5ch; }
  #summary { margin-top: 18px; padding-top: 12px; border-top: 1px solid #2c3949; font-weight: 600; }
  #summary.bad { color: #ff8f8f; }
</style>
</head>
<body>
<h1>自检 / Self-test</h1>
<p class="sub">纯逻辑部分。需要真实耳机和真实硬件的部分见设计文档 §12 的人工清单。</p>
<div id="results"></div>
<div id="summary"></div>

<script>
  window.SDT = window.SDT || {};
  var results = [];
  SDT.test = {
    run: function (name, fn) {
      try { fn(); results.push({ name: name, ok: true }); }
      catch (err) { results.push({ name: name, ok: false, error: err && err.message }); }
    }
  };
</script>
<script src="i18n.js"></script>
<script src="timing.js"></script>
<script src="tests.js"></script>
<script>
  (function () {
    var box = document.getElementById('results');
    var failed = 0;
    results.forEach(function (r) {
      var div = document.createElement('div');
      div.className = r.ok ? 'ok' : 'fail';
      div.textContent = r.name;
      if (!r.ok) {
        failed++;
        var why = document.createElement('span');
        why.className = 'why';
        why.textContent = r.error;
        div.appendChild(why);
      }
      box.appendChild(div);
    });
    var s = document.getElementById('summary');
    s.textContent = (results.length - failed) + ' passed, ' + failed + ' failed';
    if (failed) s.className = 'bad';
  })();
</script>
</body>
</html>
```

- [ ] **Step 2: 验证浏览器与 Node 结果一致**

Run: `node tools/run-tests.js`
Expected: `30 passed, 0 failed`

打开 `http://localhost:8000/tests.html`（用 Task 7 起的服务）。
Expected: 页面底部 `30 passed, 0 failed`，与终端结果条数一致。若不一致，说明 `tests.js` 依赖了只有某一侧才有的东西，回头改 `tests.js`，**不要**去改其中一侧的运行器。

- [ ] **Step 3: 提交**

```bash
git add tests.html
git commit -m "Add browser self-test page"
```

---

## Task 9: 响应式打磨与收尾

**Files:**
- Modify: `styles.css`（仅在实测发现问题时）
- Modify: `README.md`（新建，说明怎么用和怎么加语言）

- [ ] **Step 1: 逐档验证布局**

在 DevTools 里依次切到 320×568、390×844、768×1024（竖）、1024×768（横）、1440×900：
- 指示器、读数、四键在任何一档都不重叠、不溢出
- 宽屏下整列限宽 520px 居中，**指示器不会被拉宽**（拉宽会让扫描头跑太快，反而不好对齐）
- 横屏手机（高度小）时四键仍在首屏内，不需要滚动

任何一档不达标，改 `styles.css` 里的 `clamp()` 参数或断点，改完重跑一遍。

- [ ] **Step 2: 写 `README.md`**

```markdown
# 无线耳机延迟测试器

纯静态网页，无依赖、无构建。用来测蓝牙耳机的音频延迟。

## 怎么用

戴上耳机，点「开始」。页面会按固定节奏播放“滴嗒嗒哒”。用下面的按钮调整延迟值，
直到听感上声音与闪动的点完全重合 —— 屏幕上那个数字就是测得的延迟。

- 一排四键：外侧是 ±10ms 粗调，内侧是 ±1ms 微调；**按住不放会连续加速**
- 桌面还可以用 `←` `→` 调 1ms，`Shift + ←` `→` 调 10ms
- 量程 0–500ms。上限不能再高：拍间隔本身就是 500ms，延迟 d 和 d+500 看起来是一样的

读数还包含设备自身的音频与显示延迟（通常 10–40 ms），所以它适合横向比较耳机、
判断低延迟模式有没有生效，但不是实验室级绝对值。

## 本地运行

不需要构建。因为音频上下文和普通 script 在 `file://` 下都能用，直接双击
`index.html` 即可；想更接近真实环境就起个静态服务：

    python3 -m http.server 8000

## 跑测试

纯逻辑部分有断言，Node 和浏览器两边跑的是同一份 `tests.js`：

    node tools/run-tests.js        # 终端
    open http://localhost:8000/tests.html   # 浏览器

需要真实耳机和真实硬件的部分（iOS 静音拨片、长按连发、前后台切换等）
走人工清单，见 `docs/superpowers/specs/` 下的设计文档 §12。

## 加一门语言

在 `i18n.js` 的 `strings` 里加一个键（比如 `ja`），照 `zh` 把所有键补全。
`tests.js` 里有一条断言会检查所有语言的键集合一致，加完跑一次测试即可。
另外把 `resolve()` 里的语言探测规则补上，并在 `app.js` 的「中/EN」切换按钮上接入。

## 预留但未开放

`index.html` 里的 `#interval-slot` 是节拍间隔的用户调节位，当前 `hidden`。
去掉 `hidden` 即可生效 —— 接线是通的，改间隔会自动重算循环长度、扫描头行程和延迟上限。
```

- [ ] **Step 3: 最终全量验证**

```bash
node tools/run-tests.js
git status --short
```

Expected: `30 passed, 0 failed`；`git status` 除了待提交的文件外没有意外产物（`.superpowers/`、`.idea/` 已被 `.gitignore` 排除）。

- [ ] **Step 4: 提交**

```bash
git add README.md styles.css
git commit -m "Add README and finish responsive polish"
```

---

## 完成标准

- [ ] `node tools/run-tests.js` 全绿
- [ ] `tests.html` 在浏览器里结果与终端一致
- [ ] 手机 Chrome、iOS Safari 上完整走通一次测量
- [ ] 桌面 Chrome、平板横竖屏布局均不溢出
- [ ] 中英文切换即时生效且刷新后保持
- [ ] 暂停/继续、前后台切换后音画仍然同步
- [ ] 0 与 500 两个边界都钳得住
