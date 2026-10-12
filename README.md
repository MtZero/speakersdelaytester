# 无线耳机延迟测试器

纯静态网页，零依赖、零构建。用来测蓝牙耳机（TWS）的音频延迟。

**在线使用：** https://mtzero.github.io/speakersdelaytester/

---

## 怎么用

戴上耳机，点「开始」。页面会以固定节奏播放"滴嗒嗒哒"四声，同时有一个固定不动的视觉指示器。

用下面的按钮调整延迟值，直到**听到的声音**与**闪动的点**完全重合 —— 屏幕上那个数字就是测得的延迟。

| 操作 | 效果 |
|---|---|
| `−10` / `+10` | 粗调，每次 10ms |
| `−1` / `+1` | 微调，每次 1ms |
| **按住不放** | 连续调整，380ms 后开始连发，越按越快 |
| `←` / `→` | 键盘调 1ms |
| `Shift` + `←` / `→` | 键盘调 10ms |
| 归零 | 回到 0 |
| 中 / EN | 切换语言 |
| ❙❙ | 暂停（声音和动效一起冻住） |

量程 **0–500ms**。上限不能再高：拍间隔本身就是 500ms，延迟 `d` 和 `d+500` 看起来是一样的（声音整整错开一拍，落在下一个点上）。

---

## 这个数字该怎么读（重要）

```
读数 ≈ 耳机延迟 + 本机音频通路延迟 − 显示延迟
```

**注意最后一项是减号。** 显示延迟（从渲染到像素真正亮起）在有些设备上能有几十毫秒，会把读数往下压。

所以：

- ✅ **适合横向比较。** 同一台设备、同一个浏览器、同一个延迟设定，换一副耳机再测一次，两次相减 —— 显示延迟和本机音频通路完全抵消，差值就是可信的耳机增量。
- ❌ **不适合当绝对值。** 不同设备之间不可比；换台电脑、换个浏览器，同一副耳机会测出不同的数。
- 不戴耳机时读数接近 0 但不会是 0 —— 剩下的是设备自身的残差。
- 在 0 附近怎么调都看不出差别，是正常的，不是 bug。

想知道"到底是耳机慢还是显示慢"，先测一遍**内置扬声器**作为地板值，再和耳机的结果相减。

### 参考：实验室测出来的量级

| 设备 | 实测延迟 |
|---|---|
| AirPods Pro 2 | ~126 ms |
| AirPods Pro（一代） | ~167 ms |
| *iPad Pro 内置扬声器（同一方法的基线）* | *~83 ms* |

（数据来自 Stephen Coyle 的 Apple Pencil 点屏测法，包含整条链路；那 83ms 的基线说明了测量方法本身能贡献多少。）

---

## 本地运行

不用构建，双击 `index.html` 即可打开。

想更接近真实环境（HTTPS、正常的音频策略），起个静态服务：

```bash
python3 -m http.server 8000
```

## 打包成单文件

```bash
node tools/build-single-file.js
```

产出 `dist/speakers-delay-tester.html` —— 所有脚本和样式内联，**断网可用**，可以直接发给别人。

---

## 开发

纯 JavaScript，无框架、无构建步骤、无外部依赖。

```bash
node tools/run-tests.js      # 34 项断言
```

`tests.js` 跑在 Node 里，同一份文件也供浏览器自检页使用。覆盖范围：

- 计时数学（拍时刻换算、延迟重排、扫描头区间）
- 连发加速曲线的每个档位边界
- 音色包络（首尾必须精确归零，否则会爆音）
- 音频队列记账（取消边界与计时层一致）
- 中英文案表的键完整性

需要真实硬件才能验的部分（iOS 静音拨片、实际延迟感知、系统打断恢复）见 `docs/superpowers/specs/` 下的设计文档 §12 人工清单。

### 文件结构

```
index.html      仅结构
styles.css      全部样式与响应式
i18n.js         文案表 + 语言检测与切换
timing.js       纯计时数学（不碰 DOM / AudioContext）
audio.js        AudioContext 生命周期、音色合成、调度原语
app.js          拍时钟、指示器渲染、控件接线、总装
tests.js        断言，浏览器与 Node 共用
tools/          开发工具（测试运行器、单文件打包）
```

主时钟是 `AudioContext.currentTime`，视觉和音频共用它 —— 所以两者不会漂移，暂停/恢复也不需要补偿计算。

## 加一门语言

在 `i18n.js` 的 `strings` 里加一个键（比如 `ja`），照 `zh` 把所有键补全。

**不需要改 `resolve()` 或 `t()`** —— 它们以文案表为准，表里有这门语言就认。`tests.js` 有一条断言会遍历整张表检查所有语言的键集合一致。

剩下要动的是纯 UI：`app.js` 里「中/EN」那个二选一按钮，以及 `styles.css` 里对应的高亮规则。

---

## 已知限制

- 读数包含设备自身的音频与显示延迟，**不是实验室级绝对值**（见上）
- iOS/macOS 上系统打断音频会话（来电、锁屏、耳机入耳检测）后，WebKit 有可能恢复不回来。应用会检测到并提示重新开始，但那一次测量作废
- 视觉锚点的精度受刷新率限制：设备被限制到 30fps（低电量模式）时，视觉时刻会被量化到约 33ms

---

## English

A single-page, dependency-free tool for measuring wireless headphone latency. Open it, put your headphones on, tap **开始 / Start**, then adjust the delay until the beat you *hear* lines up with the dot you *see*. The number on screen is the measurement.

**Read it as a comparison, not an absolute.** The reading is `headphone + device audio path − display latency`; the display term subtracts and can be tens of milliseconds. Measure two headphones on the same device and subtract — that cancels the device entirely. Absolute numbers are not comparable across machines.

Build a shareable single file with `node tools/build-single-file.js`; run the test suite with `node tools/run-tests.js`.
