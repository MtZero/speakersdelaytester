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

      // e < 0.01 的短路只省掉"这一个点"的重写。衰减常数 70ms、阈值 0.01，
      // 意味着一个点每拍有 -70·ln(0.01) ≈ 322ms 处在阈值之上 ——
      // 整轮里仍约三分之二的帧在重绘。它不是便宜路径，别当性能保障。
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
