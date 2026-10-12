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

  // ─────────── 音频队列记账 ───────────
  // init() 是调用时才去取 root.AudioContext 的，所以可以先塞一个假的进去，
  // 驱动真实的 audio.js —— 不需要音频硬件，仍然跑在裸 vm 里。
  //
  // 两条限制写清楚，免得后人以为覆盖得比实际多：
  //   1. 测的是"我们的记账"，不是浏览器语义。stop() 能不能真的掐掉一个已排的声音，
  //      只有 Task 8 的浏览器自检页能验。
  //   2. ctx 在 audio.js 里是模块私有且只建一次，所以这组用例拥有本进程唯一那次 init()。
  run('audio 记账：取消边界与 timing 一致，且只停被取消的', function () {
    const made = [];
    function FakeCtx() {
      this.currentTime = 100;
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.createGain = function () { return { gain: { value: 1 }, connect: function () {} }; };
      this.createBuffer = function (ch, len) {
        return { getChannelData: function () { return new Float32Array(len); } };
      };
      this.createBufferSource = function () {
        const s = { buffer: null, stops: 0, connect: function () {}, start: function () {}, stop: function () { s.stops++; } };
        made.push(s);
        return s;
      };
      this.resume = function () { return Promise.resolve(); };
    }

    const realAC = root.AudioContext;
    root.AudioContext = FakeCtx;
    try {
      const a = SDT.audio;
      a.init();
      eq(a.state(), 'running');

      // 分界线是 now + CANCEL_CUTOFF_MS/1000 = 100.005
      a.schedule(0, 100.005);   // 恰好压线
      a.schedule(1, 100.004);   // 已经过去（等于正在播）
      a.schedule(2, 100.006);   // 还排得上

      const cancelled = a.cancelPending();
      eq(cancelled.join(','), '2',
         '只有严格大于分界线的才取消 —— 和 timing.js 的 pendingBeats 必须给出同一个判断');
      eq(made[2].stops, 1, '被取消的停一次');
      eq(made[0].stops, 0, '恰好压线的不停');
      eq(made[1].stops, 0, '已在播的不停 —— 不能把正在响的音掐断');
    } finally {
      root.AudioContext = realAC;
    }
  });

  // 连发曲线是 Task 6 里唯一有明确数值契约的东西，而它曾经住在 app.js 里 ——
  // 那里的代码既不被 Node 运行器加载，也没法被它加载（app.js 在顶层就绑 DOM）。
  // 搬进 timing.js 之后，每个档位两侧的边界都能钉住了。
  run('连发曲线：每个档位的两侧都钉住', function () {
    eq(T.HOLD_DELAY_MS, 380);
    eq(T.repeatIntervalMs(0), 110);
    eq(T.repeatIntervalMs(800), 110, '800 本身还在最慢档');
    eq(T.repeatIntervalMs(801), 70, '过 800 才进下一档');
    eq(T.repeatIntervalMs(1400), 70);
    eq(T.repeatIntervalMs(1401), 40);
    eq(T.repeatIntervalMs(2200), 40);
    eq(T.repeatIntervalMs(2201), 24);
    eq(T.repeatIntervalMs(10000), 24);
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

  // 长按连发的时序。放在这里而不是 app.js，就是为了能被测 ——
  // 它是设计文档 §8.2 写死的数值契约，不是随手调的手感参数。
  const HOLD_DELAY_MS = 380;
  // 按住越久连发越快：110ms → 70ms → 40ms → 24ms
  function repeatIntervalMs(heldMs) {
    if (heldMs > 2200) return 24;
    if (heldMs > 1400) return 40;
    if (heldMs > 800) return 70;
    return 110;
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
    HOLD_DELAY_MS: HOLD_DELAY_MS,
    repeatIntervalMs: repeatIntervalMs,
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
      'error.noAudio': '当前浏览器不支持 Web Audio，无法运行',
      'error.audioLost': '音频被系统中断，没能自动恢复。点下面的按钮重新开始。'
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
      'error.noAudio': 'This browser does not support Web Audio',
      'error.audioLost': 'Audio was interrupted by the system and could not recover. Tap below to restart.'
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
- Create: `styles.css`
- Delete: `app.css`、`app.js`（原型遗留；新实现分别在 Task 5 重建 `app.js`，`app.css` 不再需要）

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
  <div class="overlay-icon" aria-hidden="true">🎧</div>
  <h1 class="overlay-title" data-i18n="start.title"></h1>
  <p class="overlay-sub" data-i18n="start.subtitle"></p>
  <button id="start-btn" class="overlay-btn" type="button" data-i18n="start.button"></button>
  <p id="start-error" class="overlay-error" hidden></p>
  <!-- 必须待在遮罩内部。遮罩是 fixed + z-index:10 + 不透明背景铺满整屏，
       放在文档流里会被它整个盖住 —— 那等于写了一段看不见的补救。
       JS 开着时 noscript 的内容根本不参与渲染，不会影响正常布局。 -->
  <noscript>
    <p style="color: var(--fg-dim); font-size: 14px; line-height: 1.7; margin: 14px 0 0">
      这个页面需要 JavaScript 才能发声和计时。<br>
      This page needs JavaScript to produce sound and keep time.
    </p>
  </noscript>
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

  <div class="indicator" aria-hidden="true">
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

  <div class="readout" aria-live="polite"><span id="delay-value">0</span><span class="unit">ms</span></div>

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

  --dot-size: clamp(26px, 8vw, 38px);
  --tick-h: clamp(16px, 4.6vw, 24px);
  --needle-w: clamp(5px, 1.4vw, 7px);
  --needle-h: clamp(28px, 8vw, 40px);
  --stage-h: clamp(84px, 24vw, 116px);

  /* 两条基准线各只定义一次。点和刻度必须共用同一个 y，
     刻度、轨道、扫描头也必须共用同一个 y —— 否则"尺子"和"指针"会肉眼可见地对不齐。
     这两个数字是承重的，不是样式偏好。 */
  --dot-y: 19%;
  --track-y: 74%;

  /* 补几个一直散落在规则里的字面量。滴/嗒两色当初特意只留一个定义，
     中性色这边却在悄悄长重复值 —— 趁 Task 9 动手改数字之前收拢。 */
  --edge: #4a5d75;
  --edge-soft: #232e3c;
  --edge-press: #3a4d66;
  --fg-weak: #75808f;
  --fg-rgb: 234, 242, 251;
  --dim-rgb: 125, 136, 153;
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
  /* 四个长写而不是 inset：inset 是 Safari 14.1+，而目标下限是 14+。
     少了它遮罩会退化成收缩盒子，而这是应用唯一的入口。 */
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
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
  border: 1px solid var(--edge);
  border-radius: 12px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.overlay-btn:active { background: var(--edge-press); }
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

/* ─────────── 指示器 ─────────── */

.indicator {
  background: var(--panel);
  border-radius: 16px;
  padding: 8px 20px 10px;
}
.stage { position: relative; height: var(--stage-h); }

/* 点：位置由 JS 写 left，垂直靠负 margin 居中在 --dot-y 这条线上。
   transform 留给 JS 做缩放脉冲，不参与定位。 */
.dot {
  --d: var(--dot-size);
  position: absolute;
  top: var(--dot-y);
  left: 0;
  width: var(--d);
  height: var(--d);
  margin-left: calc(var(--d) / -2);
  margin-top: calc(var(--d) / -2);
  border-radius: 50%;
  background: rgba(var(--dim-rgb), .12);
  will-change: transform;
}
.dot[data-beat="0"] { --d: calc(var(--dot-size) * 1.3); }

.track {
  position: absolute;
  left: 0;
  right: 0;
  top: var(--track-y);
  height: 4px;
  margin-top: -2px;
  border-radius: 2px;
  background: var(--slot);
  z-index: 0;
}

.tick {
  position: absolute;
  top: var(--track-y);
  left: 0;
  width: 3px;
  height: var(--tick-h);
  margin-top: calc(var(--tick-h) / -2);
  margin-left: -1.5px;
  border-radius: 2px;
  background: rgba(var(--dim-rgb), .2);
  /* z-index 高于轨道：否则不透明的轨道会横穿刻度中间，把闪光切成两截 */
  z-index: 1;
}

.needle {
  position: absolute;
  top: var(--track-y);
  left: 0;
  width: var(--needle-w);
  height: var(--needle-h);
  margin-top: calc(var(--needle-h) / -2);
  margin-left: calc(var(--needle-w) / -2);
  border-radius: 3px;
  background: var(--fg);
  box-shadow: 0 0 14px rgba(var(--fg-rgb), .7);
  opacity: 0;
  z-index: 2;
  /* 只有 opacity 值得提示。left 是布局属性，浏览器没法把它交给合成器 ——
     写 will-change: left 等于在文件里编进一个假的成本模型。 */
  will-change: opacity;
}

/* ─────────── 读数与按钮 ─────────── */

.readout {
  text-align: center;
  margin: 20px 0 18px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.readout #delay-value {
  /* 固定宽度并右对齐：否则 9→10、99→100 时数字和 ms 会整体横移，
     长按连发时这种抖动最明显，仪表盘上看着像不稳定 */
  display: inline-block;
  min-width: 4ch;
  text-align: right;
  font-size: clamp(44px, 14vw, 60px);
  font-weight: 600;
  letter-spacing: -.02em;
}
.readout .unit {
  font-size: 15px;
  color: var(--fg-dim);
  margin-left: 6px;
}

.buttons { display: flex; gap: 9px; margin-bottom: 9px; }
.buttons.sub { margin-bottom: 0; }

/* 长按调整是这应用最主要的操作。manipulation 仍然允许平移，
   手指稍一滑动就可能被判成滚动、触发 pointercancel 掐断连发。 */
.btn.step { touch-action: none; }

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
.btn.held, .btn:active { background: var(--press); border-color: var(--edge); transform: scale(.97); }
.buttons.sub .btn {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-dim);
  padding: 9px 4px;
  background: transparent;
  border-color: var(--edge-soft);
}

.btn:focus-visible, .tool:focus-visible, .overlay-btn:focus-visible {
  outline: 2px solid var(--fg-dim);
  outline-offset: 2px;
}

/* ─────────── 底部提示 ─────────── */

.foot { margin-top: auto; padding-top: 18px; text-align: center; }
/* 两行都必须读得清。原来 hint 是 3.25:1、caveat 是 2.17:1，都低于小字要求的 4.5:1 ——
   而 caveat 恰恰是那句"读数含设备自身延迟、不是绝对值"，写得看不见等于没写。
   现在 hint 5.28:1、caveat 4.72:1，仍保留"第二行更弱"的层次。 */
.foot-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--fg-dim); }
.foot-caveat { margin: 6px 0 0; font-size: 11px; line-height: 1.6; color: var(--fg-weak); }
```

- [ ] **Step 3: 删掉原型遗留文件**

旧 `app.js` 在加载时会注册一个点击处理器，而它引用的 `#tts` / `#delay` 在新结构里都不存在 —— 点一下页面就抛异常。它的内容从 Task 5 起被完全重写，所以这里直接删掉。

