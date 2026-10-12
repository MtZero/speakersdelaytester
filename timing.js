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
