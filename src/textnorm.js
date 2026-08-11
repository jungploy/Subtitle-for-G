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
