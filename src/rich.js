// src/rich.js
// 把 SRT / 字幕里的行内标记（<font size> <font color> <b> <i> <u>）转换为
// 安全的富文本 HTML：标记本身不显示，只把字体大小 / 颜色 / 粗体 / 斜体
// 应用到对应文本上。同时提供 plainText() 用于翻译、查找替换等「只看文字」的场景。

// 需要识别并转换的行内标记
const TAG_RE = /<\/?(?:font|b|i|u)\b[^>]*>/gi;

// 占位符分隔符（私有区字符，正常文本里不会出现，且不会被下面的 HTML 转义影响）
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

// 从 <font size="54" color="#00ffff"> 这类标签里抽取需要的内联样式
function fontStyle(tag) {
  const styles = [];
  const size = tag.match(/\bsize\s*=\s*"?(\d+)"?/i);
  if (size) styles.push(`font-size:${size[1]}px`);
  const color = tag.match(/\bcolor\s*=\s*"?([^"\s>/]+)"?/i);
  if (color) styles.push(`color:${color[1]}`);
  const face = tag.match(/\bface\s*=\s*"?([^"\s>/]+)"?/i);
  if (face) styles.push(`font-family:${face[1]}`);
  return styles.join(';');
}

// 单个标记 -> 安全 HTML（嵌套结构在调用处按原顺序还原）
function convertTag(tag) {
  const t = tag.toLowerCase();
  if (t === '</font>') return '</span>';
  if (t === '<b>' || t === '<b/>') return '<b>';
  if (t === '</b>') return '</b>'; // 字幕文件里常见的多余闭合标签，原样保留（浏览器忽略）
  if (t === '<i>' || t === '<i/>') return '<i>';
  if (t === '</i>') return '</i>';
  if (t === '<u>' || t === '<u/>') return '<u>';
  if (t === '</u>') return '</u>';
  if (t.startsWith('<font')) return `<span style="${fontStyle(tag)}">`;
  return '';
}

/**
 * 把含字幕标记的原始文本转为可安全显示的富文本 HTML。
 * - 已知标记（font/b/i/u）被转换为带内联样式的 HTML，不显示标签本身；
 * - 其它所有字符（含残留的 < >）统一做 HTML 转义，杜绝 XSS / 标签注入；
 * - 换行转为 <br>，便于在单元格里保留多行。
 */
export function renderRich(raw) {
  if (!raw) return '';
  const tokens = [];
  // 1) 先把已知标记抽成占位符，避免被后面的转义破坏
  let s = String(raw).replace(TAG_RE, (m) => {
    const tok = OPEN + tokens.length + CLOSE;
    tokens.push(m);
    return tok;
  });
  // 2) 转义其余所有内容
  s = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // 3) 换行 -> <br>
  s = s.replace(/\r?\n/g, '<br>');
  // 4) 还原标记（按原顺序，保留嵌套）
  s = s.replace(
    new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'),
    (_, n) => convertTag(tokens[+n])
  );
  return s;
}

/**
 * 从富文本 / 字幕标记文本里抽取纯文字（去掉所有标签），用于翻译、查找、替换。
 */
export function plainText(html) {
  return String(html || '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(new RegExp(OPEN + '|' + CLOSE, 'g'), '');
}
