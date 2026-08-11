// src/srt.js
// SRT 字幕解析与序列化

const TIME_RE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

function normalizeTime(t) {
  // SRT 标准用逗号分隔毫秒，统一转换
  return t.trim().replace(/\./g, ',');
}

// SRT 时间码 -> 毫秒（用于比较结束时间先后）
function tcToMs(t) {
  const m = t && t.match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!m) return 0;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
}
// 取两个结束时间中更晚的那一个
function laterEnd(a, b) {
  return tcToMs(a) >= tcToMs(b) ? a : b;
}

// 判断一行文本的主导文字体系，用于双语探测。
// 返回 'CJK'（中日韩文）| 'Latin'（拉丁系）| 'Other'
export function dominantScript(line) {
  let cjk = 0;
  let latin = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x3040 && cp <= 0x30ff) cjk++; // 假名
    else if (cp >= 0x4e00 && cp <= 0x9fff) cjk++; // CJK 统一表意
    else if (cp >= 0xac00 && cp <= 0xd7af) cjk++; // 谚文
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
    else if (cp >= 0xc0 && cp <= 0x024f) latin++; // 拉丁扩展
  }
  if (cjk > 0 && cjk >= latin) return 'CJK';
  if (latin > 0) return 'Latin';
  return 'Other';
}

// 两块文字是否分属不同体系 —— 双语字幕（如 原文拉丁 / 译文中日韩）的强信号
export function isCrossScript(a, b) {
  const fa = dominantScript(a);
  const fb = dominantScript(b);
  if (fa === fb) return false;
  // 至少一侧是 CJK 或 Latin，避免把纯符号/数字误判
  return fa === 'CJK' || fb === 'CJK' || fa === 'Latin' || fb === 'Latin';
}

/**
 * 解析 SRT 文本为条目数组，并自动探测双语字幕。
 * 返回：{ items, bilingual }
 *   items: [{ index, start, end, source, target }]
 *     - index:  字幕序号（缺失时自动补）
 *     - start:  开始时间 00:00:00,000
 *     - end:    结束时间
 *     - source: 原文文本（可能多行）
 *     - target: 翻译文本（单语文件初始为空；双语文件自动填充）
 *   bilingual: 是否识别为「双语字幕」（每块两行：第一行原文、其余译文）
 *
 * 探测规则（opts.bilingual 可强制覆盖）：
 *   - 统计「内容含 >=2 行」的块占比，超过一半即判定为双语。
 *   - 双语时：每块第一行 → source，其余行 → target（join 回多行）。
 *   - 单语时：整块内容 → source，target 留空待翻译。
 */
export function parseSRT(text, opts = {}) {
  if (!text || !text.trim()) return { items: [], bilingual: false };
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\s*\n/).filter((b) => b.trim().length);
  const raw = [];
  let auto = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TIME_RE.test(lines[i])) {
        timeIdx = i;
        break;
      }
    }
    if (timeIdx === -1) continue; // 不是合法 cue，跳过

    const m = lines[timeIdx].match(TIME_RE);
    const start = normalizeTime(m[1]);
    const end = normalizeTime(m[2]);

    // 序号：时间轴前一行若为纯数字则采用
    let index = null;
    if (timeIdx > 0 && /^\d+$/.test(lines[timeIdx - 1].trim())) {
      index = parseInt(lines[timeIdx - 1].trim(), 10);
    }
    if (index === null) index = ++auto;

    // 内容行：时间轴之后的非空行（保留块内顺序，去掉序号/时间行）
    const content = lines.slice(timeIdx + 1).filter((l) => l.trim().length);
    raw.push({ index, start, end, content });
  }

  // —— 双语交错 SRT（interleaved bilingual）：每个语种单独成一条 cue，且两条 cue 共享同一时间码 ——
  // 例如 cue A(中文) 与 cue B(英文) 都是 00:00:05,000 --> 00:00:08,000。
  // 这种格式必须按「同时间码 + 异语种」把相邻两条 cue 合并成一条双语条目
  // （中文→source，英文→target），否则中文和英文会变成两行互不相关的字幕。
  // 合并条件用了两个强信号（时间码相同 + 语种不同），可有效避免误合并普通字幕。
  const merged = [];
  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    const nxt = raw[i + 1];
    const pairable =
      opts.bilingual !== false &&
      !!nxt &&
      nxt.start === cur.start &&
      cur.content.length > 0 &&
      nxt.content.length > 0 &&
      isCrossScript(cur.content.join('\n'), nxt.content.join('\n'));
    if (pairable) {
      const a = cur.content.join('\n');
      const b = nxt.content.join('\n');
      // 中文（CJK）作原文，其它语种作译文；与文件中的 中文在上、英文在下 顺序一致。
      let source, target;
      if (dominantScript(a) === 'CJK') {
        source = a;
        target = b;
      } else {
        source = b;
        target = a;
      }
      merged.push({
        index: cur.index,
        start: cur.start,
        end: laterEnd(cur.end, nxt.end),
        source,
        target,
      });
      i += 2;
      continue;
    }

    // 未配对的 cue：沿用「块内双语」判定（同一 cue 内含多行异语种 → 拆两列）。
    // 防止「同一语种被硬换行折成两行」的字幕（如整段中文的片尾署名）被误拆成原文/译文。
    const blockIsBilingual =
      opts.bilingual === true ||
      (cur.content.length >= 2 && isCrossScript(cur.content[0], cur.content[1]));
    let source, target;
    if (blockIsBilingual) {
      source = cur.content[0] ?? '';
      target = cur.content.slice(1).join('\n');
    } else {
      source = cur.content.join('\n');
      target = '';
    }
    merged.push({ index: cur.index, start: cur.start, end: cur.end, source, target });
    i += 1;
  }

  const items = merged;
  const bilingual =
    opts.bilingual === true
      ? true
      : opts.bilingual === false
        ? false
        : items.some((it) => (it.target || '').trim().length);

  return { items, bilingual };
}

/**
 * 序列化为 SRT 文本。
 * @param {Array} items
 * @param {object} opts
 *   mode: 'translate' 仅翻译 | 'bilingual' 原文+翻译 | 'source' 仅原文
 *   includeIndex: 是否写序号（默认 true）
 */
export function serializeSRT(items, opts = {}) {
  const mode = opts.mode || 'translate';
  const includeIndex = opts.includeIndex !== false;
  return (
    items
      .map((it, i) => {
        const idx = includeIndex ? it.index ?? i + 1 : i + 1;
        const start = it.start || '00:00:00,000';
        const end = it.end || '00:00:00,000';
        let body;
        if (mode === 'source') body = it.source;
        else if (mode === 'translate') body = it.target || it.source;
        else {
          const parts = [];
          if (it.source) parts.push(it.source);
          if (it.target) parts.push(it.target);
          body = parts.join('\n');
        }
        return `${idx}\n${start} --> ${end}\n${body}`;
      })
      .join('\n\n') + '\n'
  );
}
