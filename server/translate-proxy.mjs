// server/translate-proxy.mjs
// 本地翻译代理（Web 原型用，零依赖）。翻译逻辑见 server/translate-core.cjs。
// 启动：node server/translate-proxy.mjs   默认 http://localhost:8787
// 前端 POST /api/translate，body: { lines, provider, apiKey, model, source, target }
// 返回: { translations:[...] } （与 lines 顺序一致）
import http from 'node:http';
import core from './translate-core.cjs';

const { translate } = core;
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

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/translate') {
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
    const { lines, provider, apiKey, model, source = 'en', target = 'zh-CN' } = payload;
    try {
      const translations = await translate(lines, { provider, apiKey, model, source, target });
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

server.listen(PORT, () => console.log(`translate proxy listening on http://localhost:${PORT}`));