```bash
git rm app.css app.js
```

- [ ] **Step 4: 在浏览器里核对结构**

打开 `index.html`。控制台会报 `audio.js` 和 `app.js` 找不到 —— **这是预期的**，它们分别在 Task 4 和 Task 5 才创建。

此时所有挂着 `data-i18n` 的位置都是**空白**（文案由 JS 写入，而 `app.js` 还没接线），而且 4 个点、4 个刻度全都叠在最左边（x 坐标由 Task 5 的 JS 写）。在控制台跑下面这段，把文案填上、把坐标摆开：

```js
SDT.i18n.apply(SDT.i18n.detect(), document);
document.getElementById('start-overlay').hidden = true;
document.getElementById('app').hidden = false;
document.querySelectorAll('.dot, .tick').forEach(function (el) {
  el.style.left = ((Number(el.dataset.beat) + 1) * 20) + '%';   // 20/40/60/80%
});
```

（`(i + 1) * 20%` 就是 `timing.js` 的 `dotPosition(i, segments)` —— 5 段 4 点。Task 5 里这两件事都由 `app.js` 做，这里只是让人眼能提前看到布局。）

Expected（对照已确认的原型 `.superpowers/brainstorm/90265-1791777941/content/page-layout.html`）：

- 顶部一行：标题在左，「中/EN」和暂停按钮在右
- 指示器是一块深色面板：上排 4 个点（第一个略大）、下排一条轨道带 4 个刻度，**刻度正对在点的下方**
- 一个很大的 `0 ms`
- 一排四个按钮 `−10 −1 +1 +10`，下面一行「归零」
- 底部两行小字（第二行更小更暗）
- 窄窗口（320px）下不溢出；拉宽到 900px 以上时整列限宽居中，**指示器不会被拉长**

