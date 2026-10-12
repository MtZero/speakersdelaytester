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
    eq(at(n) > nowMs + T.SAFETY_MS, true, '第 n 拍应在安全线之后');
    eq(at(n - 1) > nowMs + T.SAFETY_MS, false, '第 n-1 拍不应在安全线之后');
  });

  run('firstFutureIndex: 边界处不会提前半拍', function () {
    // 第 18 拍的音频时刻 = 1100 + (19*500 - 200) = 10400。
    // 安全线是 now+20，所以 now < 10380 时第 18 拍还排得上，到 10380 就必须换成第 19 拍。
    eq(T.firstFutureIndex(10379, 1100, 200, 500), 18);
    eq(T.firstFutureIndex(10380, 1100, 200, 500), 19);
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
