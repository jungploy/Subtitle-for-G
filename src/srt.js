// src/srt.js
// SRT 字幕解析与序列化

const TIME_RE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

function normalizeTime(t) {
  // SRT 标准用逗号分隔毫秒，统一转换
  return t.trim().replace(/\./g, ',');
}

/**
 * 解析 SRT 文本为条目数组。
 * 每个条目：{ index, start, end, source, target }
 *   - index:  字幕序号（缺失时自动补）
 *   - start:  开始时间 00:00:00,000
 *   - end:    结束时间
 *   - source: 原文文本（可能多行）
 *   - target: 翻译文本（初始为空）
 */
export function parseSRT(text) {
  if (!text || !text.trim()) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\s*\n/).filter((b) => b.trim().length);
  const items = [];
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

    const source = lines.slice(timeIdx + 1).join('\n').trim();
    items.push({ index, start, end, source, target: '' });
  }
  return items;
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
