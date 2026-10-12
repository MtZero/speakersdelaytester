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
  const SAFETY_MS = 20;

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

  // 满足 audioOffsetMs(n) > (now - origin) + safety 的最小 n，且不早于 0。
  function firstFutureIndex(nowMs, originMs, delayMs, beatMs, safetyMs) {
    const safe = (safetyMs === undefined) ? SAFETY_MS : safetyMs;
    const n = Math.floor((nowMs + safe - originMs + delayMs) / beatMs);
    return n < 0 ? 0 : n;
  }

  function clampDelay(v, max) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    const r = Math.round(v);
    if (r < 0) return 0;
    if (r > max) return max;
    return r;
  }

  function dotPosition(i, segments) { return (i + 1) / segments; }

  function beatAgeMs(tMs, i, beatMs, cycle) {
    let age = (tMs - beatMs * (i + 1)) % cycle;
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
        opacity: opacity < 0 ? 0 : opacity
      });
    }
    return out;
  }

  SDT.timing = {
    DEFAULTS: DEFAULTS,
    NEEDLE_SLOTS: NEEDLE_SLOTS,
    FADE_IN_MS: FADE_IN_MS,
    FADE_OUT_MS: FADE_OUT_MS,
    SAFETY_MS: SAFETY_MS,
    cycleMs: cycleMs,
    sweepMs: sweepMs,
    delayMax: delayMax,
    startLeadMs: startLeadMs,
    visualOffsetMs: visualOffsetMs,
    audioOffsetMs: audioOffsetMs,
    firstFutureIndex: firstFutureIndex,
    clampDelay: clampDelay,
    dotPosition: dotPosition,
    beatAgeMs: beatAgeMs,
    needles: needles
  };

})(typeof window !== 'undefined' ? window : globalThis);
