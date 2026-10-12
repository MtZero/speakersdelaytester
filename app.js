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
      delayValue: document.getElementById('delay-value')
    };
    lit = new Array(dots.length).fill(null);   // null = 还没画过，见 renderIndicator
    wireControls();
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
    // endHold 挂在 window 的 pointerup/pointercancel 上，也就是**应用里任何一次点击**
    // 都会走到这里。所以没有真的在连发时必须立刻返回：
    // 否则每次点击都会重写一遍读数、并且重新设置一次 aria-live —— 而重新登记一个
    // live region 有可能让它把自己的内容再念一遍（点一下别处就重念一次延迟值）。
    const wasHolding = holdButton !== null;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdButton) { holdButton.classList.remove('held'); holdButton = null; }
    if (!wasHolding) return;

    // 先把 aria-live 恢复成 polite，再写一次读数 ——
    // 连发期间的每一次改动（包括最后一次）都发生在 off 状态，而"恢复 polite"本身
    // 不构成一次播报。补一次赋值才会产生 mutation，屏幕阅读器也就只念这一个最终值。
    document.querySelector('.readout').setAttribute('aria-live', 'polite');
    if (els) renderReadout();
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

  function beginHold(btn, step) {
    endHold();
    holdButton = btn;
    btn.classList.add('held');
    // 连发时读数每秒要改几十次。aria-live 一直是 polite 的话，屏幕阅读器要么排队
    // 要么来不及处理；先关掉，松手时再打开，于是它只会念出最终值那一次。
    document.querySelector('.readout').setAttribute('aria-live', 'off');
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

      // 键盘和辅助技术激活 <button> 时派发的是合成 click，pointerdown 根本不会触发 ——
      // 只接 pointerdown 的话，聚焦到按钮再按回车是没有反应的。
      // detail === 0 是合成点击（键盘/AT），鼠标和触摸是 1，用它避免一次按压走两步。
      btn.addEventListener('click', function (e) {
        if (e.detail === 0) applyDelay(state.delay + step);
      });
    }
    // 释放监听到 window 上：手指滑出按钮再松开也要停
    window.addEventListener('pointerup', endHold);
    window.addEventListener('pointercancel', endHold);

    // Task 7 会把它改成走 restart()（理由见那里）。现在只改数值。
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
    applyDelay: applyDelay,
    // 包一层：直接暴露 renderIndicator 的话，外部探针调用会绕过 lastTMs 的记账 ——
    // 时钟冻住时循环会以为"没变过"而跳过，面板就停在探针画的那个状态，直到时钟再动。
    renderIndicator: function (t) {
      renderAndRecord(t);
    },
    renderReadout: renderReadout
  };

})(typeof window !== 'undefined' ? window : globalThis);
