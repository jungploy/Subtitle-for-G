// 智能分句：把大段文本按「标点 + 最小长度」规则切成字幕句。
//
// 规则（与「智能分句导入」预览弹窗配套）：
//  - 句末标点（. ? ! …）强制断句：尊重句子边界，不把两句话硬拼成一行。
//  - 句内标点（, ; : —）仅在「当前已累计长度 ≥ minLen」时才断句；
//    否则继续累计到下一个标点（避免把 "In all his projects," 这种短碎片单独成行）。
//  - keepParagraphs=true 时不跨段落合并（每个段落独立断句）；
//    关闭后则把所有段落拼成一篇连续文本再断句。
//
// 例：minLen=50，文本 "In all his projects, Gaudí ... levels: structural, ... design.
//     This central idea ..."：
//   ① 第一个逗号处累计仅 ~20 字符 < 50 → 不断，继续；
//   ② 冒号处累计 ~83 字符 ≥ 50 → 断，得到第一句；
//   ③ 冒号后 "structural, material, technical, design." 以句号（句末）强制断，得第二句。

// 句末标点（勾选后强制断句，尊重句子边界）：ASCII 与其对应的中文全角标点。
const SEG_HARD = new Set(['.', '?', '!', '。', '？', '！']);
// 句内标点（勾选后仅在「已达最小长度」时才断，否则继续累计）：
const SEG_SOFT = new Set([',', ';', ':', '，', '；', '：']);
// 中文全角标点 → 勾选项的 ASCII 等价（中英文脚本都能断句）
const CN_TO_ASCII = { '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!' };

export function defaultSegOptions() {
  return {
    minLen: 35,
    comma: true,
    period: true,
    semicolon: true,
    colon: true,
    question: true,
    exclaim: true,
    keepParagraphs: true,
  };
}

// 把单个文本块（段落）切成句数组
function splitOne(chunk, opts) {
  const sel = [];
  if (opts.comma) sel.push(',');
  if (opts.period) sel.push('.');
  if (opts.semicolon) sel.push(';');
  if (opts.colon) sel.push(':');
  if (opts.question) sel.push('?');
  if (opts.exclaim) sel.push('!');
  const set = new Set(sel);
  // 把已勾选项的对应中文全角标点也纳入断点
  for (const cn of Object.keys(CN_TO_ASCII)) {
    if (set.has(CN_TO_ASCII[cn])) set.add(cn);
  }
  if (!set.size) return [chunk];

  const minLen = Math.max(0, opts.minLen | 0);
  const segs = [];
  let cur = '';
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    cur += ch;
    if (set.has(ch)) {
      const isHard = SEG_HARD.has(ch);
      const runLen = cur.replace(/\s+$/, '').length;
      // 句末标点强制断；句内标点仅在达到最小长度时断；其余情况继续累计。
      if (isHard || runLen >= minLen) {
        const s = cur.trim();
        if (s) segs.push(s);
        cur = '';
      }
    }
  }
  const tail = cur.trim();
  if (tail) segs.push(tail);
  return segs;
}

export function segmentBlocks(blocks, opts) {
  const o = opts || defaultSegOptions();
  if (!o.keepParagraphs) {
    const whole = (blocks || [])
      .map((b) => (b || '').trim())
      .filter(Boolean)
      .join(' ');
    return whole ? splitOne(whole, o).filter(Boolean) : [];
  }
  const out = [];
  for (const b of blocks || []) {
    const chunk = (b || '').trim();
    if (!chunk) continue;
    out.push(...splitOne(chunk, o));
  }
  return out.filter(Boolean);
}
