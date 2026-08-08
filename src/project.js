// src/project.js
// Subtitle-for-G 项目文件（扩展名 .gsub，XML 格式）
// 保存完整字幕内容：序号 / 起始时码 / 结束时码 / 原文 / 译文 + 元数据，
// 以便下次「打开项目」能完整还原继续编辑。

export const GSUB_VERSION = '1.0';

// XML 文本/属性转义（覆盖 & < > " '）
function escapeXml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 把字幕条目序列化为 .gsub 的 XML 字符串。
 * @param {Array} items  [{ index, start, end, source, target }]
 * @param {object} meta  { sourcePath, bilingual, created }
 */
export function serializeProject(items, meta = {}) {
  const created = meta.created || new Date().toISOString();
  const sourcePath = meta.sourcePath || '';
  const bilingual = meta.bilingual ? 'true' : 'false';

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<gsub version="${GSUB_VERSION}">`);
  out.push('  <meta>');
  out.push(`    <sourcePath>${escapeXml(sourcePath)}</sourcePath>`);
  out.push(`    <bilingual>${bilingual}</bilingual>`);
  out.push(`    <created>${escapeXml(created)}</created>`);
  out.push('  </meta>');
  out.push('  <subtitles>');
  items.forEach((it, i) => {
    const index = it.index != null ? it.index : i + 1;
    const start = it.start || '';
    const end = it.end || '';
    out.push(
      `    <item index="${escapeXml(index)}" start="${escapeXml(start)}" end="${escapeXml(end)}">`
    );
    out.push(`      <source>${escapeXml(it.source || '')}</source>`);
    out.push(`      <target>${escapeXml(it.target || '')}</target>`);
    out.push('    </item>');
  });
  out.push('  </subtitles>');
  out.push('</gsub>');
  return out.join('\n') + '\n';
}

/**
 * 解析 .gsub 的 XML 字符串，返回 { items, meta }。
 * 解析失败时抛出带说明的 Error。
 */
export function parseProject(xml) {
  if (typeof DOMParser === 'undefined') {
    throw new Error('当前环境不支持 XML 解析');
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) {
    throw new Error('XML 解析失败：' + (perr.textContent || '未知错误'));
  }
  const gsub = doc.querySelector('gsub');
  if (!gsub) {
    throw new Error('不是有效的 .gsub 项目文件（缺少 <gsub> 根节点）');
  }

  const meta = {};
  const sp = doc.querySelector('meta > sourcePath');
  if (sp) meta.sourcePath = sp.textContent || '';
  const bi = doc.querySelector('meta > bilingual');
  if (bi) meta.bilingual = bi.textContent.trim() === 'true';
  const cr = doc.querySelector('meta > created');
  if (cr) meta.created = cr.textContent || '';

  const items = [];
  const itemEls = doc.querySelectorAll('subtitles > item');
  itemEls.forEach((el) => {
    const indexAttr = el.getAttribute('index');
    const index =
      indexAttr !== null && indexAttr !== ''
        ? Number(indexAttr)
        : items.length + 1;
    const start = el.getAttribute('start') || '';
    const end = el.getAttribute('end') || '';
    const sourceEl = el.querySelector('source');
    const targetEl = el.querySelector('target');
    const source = sourceEl ? sourceEl.textContent || '' : '';
    const target = targetEl ? targetEl.textContent || '' : '';
    items.push({
      index: Number.isFinite(index) ? index : items.length + 1,
      start,
      end,
      source,
      target,
    });
  });

  return { items, meta };
}
