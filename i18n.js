(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};
  const STORE_KEY = 'sdt.lang';

  const strings = {
    zh: {
      'app.title': '延迟测试',
      'start.title': '戴上耳机，点击开始',
      'start.subtitle': '把“滴嗒嗒哒”调到与闪动的点完全重合',
      'start.button': '开始',
      'controls.reset': '归零',
      'controls.pause': '暂停',
      'controls.resume': '继续',
      'hint': '戴上耳机，把“滴嗒嗒哒”调到与闪动的点完全重合',
      'caveat': '读数还包含设备自身的音频与显示延迟（通常 10–40 ms），适合横向比较耳机，不是实验室级绝对值',
      'error.audioLost': '音频被系统中断，没能自动恢复。点下面的按钮重新开始。',
      'error.noAudio': '当前浏览器不支持 Web Audio，无法运行'
    },
    en: {
      'app.title': 'Latency Test',
      'start.title': 'Put on your headphones',
      'start.subtitle': 'Adjust the beat until it lines up with the flashing dots',
      'start.button': 'Start',
      'controls.reset': 'Reset',
      'controls.pause': 'Pause',
      'controls.resume': 'Resume',
      'hint': 'Wear your headphones and adjust until the beat lines up with the dots',
      'caveat': "Includes your device's own audio and display latency (typically 10–40 ms) — good for comparing headphones, not a lab-grade figure",
      'error.audioLost': 'Audio was interrupted by the system and could not recover. Tap below to restart.',
      'error.noAudio': 'This browser does not support Web Audio'
    }
  };

  const FALLBACK = 'en';

  // 只认自有属性。文案表和语言表都是普通对象，直接 obj[key] 会穿到原型链上 ——
  // 'constructor'、'toString' 这种键会取到 Object 的方法而不是"没有这一项"。
  // 语言维度和键维度都要走这道守卫，只守一边比不守更让人困惑。
  function hasOwn(obj, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 语言身份以文案表为准，这两个函数里不写死任何语言代码 ——
  // 加一门语言 = 往 strings 里加一条，不需要回来改逻辑。
  function hasLanguage(code) { return hasOwn(strings, code); }

  // 纯函数：用户选过的优先，其次看浏览器语言的前两位
  function resolve(stored, navLang) {
    if (hasLanguage(stored)) return stored;
    if (typeof navLang === 'string') {
      const code = navLang.slice(0, 2).toLowerCase();
      if (hasLanguage(code)) return code;
    }
    return FALLBACK;
  }

  // 纯函数：语言不存在时回落到 en；键不存在时回落到键名本身（比 undefined 好排查）。
  // "不存在"以自有属性为准，所以 t('constructor', 'zh') 会返回 'constructor'，
  // 而不是把 Object 构造函数塞进 textContent。
  function t(key, lang) {
    const table = hasLanguage(lang) ? strings[lang] : strings[FALLBACK];
    if (hasOwn(table, key)) return table[key];
    if (hasOwn(strings[FALLBACK], key)) return strings[FALLBACK][key];
    return key;
  }

  function detect() {
    let stored = null;
    try { stored = root.localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式会抛 */ }
    const nav = root.navigator ? root.navigator.language : null;
    return resolve(stored, nav);
  }

  function save(lang) {
    try { root.localStorage.setItem(STORE_KEY, lang); } catch (e) { /* 写不进去就算了 */ }
  }

  // 带 data-i18n 的元素统一刷一遍
  function apply(lang, rootEl) {
    const nodes = rootEl.querySelectorAll('[data-i18n]');
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'), lang);
    }
  }

  SDT.i18n = {
    strings: strings,
    FALLBACK: FALLBACK,
    resolve: resolve,
    t: t,
    detect: detect,
    save: save,
    apply: apply
  };

})(typeof window !== 'undefined' ? window : globalThis);
