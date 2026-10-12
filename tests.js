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

})(typeof window !== 'undefined' ? window : globalThis);
