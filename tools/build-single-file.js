// 把整个应用内联成一个 HTML 文件。
// 开发工具，只依赖 Node 内置模块，不参与部署。
//
//   node tools/build-single-file.js
//
// 产物：dist/speakers-delay-tester.html —— 双击可开、断网可用、可以直接发出去。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'speakers-delay-tester.html');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// 脚本顺序是承重的：audio.js 在顶层就读 SDT.timing.CANCEL_CUTOFF_MS，
// 所以 timing.js 必须排在它前面。这里**从 index.html 里解析**顺序，而不是另维护一份列表 ——
// 另维护一份的话，将来加文件必定漏。
function scriptOrder(html) {
  const out = [];
  const re = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  if (!out.length) throw new Error('index.html 里没找到 <script src>');
  return out;
}

// 内联的 JS 里出现 "</script" 会提前结束标签。目前源码里没有，
// 但这是这类脚本唯一致命的坑，必须防。
const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

let html = read('index.html');

const css = read('styles.css');
const linkRe = /<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/;
const linkMatch = linkRe.exec(html);
if (!linkMatch) throw new Error('index.html 里没找到 stylesheet 链接');
if (linkMatch[1] !== 'styles.css') throw new Error('意外的样式表：' + linkMatch[1]);
html = html.replace(linkRe, '<style>\n' + css.trim() + '\n</style>');

// 按解析出来的顺序逐个替换，替换文本里不再含 src，所以不会二次匹配
for (const file of scriptOrder(html)) {
  const tag = `<script src="${file}"></script>`;
  if (!html.includes(tag)) throw new Error('找不到标签：' + tag);
  html = html.replace(tag, '<script>\n' + safe(read(file).trim()) + '\n</script>');
}

// 自检：产物里不该再有任何指向外部文件的引用
const leftovers = html.match(/(?:src|href)="(?!data:|#)[^"]+"/g);
if (leftovers) throw new Error('产物里仍有外部引用：' + leftovers.join(', '));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const bytes = fs.statSync(OUT).size;
console.log(`${path.relative(ROOT, OUT)}  ${bytes} 字节  (${(bytes / 1024).toFixed(1)} KB)`);
