// src/rich.js
// 把 SRT / 字幕里的行内标记转换为安全的富文本 HTML。
// 只保留粗体 <b> 和斜体 <i> 标记（应用对应字体样式）；
// 字体大小 / 颜色 / 字体 / 下划线等其余标记一律忽略并剔除（不显示标签本身）。
// 同时提供 plainText() 用于翻译、查找替换等「只看文字」的场景。

// 匹配任意标签（无论是否已知），统一抽出来处理
const TAG_RE = /<\/?[^>]+>/g;

// 占位符分隔符（私有区字符，正常文本里不会出现，且不会被下面的 HTML 转义影响）
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

// 单个标记 -> 安全 HTML。只有 b / i 保留，其余（font / u / 多余闭合标签等）直接剔除。
function convertTag(tag) {
  const t = tag.toLowerCase();
  if (t === '<b>' || t === '<b/>') return '<b>';
  if (t === '</b>') return '</b>';
  if (t === '<i>' || t === '<i/>') return '<i>';
  if (t === '</i>') return '</i>';
  return '';
}

/**
 * 把含字幕标记的原始文本转为可安全显示的富文本 HTML。
 * - 已知标记（b / i）被转换为对应 HTML，应用粗体 / 斜体，不显示标签本身；
 * - 其余标记（font / u 等）直接剔除，不显示标签、不套用样式；
 * - 其它所有字符统一做 HTML 转义，杜绝 XSS / 标签注入；
 * - 换行转为 <br>，便于在单元格里保留多行。
 */
export function renderRich(raw) {
  if (!raw) return '';
  const tokens = [];
  // 1) 先把所有标签抽成占位符，避免被后面的转义破坏
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
  // 4) 还原标记（按原顺序，保留嵌套；未知标记被剔除）
  s = s.replace(
    new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'),
    (_, n) => convertTag(tokens[+n])
  );
  return s;
}

/**
 * 从富文本 / 字幕标记文本里抽取纯文字（去掉所有标签），用于翻译、查找、替换。
 * 行内 <br> 先还原成换行，避免跨行文字被接成一行。
 */
export function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(new RegExp(OPEN + '|' + CLOSE, 'g'), '');
}
