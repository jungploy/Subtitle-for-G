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
// EDIUS 字幕时间码基于工程帧率（23.976 / 24 / 25 / 29.976 fps）。
// 时间码分隔符可能是冒号「:」或分号「;」（EDIUS 部分导出用「HH:MM:SS;FF」），两种都识别。
// 导入时若帧号达到 25（仅 29.976 帧率才有 0..29）即自动判定为 29.976，无需弹窗询问；
// 其余帧率（23.976 / 24 / 25）无法仅靠帧号唯一确定，仍需弹窗确认。

import { normalizeImportText } from './textnorm.js';

// 帧率标准化：NTSC 非整数帧率用精确分数（24000/1001、30000/1001），
// 否则逐帧换算会与 EDIUS 实际写入的时码产生累积偏差。
export function fpsToValue(fps) {
  const s = String(fps);
  if (s === '23.976') return 24000 / 1001;
  if (s === '29.976' || s === '29.97') return 30000 / 1001;
  const v = parseFloat(s);
  return isFinite(v) && v > 0 ? v : 25;
}

// 单条 EDIUS 行：起始时码 结束时码 文本
// 时码分隔符兼容「:」与「;」；行尾允许可选的 \r（部分文件 / 跨平台换行残留）。
const LINE_RE =
  /^\s*(\d{1,2})[:;](\d{2})[:;](\d{2})[:;](\d{2})\s+(\d{1,2})[:;](\d{2})[:;](\d{2})[:;](\d{2})\s*(.*)\r?$/;

// 把 HH:MM:SS:FF（帧）转成 HH:MM:SS,mmm（毫秒），按给定的工程帧率 fps 换算。
function ediusToSrt(h, m, s, f, fps) {
  const rate = fpsToValue(fps);
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  const ms = Math.round((f / rate) * 1000);
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
 * @param {string} text  EDIUS 字幕文本
 * @param {number} fps   工程帧率（23.976 / 24 / 25），用于帧→毫秒换算
 * 返回：{ items, bilingual }
 *   items: [{ index, start, end, source, target }]
 */
export function parseEdius(text, fps = 25) {
  if (!text || !text.trim()) return { items: [], bilingual: false };
  const lines = text.split(/\r?\n/);
  const BS2 = String.fromCharCode(92, 92); // 双反斜杠，分隔中英
  const items = [];
  let index = 0;
  for (const raw of lines) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const start = ediusToSrt(+m[1], +m[2], +m[3], +m[4], fps);
    const end = ediusToSrt(+m[5], +m[6], +m[7], +m[8], fps);
    let body = (m[9] || '').replace(/\s+$/, ''); // 去尾部空白
    // 双语 + 多行：以「双反斜杠 \\」作为「行分隔符」，把整段切成若干段。
    //   - 段数为 1：无分隔，整段作原文（译文空）；
    //   - 段数为偶数：前一半为原文（中文）、后一半为译文（英文）——既兼容单行（2 段），
    //     也兼容双行（4 段：原文两行 + 译文两行）。行内用 \n 连接，导入后由 toHtml 转成 <br>；
    //   - 段数为奇数（极少见）：退回旧的「首个 \\ 作为中英分隔」切法，保证不崩。
    const segs = body.split(BS2);
    let source = '';
    let target = '';
    if (segs.length === 1) {
      source = segs[0];
    } else if (segs.length % 2 === 0) {
      const half = segs.length / 2;
      source = segs.slice(0, half).join('\n');
      target = segs.slice(half).join('\n');
    } else {
      const sep = body.indexOf(BS2);
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

// 帧率自动探测：扫描所有行的帧号（起始、结束各取一个），
// 若帧号达到 25（仅 29.976 帧率才有 0..29）即可确定工程帧率为 29.976，
// 导入时无需再弹窗询问。其余帧率（23.976 / 24 / 25 帧号 ≤24）返回 null，需弹窗确认。
export function ediusProbeFps(text) {
  if (!text) return null;
  let maxFrame = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m) maxFrame = Math.max(maxFrame, +m[4], +m[8]);
  }
  return maxFrame >= 25 ? 29.976 : null;
}
