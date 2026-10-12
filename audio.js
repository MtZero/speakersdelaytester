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
  const CANCEL_CUTOFF_SEC = SDT.timing.CANCEL_CUTOFF_MS / 1000;
  const PRUNE_AFTER_SEC = 0.2;

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
    renderTone: renderTone,
    schedule: schedule,
    cancelPending: cancelPending,
    prune: prune,
    suspend: suspend,
    resume: resume
  };

})(typeof window !== 'undefined' ? window : globalThis);
