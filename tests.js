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

})(typeof window !== 'undefined' ? window : globalThis);
