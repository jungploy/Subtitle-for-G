// electron/server.cjs
// 桌面端（Electron）内嵌的单端口服务：
//   - 提供静态文件（index.html / src/* / *.srt 等），MIME 正确以兼容 ES Module
//   - 提供 POST /api/translate（复用 server/translate-core.cjs）
// 这样前端代码无需任何改动即可在桌面端运行：翻译在本地进程完成，无 CORS、无 key 暴露。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('../server/translate-core.cjs');

const ROOT = path.resolve(__dirname, '..'); // 项目根目录
const PORT = process.env.PORT || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
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
  serveStatic(req, res);
});

// 允许独立运行测试： node electron/server.cjs
if (require.main === module) {
  server.listen(PORT, () => console.log(`desktop server listening on http://localhost:${PORT}`));
}

module.exports = { server, PORT };
