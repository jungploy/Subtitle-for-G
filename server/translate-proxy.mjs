// server/translate-proxy.mjs
// 本地翻译代理（零依赖，Node 18+ 自带 fetch）。
// 作用：让浏览器端的 Web 原型能安全调用翻译 API —— API key 只留在本机代理，
// 不进浏览器、不被前端代码暴露；同时规避浏览器 CORS 限制。
//
// 启动：  node server/translate-proxy.mjs
// 默认监听 http://localhost:8787
//
// 前端会把请求 POST 到 /api/translate，body: { lines:[...], provider, apiKey, model }
// 返回: { translations:[...] } （与 lines 顺序一致）

import http from 'node:http';

const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/translate') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    const { lines, provider, apiKey, model } = payload;
    try {
      const translations = await translate(lines, { provider, apiKey, model });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ translations }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

async function translate(lines, { provider, apiKey, model }) {
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

server.listen(PORT, () => {
  console.log(`translate proxy listening on http://localhost:${PORT}`);
});