动效和声音都还没有，那是 Task 5 之后的事。这一步只看结构、层级和比例。

- [ ] **Step 5: 确认没有误伤**

这一步没碰任何 JS，但跑一下确认：

Run: `node tools/run-tests.js`
Expected: `30 passed, 0 failed`。

- [ ] **Step 6: 提交**

```bash
git add index.html styles.css
git commit -m "Add page skeleton and styles"
```

---

## Task 4: 音频引擎 —— 音色合成

**没有自动化测试**：需要真实音频硬件，见设计文档 §12。验收放在 Task 8 的应用总装之后。

**Files:**
- Create: `audio.js`
- Modify: `tests.js`（在末尾、闭合之前追加两组用例）

- [ ] **Step 1: 追加失败的测试**

在 `tests.js` 末尾、`})(typeof window !== 'undefined' ? window : globalThis);` 之前插入：

```js
  // ─────────── 音色合成 ───────────
  // renderTone 是纯函数（只吃采样率和参数，返回 Float32Array），所以这些断言
  // 不需要音频硬件就能跑。"首尾必须归零"这条尤其值得测 —— 否则会爆音，
  // 而爆音只能靠耳朵发现，正是最容易漏掉的那类缺陷。

  run('audio.renderTone: 首尾精确归零、峰值受控、时长正确', function () {
    const spec = SDT.audio.TONES.di;
    const sr = 48000;
    const data = SDT.audio.renderTone(spec, sr);

    eq(data.length, Math.round(sr * spec.ms / 1000), '时长');
    eq(data[0], 0, '第一个样本必须精确为 0');
    eq(data[data.length - 1], 0, '最后一个样本必须精确为 0');

    let peak = 0, peakAt = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) { peak = a; peakAt = i; }
    }
    eq(peak <= spec.gain + 1e-6, true, '峰值不应超过设定增益，实际 ' + peak.toFixed(4));
    eq(peak > spec.gain * 0.6, true, '峰值也不该远低于设定增益，实际 ' + peak.toFixed(4));
    eq(peakAt / sr <= 0.005, true,
       '峰值应落在起音后 5ms 内，实际 ' + (peakAt / sr * 1000).toFixed(2) + 'ms —— ' +
       '延迟测试靠的是这个瞬态，起音拖长了听感上的"时刻"就会往后飘');
  });

  run('audio: 滴比嗒频率高，且四个音等长', function () {
    eq(SDT.audio.TONES.di.freq > SDT.audio.TONES.da.freq, true, '滴必须比嗒高，否则听不出"滴嗒嗒哒"');
    eq(SDT.audio.TONES.di.freq, 1600);
    eq(SDT.audio.TONES.da.freq, 1100);
    eq(SDT.audio.TONES.di.ms, SDT.audio.TONES.da.ms, '等长，节奏才均匀');
    eq(SDT.audio.TONES.di.ms, 50);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node tools/run-tests.js`
Expected: 新增 2 个用例 `FAIL`，错误是 `Cannot read properties of undefined (reading 'TONES')`；原有 30 个仍 `ok`；最后一行 `30 passed, 2 failed`，退出码 1。

- [ ] **Step 3: 写 `audio.js`**

