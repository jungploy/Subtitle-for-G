// src/textnorm.js
// 导入时把「非中文文本」里的中文全角标点统一转成英文 ASCII 标点。
// 中文（含 CJK 表意文字）文本不处理，保留原本的中文标点，避免破坏原文。
//
// 触发场景：导入「非中文台本」时，里面若混用了中文格式的标点（，。；：？！（）等），
// 会被归一化为对应的英文标点（, . ; : ? ! ( ) 等），使英文/译文文本在排版上规范一致。

// 中文全角标点 -> 英文 ASCII 标点（键用 unicode 转义，避免源码编码歧义）
export const CN_PUNCT = {
  '\uFF0C': ',',   // ，
  '\u3002': '.',   // 。
  '\u3001': ',',   // 、（顿号，英文无对应，退化为逗号）
  '\uFF1B': ';',   // ；
  '\uFF1A': ':',   // ：
  '\uFF1F': '?',   // ？
  '\uFF01': '!',   // ！
  '\uFF08': '(',   // （
  '\uFF09': ')',   // ）
  '\u201C': '"',   // “
  '\u201D': '"',   // ”
  '\u2018': "'",   // ‘
  '\u2019': "'",   // ’
  '\u300C': '"',   // 「
  '\u300D': '"',   // 」
  '\u300E': '"',   // 『
  '\u300F': '"',   // 』
  '\u3010': '[',   // 【
  '\u3011': ']',   // 】
  '\u300A': '"',   // 《
  '\u300B': '"',   // 》
  '\uFF5E': '~',   // ～
  '\u3000': ' ',   // 　 全角空格
};

// 仅识别 CJK 表意文字（不含全角标点），避免把「含全角标点的纯英文」误判为中文
const CJK_RE = /[\u3400-\u9fff]/;

export function looksChinese(s) {
  return CJK_RE.test(s || '');
}

export function normalizeCjkPunctToAscii(text) {
  if (!text) return text;
  let out = text.replace(/\u2026+/g, '...'); // 省略号（……）折叠为一个 ...
  for (const k in CN_PUNCT) {
    if (out.indexOf(k) !== -1) out = out.split(k).join(CN_PUNCT[k]);
  }
  return out;
}

// 入口：非中文文本做标点归一化；中文文本原样返回（保护中文标点）
export function normalizeNonChinese(text) {
  if (!text || looksChinese(text)) return text;
  return normalizeCjkPunctToAscii(text);
}

// 合并连续空白为单个 ASCII 空格：ASCII 空格、全角空格(　)、制表符。
// 用于「导入文本中间多个空格合并为 1 个」。不触碰换行/标签。
export function collapseSpaces(text) {
  if (!text) return text;
  return text.replace(/[ 　\t]+/g, ' ');
}

// 中文文本里要「去除」的标点字符集（显式列出，避免误伤富文本标签 < > / 等）。
// 保留：双引号 “” (U+201C/U+201D) 与书名号 《》 (U+300A/U+300B)；以及标签字符 < > / 。
// 即：删除中文文本里的【一切标点】（中文全角标点 + ASCII 标点），只留 “” 《》 与标签字符。
// 范围说明：
//   FF01-FF0F / FF1A-FF20 / FF3B-FF40 / FF5B-FF65 —— 全角 ASCII 标点（不含字母数字）
//   3001,3002(、。) 3008,3009(〈〉) 300C-301B(「」『』【】〔〕〖〗〘〙〚〛) 301C(〜) 301D-301F(〝〞〟) 3030(〰)
//   2013-2015(–—―) 2018,2019,201B(‘’‛) 2025,2026(‥…) 00B7(·)
//   末尾 ASCII 标点串：!"#$%&'()*+,.:;=?@[]^_{|}~- （刻意排除 < > / 以保护富文本标签）
// 注意刻意排除 300A/300B(《》) 与 201C/201D(“”) 以及空格 3000、所有字母/数字/CJK 表意/emoji。

// 实际正则（用 \u 转义，避免源码编码歧义）
const _STRIP_CN_PUNCT_RE = /[\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u3001\u3002\u3008\u3009\u300C-\u301B\u301C\u301D-\u301F\u3030\u2013-\u2015\u2018\u2019\u201B\u2025\u2026\u00B7!"#$%&'()*+,.:;=?@^_{|}~-]/g;

// 去掉中文文本中的中文/全角标点，仅保留 “” 与 《》
export function stripChinesePunct(text) {
  if (!text) return text;
  return text.replace(_STRIP_CN_PUNCT_RE, '');
}

// 导入文本归一化总入口：
//   1) 合并连续空格为单个（所有文本）
//   2) 中文文本：去除中文标点（保留 “” 《》），并再次合并空格
//      非中文文本：沿用旧的「全角标点转 ASCII」归一化（保护英文/译文排版）
export function normalizeImportText(text) {
  if (!text) return text;
  let t = collapseSpaces(text);
  if (looksChinese(t)) {
    t = stripChinesePunct(t);
  } else {
    t = normalizeCjkPunctToAscii(t);
  }
  return collapseSpaces(t).trim();
}
