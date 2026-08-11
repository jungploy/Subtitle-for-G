// src/ass.js
// ASS（Advanced SubStation Alpha）字幕解析。
// 仅解析 [Events] 段下的 Dialogue 行；时间码 H:MM:SS.cc（厘秒）转换为模型使用的
// SRT 时间格式 HH:MM:SS,mmm；文本中的 {…} 覆写标签（\pos \fad \fs 等）被剔除，
// \N / \n 换行保留，最终按「跨语种」规则把每行拆成 原文 / 译文 两栏。

import { isCrossScript } from './srt.js';

// ASS 时间 -> SRT 时间：'0:00:12.00' -> '00:00:12,000'
function assToSrtTime(t) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})/.exec(t || '');
  if (!m) return '00:00:00,000';
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const cs = parseInt(m[4], 10); // 厘秒（百分之一秒）
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return `${p2(h)}:${p2(mm)}:${p2(s)},${p3(cs * 10)}`;
}

// 剔除 {…} 覆写标签块（可能跨越多字符，内部可能含 \ 转义序列，整体删去即可）
function stripOverride(text) {
  return (text || '').replace(/\{[^}]*\}/g, '');
}

// 清理一条 Dialogue 的文本内容：去覆写标签，\N / \n 统一为换行，\h 视为空格
function cleanAssText(text) {
  let t = stripOverride(text);
  t = t.replace(/\\N/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\\h/g, ' ');
  // 压缩连续空行，去掉首尾空白
  return t.replace(/\n{2,}/g, '\n').trim();
}

// 按 Format 列数切分 Dialogue 字段：前 n-1 列按逗号切，最后一列（Text）保留内部逗号
function splitFields(body, n) {
  const parts = body.split(',');
  if (parts.length <= n) {
    while (parts.length < n) parts.push('');
    return parts;
  }
  const head = parts.slice(0, n - 1);
  const tail = parts.slice(n - 1).join(',');
  return head.concat([tail]);
}

// 把多行文本拆成「内容行」数组（去空行），供双语探测 / 原文译文拆分使用
function toContentLines(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 解析 ASS 文本为条目数组，并自动探测双语字幕。
 * 返回：{ items, bilingual }
 *   items: [{ index, start, end, source, target }]
 *     - index:  字幕序号（Dialogue 按出现顺序 1..N）
 *     - start:  开始时间 HH:MM:SS,mmm
 *     - end:    结束时间
 *     - source: 原文文本
 *     - target: 译文文本（单语文件为空；双语文件自动填充）
 *   bilingual: 是否识别为双语（过半 Dialogue 块首两行分属不同文字体系）
 */
import { normalizeNonChinese } from './textnorm.js';

export function parseAss(text) {
  if (!text || !text.trim()) return { items: [], bilingual: false };

  const lines = text.split(/\r?\n/);
  let inEvents = false;
  let formatFields = null;
  const events = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '[') {
      inEvents = /^\[Events\]/i.test(line);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format:/i.test(line)) {
      formatFields = line.replace(/^Format:/i, '').split(',').map((s) => s.trim());
      continue;
    }
    if (/^Dialogue:/i.test(line)) {
      if (!formatFields) {
        formatFields = [
          'Layer', 'Start', 'End', 'Style', 'Name',
          'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text',
        ];
      }
      const body = line.replace(/^Dialogue:/i, '');
      const fields = splitFields(body, formatFields.length);
      const map = {};
      formatFields.forEach((f, i) => (map[f] = fields[i] || ''));
      const start = assToSrtTime(map.Start || '');
      const end = assToSrtTime(map.End || '');
      const content = toContentLines(cleanAssText(map.Text || ''));
      if (!content.length) {
        events.push({ start, end, content: [''] });
      } else {
        events.push({ start, end, content });
      }
    }
  }

  const total = events.length;
  const cross = events.filter(
    (e) => e.content.length >= 2 && isCrossScript(e.content[0], e.content[1])
  ).length;
  const bilingual =
    total > 0 && cross / total >= 0.5;

  const items = events.map((e, i) => {
    const blockIsBilingual =
      e.content.length >= 2 && isCrossScript(e.content[0], e.content[1]);
    let source, target;
    if (blockIsBilingual) {
      source = e.content[0];
      target = e.content.slice(1).join('\n');
    } else {
      source = e.content.join('\n');
      target = '';
    }
    return {
      index: i + 1,
      start: e.start,
      end: e.end,
      source: normalizeNonChinese(source),
      target: normalizeNonChinese(target),
    };
  });

  return { items, bilingual };
}