```js
(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};

  // 丙方案：3ms 陡峭起音 + 指数衰减。
  // 延迟测试靠的是起音瞬态 —— 余弦窗虽然也短，但起音被抹圆，
  // 听感上的"时刻"会往后飘十几毫秒，正是我们要测的量级。
  // 这三个数值是用户戴着耳机试听三组候选后选定的，不要"优化"。
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

  // 一轮几拍归 timing.js 管。写死字面量的话，哪天周期长度一改，
  // 计时和视觉都跟着变，只有音频层还在傻傻地按 4 拍一组播"滴嗒嗒哒"。
  const BEATS_PER_CYCLE = SDT.timing.DEFAULTS.beats;

  let ctx = null;
  let master = null;
  let buffers = { di: null, da: null };
  let pending = [];                  // { src, time, index }

  function isSupported() {
    return !!(root.AudioContext || root.webkitAudioContext);
  }

  // 纯计算：只吃采样率和音色参数，返回 Float32Array，不碰 AudioContext。
  // 抽成纯函数是为了能测 —— "首尾必须归零、不然会爆音"这条要求
  // 否则只能靠耳朵听，而爆音恰恰是最容易漏掉的那种缺陷。
  function renderTone(spec, sampleRate) {
    const n = Math.max(2, Math.round(sampleRate * spec.ms / 1000));
    const data = new Float32Array(n);
    const attack = Math.max(1, Math.round(sampleRate * ATTACK_SEC));
    const tail = Math.max(2, Math.round(sampleRate * TAIL_SEC));   // >=2，否则下面的 (tail-1) 除零
    const decay = sampleRate * DECAY_SEC;

    for (let i = 0; i < n; i++) {
      let env = Math.min(1, i / attack) * Math.exp(-i / decay);
      // 端点包含式淡出：i = n-1 时正好是 0，不留下 1/tail 的残值
      if (i > n - tail) env *= (n - 1 - i) / (tail - 1);
      data[i] = Math.sin(2 * Math.PI * spec.freq * i / sampleRate) * env * spec.gain;
    }
    return data;
  }

  function toBuffer(samples) {
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
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

    buffers.di = toBuffer(renderTone(TONES.di, ctx.sampleRate));
    buffers.da = toBuffer(renderTone(TONES.da, ctx.sampleRate));
    return ctx;
  }

  function currentTime() { return ctx ? ctx.currentTime : 0; }
  function state() { return ctx ? ctx.state : 'none'; }

  function requireCtx() {
    if (!ctx) throw new Error('SDT.audio: 先调用 init()');
  }

  function schedule(beatIndex, atSeconds) {
    requireCtx();
    const src = ctx.createBufferSource();
    src.buffer = (beatIndex % BEATS_PER_CYCLE === 0) ? buffers.di : buffers.da;
    src.connect(master);
    src.start(atSeconds);
    pending.push({ src: src, time: atSeconds, index: beatIndex });
  }

  // 取消所有尚未开始播放的已排音频，返回被取消的拍号。
  // 已经开始播的不动 —— 音长只有 50ms，让它自然收尾，避免中途掐断产生爆音。
  function cancelPending() {
    requireCtx();
    const cutoff = ctx.currentTime + CANCEL_CUTOFF_SEC;
    const kept = [];
    const cancelled = [];
    for (const p of pending) {
      if (p.time > cutoff) {
        // 规范里"已经响完再 stop"是无操作；会抛的是"start 之前就 stop"，
        // 而 schedule() 永远先 start 再记账，所以那条路走不到。
        // 留着 catch 是给老版本 WebKit 兜底，不是因为它按规范会抛。
        try { p.src.stop(); } catch (e) {}
        cancelled.push(p.index);
      } else {
        kept.push(p);
      }
    }
    pending = kept;
    return cancelled;
  }

  function prune() {
    requireCtx();
    const cutoff = ctx.currentTime - PRUNE_AFTER_SEC;
    pending = pending.filter(function (p) { return p.time > cutoff; });
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }

  // 不能只判断 'suspended'。iOS/macOS Safari 在来电、Siri、闹钟、锁屏之后会把
  // ctx.state 置成非标准的 'interrupted'（不在规范里），此时旧写法是静默空操作：
  // currentTime 冻结、指示器跟着冻住，而 state.paused 还说是"在跑" ——
  // 仪器看着活着其实已经死了，只能刷新。对一个全靠读数可信的工具，这是最坏的失效方式。
  function resume() {
    if (!ctx) return;
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      // 这里吞掉拒绝，只是为了不让它变成未处理的 promise rejection ——
      // 并不是说失败可以不管。允许调用了不等于真的恢复了：WebKit 在刚被打断之后
      // 有可能拒绝。所以真正的兜底在调用方：Task 7 切回前台时会复查 state()，
      // 不恢复就把话说出来，而不是让仪器静默地假活。
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 某些 WebKit 版本在这里同步抛 */ }
  }

  SDT.audio = {
    TONES: TONES,
    isSupported: isSupported,
    init: init,
    currentTime: currentTime,
    state: state,
    renderTone: renderTone,
    schedule: schedule,
    cancelPending: cancelPending,
    prune: prune,
    suspend: suspend,
    resume: resume
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: 运行测试，确认全绿**

Run: `node tools/run-tests.js`
Expected: 34 × `  ok  <name>`，最后一行 `34 passed, 0 failed`，退出码 0。

注意最后那条 `audio 记账` 用例在补丁前后都是绿的 —— 原来的 `cancelPending` 本来就用了严格的 `>`。它是**钉住既有行为**的测试，不是红绿循环。它的价值要靠变异测试来确认：把 `p.time > cutoff` 改成 `>=`，它必须失败。

`tools/run-tests.js` 的 `APP_SCRIPTS` 里已经包含 `audio.js`，所以这一步顺带验证了它能在裸 vm 里求值。

`audio.js` 顶层只有 `const`/`function` 声明和最后的 `SDT.audio = {...}`，不碰 `document` 也不碰 `AudioContext`；`init()` 不会被调用，所以不会抛异常。

- [ ] **Step 5: 提交**

```bash
git add audio.js tests.js
git commit -m "Add audio engine with a testable tone synthesiser"
```

---

## Task 5: 指示器渲染

**Files:**
- Create: `app.js`
- Modify: `i18n.js`（补一个键，见 Step 0）

- [ ] **Step 0: 补上 `error.audioLost` 文案**

`i18n.js` 的两种语言表里各加一条：

```js
      'error.audioLost': '音频被系统中断，没能自动恢复。点下面的按钮重新开始。',
```
```js
      'error.audioLost': 'Audio was interrupted by the system and could not recover. Tap below to restart.',
