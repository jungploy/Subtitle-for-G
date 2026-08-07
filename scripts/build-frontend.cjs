// scripts/build-frontend.cjs
// 将 Web 前端（index.html / style.css / src / sample.srt）复制到 dist/，
// 供 Tauri 打包（frontendDist 指向 ../dist）。运行：npm run build
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const files = ['index.html', 'style.css', 'sample.srt'];
const dirs = ['src'];

function copyFile(s, d) {
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
}
function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const ss = path.join(s, e.name);
    const dd = path.join(d, e.name);
    if (e.isDirectory()) copyDir(ss, dd);
    else copyFile(ss, dd);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const f of files) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) copyFile(src, path.join(dist, f));
}
for (const d of dirs) {
  const src = path.join(root, d);
  if (fs.existsSync(src)) copyDir(src, path.join(dist, d));
}
console.log('frontend copied ->', dist);
