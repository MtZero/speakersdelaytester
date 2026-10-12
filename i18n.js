(function (root) {
  'use strict';

  const SDT = root.SDT = root.SDT || {};
  const STORE_KEY = 'sdt.lang';

  const strings = {
    zh: {
      'app.title': '延迟测试',
      'start.title': '戴上耳机，点击开始',
      'start.subtitle': '把"滴嗒嗒哒"调到与闪动的点完全重合',
      'start.button': '开始',
      'controls.reset': '归零',
      'controls.pause': '暂停',
      'controls.resume': '继续',
      'hint': '戴上耳机，把"滴嗒嗒哒"调到与闪动的点完全重合',
      'caveat': '读数还包含设备自身的音频与显示延迟（通常 10–40ms），适合横向比较耳机，不是实验室级绝对值',
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
      'error.noAudio': 'This browser does not support Web Audio'
    }
  };

  const FALLBACK = 'en';

  // 纯函数：用户选过的优先，其次看浏览器语言，中文只认 zh 开头
  function resolve(stored, navLang) {
    if (stored === 'zh' || stored === 'en') return stored;
    if (typeof navLang === 'string' && navLang.slice(0, 2).toLowerCase() === 'zh') return 'zh';
    return FALLBACK;
  }

  // 纯函数：语言不存在时回落到 en；键不存在时回落到键名本身（比 undefined 好排查）
  function t(key, lang) {
    const table = strings[lang] || strings[FALLBACK];
    const value = table[key];
    if (value !== undefined) return value;
    const fallback = strings[FALLBACK][key];
    return fallback !== undefined ? fallback : key;
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