```

Task 7 要用它。之所以现在就补：`t()` 在缺键时**回落到键名本身**（这是有意的设计，便于排查），所以漏了它会安静地在界面上显示成字面量 `error.audioLost`，而键一致性测试照样通过 —— 那是测试体系看不见的一个洞。补完跑一次 `node tools/run-tests.js`，确认仍是 `34 passed, 0 failed`（键一致性用例遍历整张表，会自动覆盖新键）。

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
  let lit = [];          // 每个点上一次是否处于"亮"的状态：null=没画过 / true=亮 / false=暗

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
      readout: document.querySelector('.readout'),
      delayValue: document.getElementById('delay-value')
    };
    lit = new Array(dots.length).fill(null);   // null = 还没画过，见 renderIndicator
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

  // tMs 是相对 origin 的毫秒时间。
  function renderIndicator(tMs) {
    const beatMs = state.beatMs;
    const cycle = T.cycleMs(beatMs, state.beats);

    // 第一拍发生在 t = beatMs，在那之前一个点都不该亮。
    // 不能直接信 beatAgeMs 的返回值：它对负数时间做环回取模（那是它有意为之、也有测试钉住的行为），
    // 于是 t = -1000 会算出"第 1 个点恰好刚闪过"、t = 0 则轮到最后一个点 ——
    // 用户点完开始会先看到三次没有声音对应的幽灵闪，然后才听到第一声。
    // 整段前导必须是空的：先静着，然后第一声"滴"和第 1 个点的闪光一起出现。
    const flashing = tMs >= beatMs;

    for (let i = 0; i < els.dots.length; i++) {
      const e = flashing
        ? Math.exp(-T.beatAgeMs(tMs, i, beatMs, cycle) / FLASH_DECAY_MS)
        : 0;
      const rgb = i === 0 ? WARM : COOL;
      const idle = i === 0 ? IDLE_ALPHA_DI : IDLE_ALPHA;

      // e < 0.01 的短路只省掉"这一个点"的重写。单个点每 2000ms 才闪一次，
      // 而窗口是 -70·ln(0.01) ≈ 322ms —— 对它是 16%，不是"每拍 322/500"。
      // 四个点错开 500ms、互不重叠，合起来约 64% 的帧仍有某个点在重绘。
      // 它不是便宜路径，别当性能保障。
      // 还有：刻度压根没有这道短路，四个刻度每帧都写（值多半与上一帧相同，
      // 靠引擎自己去做去重，不靠我们）。
      //
      // 判断写 lit[i] !== false 而不是 if (lit[i])：lit 初值是 null，表示"这一帧还没画过"。
      // 用真值判断的话，从没亮过的点会一直挂着 CSS 里的中性灰占位色，
      // 而它正下方对应的刻度已经是彩色 —— 开局那一秒这个对比很扎眼。
      if (e < 0.01) {
        if (lit[i] !== false) {
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

  let lastTMs = null;

  // 渲染并记录 tMs。顺序是有意的：**渲染成功之后**才记录 ——
  // 渲染抛错时 lastTMs 保持旧值，下一帧会重试，而不是默默接受一次失败的渲染。
  // 抽成函数是为了让这个顺序只有一处定义，将来改动不会只改到一半的调用点。
  function renderAndRecord(tMs) {
    renderIndicator(tMs);
    lastTMs = tMs;
  }

  function frame() {
    // 先续下一次再渲染：万一渲染抛了错，循环不会就此永久死掉
    // （Task 7 用 frameStarted 挡住启动路径，一旦死掉就再也起不来了。
    //  持续报错虽然吵，但对一台仪器来说，比安静地停住好。）
    requestAnimationFrame(frame);

    const tMs = SDT.audio.currentTime() * 1000 - state.originMs;
    // 渲染是 tMs 的纯函数 —— 延迟只移动音频，而每次 restart 都会重设 originMs，
    // 所以 tMs 没变时重绘纯属白费。暂停、启动前、音频丢失之后都因此几乎不花代价。
    // 注意 lastTMs 记在渲染**之后**：渲染抛错时不更新，于是下一帧会再试一次。
    if (tMs === lastTMs) return;
    renderAndRecord(tMs);
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
    // 先把静息状态画上去，再揭开遮罩。否则浏览器会拿 CSS 里的中性灰占位色先画一帧，
    // 而手机上这一帧可能被同一个任务里的 AudioContext 构造拖到几十毫秒 ——
    // 看起来就是"点了开始先闪一下灰"。tMs = 0 落在前导段，画出来正好全是静息色、扫描头全隐藏。
    renderAndRecord(0);
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
    // 包一层：直接暴露 renderIndicator 的话，外部探针调用会绕过 lastTMs 的记账 ——
    // 时钟冻住时循环会以为"没变过"而跳过，面板就停在探针画的那个状态，直到时钟再动。
    renderIndicator: function (t) {
      renderAndRecord(t);
    },
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
- 点完「开始」后的前 1.1s **什么都不闪，扫描头也不出现**（它在 t=0 才开始淡入、同时从 0% 滑向 20%）。注意这段里四个点和四个刻度是在的、显示各自的静息色 —— 只是没有任何一个闪起来。然后第一声"滴"、第 1 个点的闪光、扫描头压到第 1 个刻度，三件事同时发生
- 每个点从**揭开遮罩的第一帧**起就显示自己的静息色（第 0 个暖色、其余冷色），**不能先闪一下 CSS 占位的中性灰**

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
  let holdTimer = null;
  let holdButton = null;
  let holdPointerId = null;

  function endHold() {
    // endHold 挂在 window 的 pointerup/pointercancel 上，也就是**应用里任何一次点击**
    // 都会走到这里。所以没有真的在连发时必须立刻返回：
    // 否则每次点击都会重写一遍读数、并且重新设置一次 aria-live —— 而重新登记一个
    // live region 有可能让它把自己的内容再念一遍（点一下别处就重念一次延迟值）。
    const wasHolding = holdButton !== null;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdButton) { holdButton.classList.remove('held'); holdButton = null; }
    holdPointerId = null;
    if (!wasHolding) return;

    // 先把 aria-live 恢复成 polite，再写一次读数 ——
    // 连发期间的每一次改动（包括最后一次）都发生在 off 状态，而"恢复 polite"本身
    // 不构成一次播报。补一次赋值才会产生 mutation，屏幕阅读器也就只念这一个最终值。
    els.readout.setAttribute('aria-live', 'polite');
    renderReadout();
  }

  // 只有发起这次连发的那根手指/那支笔有资格结束它。
  // 不辨来源的话：一根手指按住 +10、另一根手指点一下 -1 再抬起，
  // 会把 +10 的连发一并掐掉 —— 按钮看着还按着却不再响应，值也卡在中途。
  function endHoldFromPointer(e) {
    if (e.pointerId !== holdPointerId) return;
    endHold();
  }

  // 这里只管数值：夹取、刷新读数。
  // 音频那一半（取消已排、重排、pump）属于 Task 7 —— 调度器那时才存在。
  // 现在就把 pump() 写进去的话，它是个未声明的标识符，一点按钮就 ReferenceError；
  // 而 renderReadout() 在抛错之前已经执行，表现成"数字会动、别的地方坏了"，很难查。
  function applyDelay(next) {
    const clamped = T.clampDelay(next, T.delayMax(state.beatMs));
    if (clamped === state.delay) return;
    state.delay = clamped;
    renderReadout();
  }

  function beginHold(btn, step, pointerId) {
    endHold();
    holdButton = btn;
    holdPointerId = pointerId;
    btn.classList.add('held');
    // 连发时读数每秒要改几十次。aria-live 一直是 polite 的话，屏幕阅读器要么排队
    // 要么来不及处理；先关掉，松手时再打开，于是它只会念出最终值那一次。
    els.readout.setAttribute('aria-live', 'off');
    applyDelay(state.delay + step);

    const t0 = performance.now();
    function tick() {
      applyDelay(state.delay + step);
      holdTimer = setTimeout(tick, repeatIntervalMs(performance.now() - t0));
    }
    holdTimer = setTimeout(tick, HOLD_DELAY_MS);   // 按住 380ms 后开始连发
  }

> **一条要守住的隐式不变量（Task 7 注意）：** `aria-live="off"` 只有 `beginHold` 一处会写，
> 而且它就紧跟在 `holdButton = btn` 之后、同一个同步块里，没有事件能插进来。
> 所以恒有 **`aria-live === 'off'` ⇒ `holdButton !== null`** —— 这正是 `endHold` 那个早退安全的原因：
> 任何看到 `holdButton` 非空的 `endHold` 都会走恢复分支。
> **将来的代码若在别处把 `aria-live` 设成 `off` 而不设 `holdButton`，这条不变量就断了**，
> 之后随便点一下页面都会把它永久留在 `off`（从"多念一次"变成"永远不念"）。

  function wireControls() {
    const buttons = document.querySelectorAll('.btn.step');
    for (const btn of buttons) {
      const step = parseInt(btn.getAttribute('data-step'), 10);
      // 属性打错或漏了会得到 NaN，而 clampDelay 把非有限值当 0 ——
      // 于是那个按钮会静默地把用户的测量清零。宁可响亮地失败。
      if (!isFinite(step) || step === 0) {
        throw new Error('data-step 不是有效步长: ' + btn.outerHTML);
      }

      btn.addEventListener('pointerdown', function (e) {
        // 鼠标不要 preventDefault：它会连带压掉 mousedown 的默认动作（把焦点交给按钮），
        // 于是点过的按钮不会成为 Tab 的起点。触摸才需要拦，防的是长按选中和双击缩放 ——
        // 而这两件事 CSS 里本来就都覆盖了（.btn 的 user-select、.btn.step 的 touch-action）。
        if (e.pointerType !== 'mouse') e.preventDefault();
        beginHold(btn, step, e.pointerId);
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

      // 键盘和辅助技术激活 <button> 时派发的是合成 click，pointerdown 根本不会触发 ——
      // 只接 pointerdown 的话，聚焦到按钮再按回车是没有反应的。
      // detail === 0 是合成点击（键盘/AT），鼠标和触摸是 1，用它避免一次按压走两步。
      btn.addEventListener('click', function (e) {
        if (e.detail !== 0) return;
        applyDelay(state.delay + step);
        // 已经到边界（0 或 500）时再按就没有变化了，而屏幕阅读器只对变化有反应 ——
        // 键盘/AT 用户会完全收不到任何反馈。补写一次产生 mutation，把当前值念出来。
        renderReadout();
      });
    }
    // 释放监听到 window 上：手指滑出按钮再松开也要停。
    // 用 endHoldFromPointer 而不是 endHold —— 只有发起那次连发的指针才能结束它。
    window.addEventListener('pointerup', endHoldFromPointer);
    window.addEventListener('pointercancel', endHoldFromPointer);

    // 释放事件有可能永远不来：按住时 Alt+Tab 切走、弹出权限框、在窗口外松手。
    // 不兜底的话连发会一直跑下去 —— 值卡在边界、.held 一直亮着，
    // 而且 aria-live 停在 off，读数从此不再播报。三个都是便宜的兜网，endHold 本身幂等。
    window.addEventListener('blur', endHold);
    window.addEventListener('pagehide', endHold);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) endHold();
    });

    // Task 7 会把它改成走 restart()（理由见那里）。现在只改数值。
    document.getElementById('reset-btn').addEventListener('click', function () {
      endHold();
      applyDelay(0);
    });

    // 桌面键盘：← → 调 1ms，Shift + ← → 调 10ms
    window.addEventListener('keydown', function (e) {
      // 还没开始就不要改值：那时读数藏在 hidden 的容器里，按了没有任何可见反馈，
      // 却已经把延迟预设成了一个非零值。
      if (!state.running) return;
      // 带修饰键的一律放行：Safari 里 Cmd+← 是"后退"，Windows 上 Chrome 的 Alt+← 也是。
      // 拦下来会把它变成改延迟值 —— 用户想返回上一页，结果静默改掉了自己的测量，
      // 浏览器那边也没有跳转。这一条在目标平台上随时可复现。
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing) return;                    // 输入法组合中，方向键是在选字
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target;
      const tag = (target && target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (target && target.isContentEditable) return;   // 可编辑区域内部的元素 tagName 不是 INPUT
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
    // 包一层：直接暴露 renderIndicator 的话，外部探针调用会绕过 lastTMs 的记账 ——
    // 时钟冻住时循环会以为"没变过"而跳过，面板就停在探针画的那个状态，直到时钟再动。
    renderIndicator: function (t) {
      renderAndRecord(t);
    },
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
8. 手机上（或 DevTools 设备模拟）长按按钮**不会**触发文字选中、也**不会**触发双击缩放

- [ ] **Step 5: 提交**

```bash
git add app.js
git commit -m "Add delay controls with press-and-hold repeat"
```

---

## Task 7: 总装 —— 启动、暂停、语言切换、前瞻调度

**Files:**
- Modify: `app.js`
- Modify: `i18n.js`（加 `error.audioLost`，两种语言都要加；键一致性测试会自动覆盖它）
  —— 注意它已经写在本计划 Task 2 的 `i18n.js` 代码块里了，所以实际文件可能**已经**有这个键。
  先 `grep audioLost i18n.js` 确认，缺了才补，别重复添加。

- [ ] **Step 1: 加前瞻调度器与启动流程**

删掉 Task 5 留下的 `tempStart()` 以及那段临时的 `document.addEventListener('click', ...)`。

同时把模块顶部声明 `els` / `lit` 的那两行改成：

```js
  let els = null;
  let lit = [];                // 每个点上一次是否处于"亮"的状态：null=没画过 / true=亮 / false=暗
  let timerId = null;          // 调度器轮询句柄
  let frameStarted = false;    // 见 start()：音频丢失后遮罩会回来，用户再点一次时不能叠第二个 rAF 循环
