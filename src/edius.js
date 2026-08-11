// src/edius.js
// EDIUS 字幕格式解析。
// 格式特征（每行一条字幕）：
//   <起始时码> <结束时码> <文本>
// 时码为 SMPTE 风格 HH:MM:SS:FF（最后一段是「帧」，非毫秒），
// 文本部分用两个连续反斜杠 "\\" 分隔「中文原文」与「英文译文」（双语）。
// 示例：
//   00:00:06:01 00:00:08:18 在野外生存无疑是一项巨大的挑战\\Surviving in the wild is an absolute challenge.
// 编码常见为 UTF-16LE（带 BOM），由后端 open_file 负责正确解码后传入。
//
// 内部时间模型统一使用 SRT 的 HH:MM:SS,mmm（毫秒），因此帧需换算成毫秒。
// EDIUS 字幕时间码基于工程帧率；此处以 25fps（PAL，国内最常用）换算，
// 单帧误差 < 1 帧，对字幕编辑足够；若实际为 30fps 工程，调整此常量即可。

import { normalizeImportText } from './textnorm.js';

export const EDIUS_FPS = 25;

// 单条 EDIUS 行：起始时码 结束时码 文本
// 行尾允许可选的 \r（部分文件 / 跨平台换行残留），避免误判整行不匹配。
const LINE_RE =
  /^\s*(\d{1,2}):(\d{2}):(\d{2}):(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2}):(\d{2})\s*(.*)\r?$/;

// 把 HH:MM:SS:FF（帧）转成 HH:MM:SS,mmm（毫秒）
function ediusToSrt(h, m, s, f) {
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  const ms = Math.round((f / EDIUS_FPS) * 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}

// 文件级探测：多数非空行匹配时码—时码—文本模式即视为 EDIUS。
// 要求至少 2 条且匹配过半，避免与 SRT（带 -->）或普通文本混淆。
export function isEdius(text) {
  if (!text || !text.trim()) return false;
  let match = 0;
  let nonempty = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    nonempty += 1;
    if (LINE_RE.test(line)) match += 1;
  }
  return nonempty >= 2 && match >= Math.ceil(nonempty / 2);
}

/**
 * 解析 EDIUS 文本为条目数组。
 * 返回：{ items, bilingual }
 *   items: [{ index, start, end, source, target }]
 */
export function parseEdius(text) {
  if (!text || !text.trim()) return { items: [], bilingual: false };
  const lines = text.split(/\r?\n/);
  const BS2 = String.fromCharCode(92, 92); // 双反斜杠，分隔中英
  const items = [];
  let index = 0;
  for (const raw of lines) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const start = ediusToSrt(+m[1], +m[2], +m[3], +m[4]);
    const end = ediusToSrt(+m[5], +m[6], +m[7], +m[8]);
    let body = (m[9] || '').replace(/\s+$/, ''); // 去尾部空白
    // 双语拆分：两个反斜杠分隔原文/译文；无分隔则整段作原文
    let source = body;
    let target = '';
    const sep = body.indexOf(BS2);
    if (sep !== -1) {
      source = body.slice(0, sep);
      target = body.slice(sep + 2);
    }
    source = normalizeImportText(source);
    target = normalizeImportText(target);
    index += 1;
    items.push({ index, start, end, source, target });
  }
  const bilingual = items.some((it) => (it.target || '').trim().length > 0);
  return { items, bilingual };
}
