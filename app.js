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
  let timerId = null;    // 调度器轮询句柄
  let frameStarted = false;   // 见 start()：音频丢失后遮罩会回来，用户再点一次时不能叠第二个 rAF 循环

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
      holdTimer = setTimeout(tick, T.repeatIntervalMs(performance.now() - t0));
    }
    holdTimer = setTimeout(tick, T.HOLD_DELAY_MS);   // 按住 380ms 后开始连发
  }

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
        // 只认主键。右键、中键、笔的橡皮端都会派发 pointerdown；
        // 不拦的话它们同样会改值并启动连发（Windows 上中键还会同时触发自动滚动）。
        if (e.button !== 0) return;
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
        const before = state.delay;
        applyDelay(state.delay + step);
        // 只有"已经到边界、值没变"这一种情况才需要补一次写入。
        // 正常步进时 applyDelay 已经写过一次，无条件再写就是两次 mutation，
        // 屏幕阅读器会把同一个值念两遍 —— 恰好和这条修复的意图相反。
        if (state.delay === before) renderReadout();
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
    // 归零走 restart() 而不是 applyDelay(0)：延迟一次跳太多时，过渡那一拍的旧音和新音
    // 可能落在几十毫秒内 —— 两个起音挤在一起，恰好污染了这个应用要测量的那个量。
    // 重启会先取消所有已排音频并重新起一轮（1.1s 的前导足够任何在响的音收尾），
    // 顺带"从左边重新开始"也更贴合"归零"的语义。
    document.getElementById('reset-btn').addEventListener('click', function () {
      endHold();
      state.delay = 0;
      renderReadout();
      if (state.running) restart();
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

  // 前瞻调度：提前把音频排进 AudioContext 的采样级时间轴。
  // 绝不能等定时器到点了才发声 —— 移动端 setTimeout 抖动可达几十毫秒，比要测的量级还大。
  // 排哪些拍的判断全在 T.pendingBeats() 里（纯函数、有测试）；这里只负责把结果交给音频层。
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

  function restart() {
    SDT.audio.cancelPending();
    state.originMs = (SDT.audio.currentTime() + T.startLeadMs(state.beatMs) / 1000) * 1000;
    state.nextIndex = 0;
    pump();
  }

  function start() {
    // 万一还卡着一次连发就清掉：音频丢失后遮罩会回来，而用户是用另一根手指去点「开始」的，
    // 那个 pointerId 和连发的不一样，endHoldFromPointer 不会认它。
    endHold();
    if (!SDT.audio.isSupported()) {
      const err = document.getElementById('start-error');
      err.textContent = I18N.t('error.noAudio', currentLang);
      err.hidden = false;
      return;
    }
    SDT.audio.init();
    // 系统可能随时掐掉音频会话，而且不产生任何页面事件 —— 最典型的是蓝牙耳机的入耳检测：
    // 摘下耳机，macOS/iOS 暂停音频会话，上下文被挂起，currentTime 冻结，
    // 而指示器用的是同一个时钟，于是跟着冻住：仪器看着正常，其实已经死了。
    // 摘下又戴回去时系统会自己恢复，所以这里只做复查、不强行 resume
    // （非手势的 resume 多半会被拒），超过 600ms 还没恢复才把话说出来。
    SDT.audio.onStateChange(function () {
      if (state.running && !state.paused && SDT.audio.state() !== 'running') {
        watchForAudioLoss();
      }
    });
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
    // tMs = 0 落在前导段，画出来全是静息色、扫描头全隐藏，不会误闪。顺序要紧。
    renderAndRecord(0);
    document.getElementById('start-overlay').hidden = true;
    document.getElementById('app').hidden = false;
    document.getElementById('start-error').hidden = true;

    // 手势这条路径同样要复查：WebKit 也可能连手势里的 resume() 一起拒绝。
    // 只在切后台那条路复查的话，这里会静默地把 state.running 置成 true 再撤掉遮罩，
    // 用户又回到一个冻住的指示器前面 —— 正好是这整套机制要消灭的那种失效。
    watchForAudioLoss();

    // 只起一次：音频丢失后遮罩会重新出现，用户再点一次 start() 时不能再叠一个 rAF 循环
    if (!frameStarted) {
      frameStarted = true;
      requestAnimationFrame(frame);
    }
  }

  // 恢复是异步的，"允许调用"不等于"已经恢复"。隔一会儿复查一次：
  // 只有 state.paused 还说好、实际已经冻住的情况才需要说话。
  //
  // !document.hidden 不能省：没有 navigator.audioSession 的浏览器（iOS Safari 14/15 就是）
  // 页面隐藏时 ctx 本来就不是 running。少了这一条，用户回到页面后 600ms 内又切走，
  // 就会看到一条假的"音频已丢失" —— 在这条专门让用户信任界面的路径上，误报代价尤其高。
  function watchForAudioLoss() {
    setTimeout(function () {
      if (state.running && !state.paused && !document.hidden &&
          SDT.audio.state() !== 'running') {
        showAudioLost();
      }
    }, 600);
  }

  // 音频被系统打断且没能自动恢复。这时 ctx.currentTime 已经冻住，指示器跟着冻住，
  // 但界面看着一切正常 —— 用户会对着一个假活的仪器读数。
  // 与其静默，不如把遮罩放回来：恢复音频需要用户手势，而遮罩正是收集手势的地方。
  function showAudioLost() {
    state.running = false;
    if (timerId) { clearInterval(timerId); timerId = null; }
    state.paused = false;
    const err = document.getElementById('start-error');
    err.textContent = I18N.t('error.audioLost', currentLang);
    err.hidden = false;
    document.getElementById('start-overlay').hidden = false;
    // 指示器循环不用停：时钟冻住后 tMs 不再变化，frame() 的早退会让它几乎不花代价。
  }

  let currentLang = I18N.FALLBACK;

  function setLang(lang) {
    currentLang = lang;
    I18N.apply(lang, document);
    document.documentElement.lang = lang;
    document.getElementById('lang-btn').setAttribute('data-lang', lang);
    // 暂停按钮的文案随运行状态变，交给 data-i18n 会被写死成"暂停"，所以单独刷
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

    // 切回前台时恢复音频。因为一切以 ctx.currentTime 为准，恢复本身不需要重新对齐，
    // 也不需要任何补偿。但"允许调用 resume()"不等于真的恢复了，所以交给复查。
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !state.running || state.paused) return;
      SDT.audio.resume();
      watchForAudioLoss();
    });
  }

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
      // 改了 beatMs 之后这个前提不再成立（同样的 tMs 对应不同画面），所以必须让缓存失效。
      // restart() 会重设 originMs 从而改变 tMs，但那要在 state.running 时才发生 ——
      // 不运行时就得手动清。
      lastTMs = null;
      if (state.running) restart();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    collectElements();
    renderReadout();
    wireChrome();
    wireIntervalSlot();
    setLang(I18N.detect());
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