```

（`LOOKAHEAD_MS`、`TIMER_MS` 和 `I18N` 留在 Task 5 不动 —— 它们在设计文档 §4 的常量表里，是公开的调度契约而不是随手的状态；Task 7 起就会用到。真正该跟着使用处走的是 `timerId` 这种局部状态。）

然后换成下面这套：

```js
  // 前瞻调度：提前把音频排进 AudioContext 的采样级时间轴。
  // 绝不能等定时器到点了才发声 —— 移动端 setTimeout 抖动可达几十毫秒，
  // 比我们要测的量级还大。
  // 排哪些拍的判断全在 T.pendingBeats() 里（纯函数、有测试）。
  // 这里只负责把结果交给音频层 —— 判断逻辑一旦长出分支，就等于把最要命的代码
  // 藏进了没有覆盖的 DOM 胶水里。
  function pump() {
    if (!state.running || state.paused) return;
    // 时钟冻住时（WebKit 的 interrupted，或页面隐藏）不能继续排：
    // 那样最多有一拍会落在 120ms 前瞻窗内，而它的时刻是"过去"，
    // 恢复时会被立刻播放 —— 就是设计里费力避免的"两声挤在一起"。
    if (SDT.audio.state() !== 'running') return;
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

  // 把 Task 6 留下的 applyDelay 补成完整的：数值之外，还要把音频重排。
  // （Task 6 里写不得 —— 那时 pump() 还不是个已声明的函数。）
  //
  // 在 applyDelay 的 renderReadout() 之后追加：
  //
  //     if (!state.running) return;
  //     // 取消已排但还没响的音频，再从"被取消的最小拍号"和"第一个仍在未来的拍号"里取大的那个续排。
  //     // 两个约束缺一不可（会多一声 / 会炸响），推导见 timing.js 里 resumeIndex 的注释和设计文档 §5.4。
  //     const cancelled = SDT.audio.cancelPending();
  //     state.nextIndex = T.resumeIndex(
  //       state.nextIndex, cancelled,
  //       SDT.audio.currentTime() * 1000, state.originMs, state.delay, state.beatMs
  //     );
  //     pump();
  //
  // 并把归零按钮改成走 restart() 而不是 applyDelay(0)：延迟一次跳太多时，
  // 过渡那一拍的旧音和新音可能落在几十毫秒内 —— 两个起音挤在一起，恰好污染了这个应用要测量的那个量。
  // 重启会先取消所有已排音频并重新起一轮（1.1s 的前导足够任何在响的音收尾），
  // 顺带"从左边重新开始"也更贴合"归零"的语义。
  //
  //   document.getElementById('reset-btn').addEventListener('click', function () {
  //     endHold();
  //     state.delay = 0;
  //     renderReadout();
  //     if (state.running) restart();
  //   });

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
    // start() 一定跑在用户手势里，而手势正是浏览器允许恢复音频的唯一时机 ——
    // 从"音频被系统打断"里回来就靠这一下（见下面的 showAudioLost）。
    SDT.audio.resume();
    state.running = true;
    state.paused = false;
    restart();
    if (timerId) clearInterval(timerId);
    timerId = setInterval(pump, TIMER_MS);
    // 揭开遮罩之前先把静息状态画上去：否则浏览器会拿 CSS 里的中性灰占位色先画一帧，
    // 而手机上这一帧可能被同一个任务里的 AudioContext 构造拖到几十毫秒。
    // tMs = 0 落在前导段，画出来全是静息色、扫描头全隐藏，不会误闪。
    // 顺序要紧：必须在 #app 变可见**之前**。
    renderAndRecord(0);
    document.getElementById('start-overlay').hidden = true;
    document.getElementById('app').hidden = false;
    document.getElementById('start-error').hidden = true;
    // 手势这条路径同样要复查：WebKit 也可能连手势里的 resume() 一起拒绝。
    // 只在切后台那条路复查的话，这里会静默地把 state.running 置成 true 再撤掉遮罩，
    // 用户又回到一个冻住的指示器前面 —— 正好是这整套机制要消灭的那种失效。
    watchForAudioLoss();
    // 只起一次：音频丢失后遮罩会重新出现，用户再点一次 start() 时
    // 不能再叠一个 rAF 循环，否则每帧渲染两遍
    if (!frameStarted) {
      frameStarted = true;
      requestAnimationFrame(frame);
    }
  }

  // 恢复是异步的，"允许调用"不等于"已经恢复"。隔一会儿复查一次：
  // 只有 state.paused 还说好、实际已经冻住的情况才需要说话。
  //
  // !document.hidden 不能省：没有 navigator.audioSession 的浏览器
  // （iOS Safari 14/15 就是，在支持范围内）页面隐藏时 ctx 本来就不是 running。
  // 少了这一条，用户回到页面后 600ms 内又切走，就会看到一条假的"音频已丢失" ——
  // 在这条专门用来"让用户能信任界面"的路径上，误报的代价尤其高。
  function watchForAudioLoss() {
    setTimeout(function () {
      if (state.running && !state.paused && !document.hidden &&
          SDT.audio.state() !== 'running') {
        showAudioLost();
      }
    }, 600);
  }

  // 音频被系统打断且没能自动恢复。这时 ctx.currentTime 已经冻住，
  // 指示器跟着冻住，但界面看着一切正常 —— 用户会对着一个假活的仪器读数。
  // 与其静默，不如把遮罩放回来：恢复音频需要用户手势，而遮罩正是收集手势的地方。
  function showAudioLost() {
    state.running = false;
    if (timerId) { clearInterval(timerId); timerId = null; }
    state.paused = false;
    const err = document.getElementById('start-error');
    err.textContent = I18N.t('error.audioLost', currentLang);
    err.hidden = false;
    document.getElementById('start-overlay').hidden = false;
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
    // 切回前台时恢复音频。因为一切以 ctx.currentTime 为准，恢复本身不需要重新对齐。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !state.running || state.paused) return;
      SDT.audio.resume();
      watchForAudioLoss();
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
      // frame() 的早退是按"tMs 是否变过"判断的，前提是渲染是 tMs 的纯函数。
      // 改了 beatMs 之后这个前提就不再成立（同样的 tMs 对应不同画面），
      // 所以必须让缓存失效；restart() 会重设 originMs 从而改变 tMs，
      // 但那是在 state.running 时才会发生 —— 不运行时就得手动清。
      lastTMs = null;
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
git add app.js
git commit -m "Wire up start, pause, language switching and the lookahead scheduler"
```

- [ ] **Step 6: 全流程人工验收**

Run: `node tools/run-tests.js`
Expected: `34 passed, 0 failed`。

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
6. **调延迟时节奏不中断** —— 而且要在**按住 `+10` 不放**的时候看，不只是点按。按住时 `applyDelay` 会以每秒约 40 次的频率跑「取消已排 + 重排」，是这套设计遇到过的最高速率。滴嗒声应当只有一个整体位移，不会出现某一拍重复响或整拍消失
7. **按住 `+10`，Alt+Tab 切走，在别处松开鼠标再回来** —— 连发必须已经停了，按钮不能还亮着。这类释放事件浏览器可能根本不会送过来，代码里布了兜网；这是唯一一条没人会碰巧走到的路径，所以要专门试
8. 切到别的标签页再切回来 → 音画仍然同步（网页保持运行的前提下），并且**不会听到一串挤在一起的连响**（后台标签页的定时器被节流到约 1 秒一次，是这条路径最容易暴露的场景）。回来后音频会稀疏一阵再重新对齐到视觉网格上 —— 这是预期行为，不是故障
9. 点「中/EN」→ 全部文案（含底部两行小字）立即切换，**标签页标题也跟着变**（它靠 `<title data-i18n="app.title">`，容易被漏看），刷新后仍是上次选的语言
10. 手机 Chrome、iOS Safari 各走一遍上述流程；iOS 上确认静音拨片打开时仍有声
11. **iOS 实测音频打断**：播放中锁屏再解锁，或触发一次来电/Siri，然后切回页面 —— 声音和动效必须都恢复。这是设计文档 §11 记的那条残余风险：`resume()` 现在会尝试恢复，但 WebKit 允许调用不等于真的成功。若回来之后指示器还在动、数字却不再跟随节奏（或干脆冻住），就是中招了 —— 那时要加一条明确的"请重新加载"提示，别让用户对着一个假活的仪器读数

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
<p class="sub">纯逻辑与音频记账部分。真正需要音频硬件和真实耳机的部分见设计文档 §12 的人工清单。</p>
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
<script src="audio.js"></script>
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
Expected: `34 passed, 0 failed`

打开 `http://localhost:8000/tests.html`（用 Task 7 起的服务）。
Expected: 页面底部 `34 passed, 0 failed`，与终端结果条数一致。若不一致，说明 `tests.js` 依赖了只有某一侧才有的东西，回头改 `tests.js`，**不要**去改其中一侧的运行器。

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

- [ ] **Step 1: 在一台真机上量一次闪光帧有多贵**

这是整个项目里唯一一个**靠推理定不了**的问题，必须实测。每帧要重写 `box-shadow`，
而且**模糊半径本身在变**（`GLOW_DOT_PX * e`）—— sigma 一变，那块阴影就得从零重新光栅化。
在手机尺寸下热点圆点的阴影面积约 99×99 CSS px（DPR 2 时约 4 万设备像素），
低端机上粗略 0.5–2ms。单看不算什么，但它是这个应用里**唯一**可能掉帧的东西，
而且掉在承载测量的那一帧上：闪光的上升沿就是从前一帧的静息直接跳到 `e = 1`，
所以"听到的时刻"就是第一个跨过该拍的帧。在那里掉一帧 ≈ 17ms 误差 ——
和设备自身那 10–40ms 延迟同一个量级。

做法（随便一台手机，Chrome 远程调试即可）：

1. DevTools → Performance，录一次约 10 秒的正常播放
2. 看每个闪光帧上 Paint / Raster 占 16.7ms 预算的比例
3. 再按住 `+10` 录一次（此时主线程还要跑连发的定时器），看会不会恶化

**判据**：看的是**有没有闪光帧的总耗时越过一帧预算** —— rAF 是按帧整帧交付的，掉一帧就是掉一帧，不会因为"平均很低"而没事。3ms 是个舒服的提前警戒线，不是及格线；手机上有别的东西尖峰时，8ms 也未必就安全。验收记录里**写明机型** —— "在我们手头这台手机上可以"是个有边界的结论，这个项目的其他结论也都是这么记的。

若确实超了，按下面顺序降级 ——
- 先试"模糊半径固定、只动颜色透明度"（几何不变，光栅有机会复用），视觉上仍然会亮起来
- 再试把半径调小（绘制面积按半径平方缩，30px→15px 约省 4 倍）
- 最后才考虑把光晕拆成独立图层、用静态模糊 + 动 `opacity`（纯合成，但要多加节点）

设计文档 §8.5 本来就写着"靠透明度做亮灭"，所以前两条不算改设计。

- [ ] **Step 2: 逐档验证布局**

在 DevTools 里依次切到 320×568、390×844、768×1024（竖）、1024×768（横）、1440×900：
- 指示器、读数、四键在任何一档都不重叠、不溢出
- 宽屏下整列限宽 520px 居中，**指示器不会被拉宽**（拉宽会让扫描头跑太快，反而不好对齐）
- 横屏手机（高度小）时四键仍在首屏内，不需要滚动

任何一档不达标，改 `styles.css` 里的 `clamp()` 参数或断点，改完重跑一遍。

**不要为了窗口变化加 `resize` 重新采集。** 点和刻度的位置本来就是百分比，窗口一变自动就对了；重新采集会重写 `left` 并重置 `lit[]`，而 `frame()` 的 `tMs` 早退缓存并不知道这件事 —— 会出现"位置变了但画面没重画"。真要加，必须同时把 `lastTMs` 置空。规则是：**任何在 `frame()` 之外改动渲染输入的地方，都要让 `lastTMs` 失效。** 目前只有节拍间隔那一处需要。

- [ ] **Step 3: 写 `README.md`**

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
**不需要改 `resolve()` 或 `t()`** —— 它们以文案表为准，表里有这门语言就认。

`tests.js` 里有一条断言会遍历整张表、检查所有语言的键集合一致，加完跑一次测试即可。
剩下要动的是纯 UI：`app.js` 里「中/EN」那个二选一按钮，以及 `styles.css` 里对应的高亮规则。

## 预留但未开放

`index.html` 里的 `#interval-slot` 是节拍间隔的用户调节位，当前 `hidden`。
去掉 `hidden` 即可生效 —— 接线是通的，改间隔会自动重算循环长度、扫描头行程和延迟上限。
```

- [ ] **Step 4: 最终全量验证**

```bash
node tools/run-tests.js
git status --short
```

Expected: `34 passed, 0 failed`；`git status` 除了待提交的文件外没有意外产物（`.superpowers/`、`.idea/` 已被 `.gitignore` 排除）。

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
