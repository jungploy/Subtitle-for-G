// server/translate-core.cjs
// 翻译核心逻辑（CommonJS），被 Web 代理 server/translate-proxy.mjs 与
// Electron 桌面端 electron/server.cjs 共用，避免重复实现。
// 支持 provider: mymemory(免费·无需 key) / openai / openai-compatible / deepl
'use strict';

async function translate(lines, opts = {}) {
  const { provider, apiKey, model, source = 'en', target = 'zh-CN' } = opts;

  if (provider === 'openai' || provider === 'openai-compatible') {
    const base = process.env.OPENAI_BASE || 'https://api.openai.com/v1';
    const key = apiKey || process.env.OPENAI_API_KEY || '';
    const m = model || 'gpt-4o-mini';
    const prompt =
      'You are a professional subtitle translator. Translate each numbered line into Simplified Chinese. ' +
      'Preserve the numbering exactly as "N. translated text". Keep it concise and natural for subtitles.\n\n' +
      lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`openai ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const out = data.choices?.[0]?.message?.content || '';
    return parseNumbered(out, lines.length);
  }

  if (provider === 'deepl') {
    const key = apiKey || process.env.DEEPL_API_KEY || '';
    const resp = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `DeepL-Auth-Key ${key}`,
      },
      body: new URLSearchParams({ text: lines.join('\n'), target_lang: 'ZH' }),
    });
    if (!resp.ok) throw new Error(`deepl ${resp.status}`);
    const data = await resp.json();
    return data.translations.map((t) => t.text);
  }

  if (provider === 'mymemory') {
    // 免费、无需 key 的公开翻译 API（匿名 5000 词/天，附 email 可到 10000）。
    const langpair = `${source}|${target}`;
    const out = [];
    for (const line of lines) {
      const q = (line || '').trim();
      if (!q) {
        out.push('');
        continue;
      }
      const url =
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}` +
        `&langpair=${encodeURIComponent(langpair)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`mymemory ${resp.status}`);
      const data = await resp.json();
      if (data.responseStatus && data.responseStatus !== 200) {
        throw new Error(`mymemory: ${data.responseDetails || data.responseStatus}`);
      }
      out.push(data.responseData?.translatedText || '');
    }
    return out;
  }

  throw new Error('unknown provider: ' + provider);
}

// 解析 "1. xxx\n2. yyy" 形式，映射回索引
function parseNumbered(text, n) {
  const result = new Array(n).fill('');
  const re = /^\s*(\d+)\.\s*(.*)$/;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < n) result[idx] = m[2];
    }
  }
  // 兜底：若编号解析失败，按行顺序填入
  if (result.every((r) => !r) && text.trim()) {
    const parts = text.split('\n').filter(Boolean);
    for (let i = 0; i < n && i < parts.length; i++) result[i] = parts[i].replace(/^\d+\.\s*/, '');
  }
  return result;
}

module.exports = { translate, parseNumbered };
