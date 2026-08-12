// src/app.js
import { parseSRT } from './srt.js';
import { parseAss } from './ass.js';
import { parseEdius, isEdius, fpsToValue, ediusProbeFps } from './edius.js';
import { createEditor } from './editor.js';
import { translateLines, translateDocument, normalizeTranslationLine, alignSegments } from './translate.js';
import { serializeProject, parseProject } from './project.js';
import { plainText, renderRich, replaceRich } from './rich.js';
import { normalizeImportText } from './textnorm.js';

// 编辑会话快照：进入单元格编辑（focus）时记下修改前的整表状态，
// 失焦（blur）时若确有改动则生成一条「编辑」修改记录；离散操作（互换/替换/翻译）
// 开始前也会先 flush 掉进行中的编辑会话，避免重复记录。
let pendingEdit = null;

const editor = createEditor(document.getElementById('editorMount'), {
  onChange: () => {
    dirty = true;
    schedulePushBuffer();
    if (pendingEdit) pendingEdit.modified = true;
    updateSelectionStats();
  },
  onActiveChange: () => updateSelectionStats(),
  onEditBegin: (meta) => {
    pendingEdit = { before: deepClone(editor.getItems()), meta, modified: false };
  },
  onEditCommit: () => flushPendingEdit(),
  onStructuralChange: (label, before) => {
    pushHistory(label, deepClone(before), label);
  },
});
let dirty = false;
// 当前打开的源文件路径（用于保存项目时写进 meta；浏览器环境下仅保留文件名）
let currentSourcePath = '';
// 当前工程文件（.gsub）的完整路径；保存按钮在有此路径时直接覆盖，关闭时据此自动保存
let currentProjectPath = null;

// 生成当前工程的 .gsub XML 字符串（供保存 / 关闭自动保存复用）
function getProjectXml() {
  const items = editor.getItems();
  const hasTarget = items.some((it) => (it.target || '').trim().length);
  return serializeProject(items, {
    sourcePath: currentSourcePath,
    bilingual: hasTarget,
    created: new Date().toISOString(),
  });
}

// 把当前工程最新内容推给 Python 端，供「关闭时询问是否保存」使用。
// dirty 标记自上次保存/打开以来是否改动过（Python 端据此判断是否弹保存提示）。
function pushProjectBuffer() {
  if (!isPyWebView()) return;
  try {
    window.pywebview.api.set_project_buffer(currentProjectPath, getProjectXml(), dirty);
  } catch (e) {
    /* 忽略：推送失败不影响手动保存 */
  }
}

// 编辑后防抖推送（~800ms），保证关闭时 Python 端持有较新的内容
let _bufferTimer = null;
function schedulePushBuffer() {
  if (_bufferTimer) clearTimeout(_bufferTimer);
  _bufferTimer = setTimeout(pushProjectBuffer, 800);
}

const $ = (id) => document.getElementById(id);
const statusEl = $('statusMsg');
const statsEl = $('statusStats');

// 是否运行在 Tauri 原生窗口（与 translate.js 的判定保持一致）
function isTauri() {
  return typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.dialog;
}

function isPyWebView() {
  return typeof window !== 'undefined' && window.pywebview && window.pywebview.api;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// 状态栏全文翻译进度条：percent 为 0~100 的数字；label 可选，会同步写进状态文字。
// indeterminate=true 时显示「不确定（跑动）」动画——用于整篇翻译（无真实百分比）。
const progressEl = $('statusProgress');
const progressFill = $('statusProgressFill');
const progressText = $('statusProgressText');

function showProgress(percent, label, indeterminate) {
  if (!progressEl) return;
  progressEl.hidden = false;
  if (indeterminate) {
    progressEl.classList.add('indeterminate');
    if (progressText) progressText.textContent = '…';
  } else {
    progressEl.classList.remove('indeterminate');
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    if (progressFill) progressFill.style.width = p + '%';
    if (progressText) progressText.textContent = p + '%';
  }
  if (label != null && statusEl) statusEl.textContent = label;
}

function hideProgress() {
  if (!progressEl) return;
  progressEl.hidden = true;
  progressEl.classList.remove('indeterminate');
  if (progressFill) progressFill.style.width = '0%';
  if (progressText) progressText.textContent = '0%';
}

// 状态栏右侧统计：字幕总行数
function updateStats() {
  const items = editor.getItems() || [];
  statsEl.textContent = `共 ${items.length} 条`;
}

// 深拷贝 / 相等判断（用于修改记录快照对比）
function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
function itemsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 计算一段「显示用 HTML」的纯文字长度（去掉标签与换行，只数可见字符）
function textLength(html) {
  return plainText(html || '').replace(/\r?\n/g, '').length;
}

// 底部状态栏：选中行的原文 / 译文文字长度
const selEl = $('statusSel');
function updateSelectionStats() {
  if (!selEl) return;
  const sel = editor.getSelectedIndices();
  if (!sel.length) {
    selEl.textContent = '未选中行';
    return;
  }
  if (sel.length === 1) {
    const ai = sel[0];
    const it = (editor.getItems() || [])[ai];
    if (!it) {
      selEl.textContent = '未选中行';
      return;
    }
    selEl.textContent = `选中 第${ai + 1}行 · 原文 ${textLength(it.source)} · 译文 ${textLength(it.target)}`;
  } else {
    selEl.textContent = `已选中 ${sel.length} 行`;
  }
}

// --------------------------------------------------------------------------
// 修改记录（历史）：始终保持最近 HISTORY_MAX 条（滑动窗口，超出则丢弃最旧的一条）；
// 点击某条可「回滚」到该次修改之前，回滚后该条及其后续记录变灰，再次点击灰条可「重做」到那一步。
// 每条记录同时保存 before（修改前快照）与 after（修改后快照）。
// historyPoint = 当前已应用的修改条数（0 表示初始状态，即尚未应用任何修改）。
// --------------------------------------------------------------------------
const HISTORY_MAX = 30;
let history = [];
let historyPoint = 0;

// 把一段文字截断到 maxlen，超出加省略号（用于修改记录第二行展示具体改动）
function trunc(s, maxlen) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > maxlen ? s.slice(0, maxlen) + '…' : s;
}

// 在离散操作（互换/替换/翻译）开始前调用：把进行中的单元格编辑会话结算掉，
// 防止随后 DOM 重建引发的 blur 再次生成重复记录。
function flushPendingEdit() {
  if (pendingEdit && pendingEdit.modified) {
    const after = editor.getItems();
    if (!itemsEqual(pendingEdit.before, after)) {
      const m = pendingEdit.meta || { index: 0, side: 'source' };
      const i = m.index ?? 0;
      const side = m.side === 'source' ? '原文' : '译文';
      const oldV = plainText(pendingEdit.before[i]?.[m.side] || '');
      const newV = plainText(after[i]?.[m.side] || '');
      const detail = `第${i + 1}行 ${side}：${trunc(oldV, 16)} → ${trunc(newV, 16)}`;
      pushHistory(`编辑 第${i + 1}行 ${side}`, pendingEdit.before, detail);
    }
  }
  pendingEdit = null;
}

// 新增一条修改记录（before = 修改前快照；after 在调用此刻从编辑器读取；
// detail = 第二行要展示的具体修改内容，如「旧 → 新」「查找 → 替换」等）
function pushHistory(label, before, detail) {
  // 若处于「已撤销」分支，新的修改会截断其后的（未来）记录
  if (historyPoint < history.length) {
    history.length = historyPoint;
  }
  const after = deepClone(editor.getItems());
  history.push({ label, ts: Date.now(), before: deepClone(before), after, detail: detail || '' });
  historyPoint = history.length; // 指向最新一条之后
  // 超出上限：丢弃最旧的一条，始终保持「最近 HISTORY_MAX 条」的滑动窗口
  if (history.length > HISTORY_MAX) {
    history.shift();
    historyPoint -= 1;
  }
  renderHistory();
}

// 跳转到第 e 次修改（1-based）：e <= historyPoint 为「撤销」，否则为「重做」
function goTo(e) {
  const k = e - 1;
  if (k < 0 || k >= history.length) return;
  if (e <= historyPoint) {
    editor.setItems(deepClone(history[k].before));
    historyPoint = e - 1;
    setStatus(`已回滚到「${history[k].label}」之前`);
  } else {
    editor.setItems(deepClone(history[k].after));
    historyPoint = e;
    setStatus(`已重做到「${history[k].label}」之后`);
  }
  dirty = true;
  schedulePushBuffer();
  updateStats();
  updateSelectionStats();
  renderHistory();
}

// 撤销一步：回退到上一条修改之前（与点击该条历史记录等价）
function undo() {
  if (historyPoint > 0) goTo(historyPoint);
}
// 重做一步：前进到下一条修改之后
function redo() {
  if (historyPoint < history.length) goTo(historyPoint + 1);
}

// 维护撤销/重做按钮的可用状态（无可撤销/重做时禁用）
function updateUndoRedo() {
  const u = $('undoBtn');
  const r = $('redoBtn');
  if (u) u.disabled = historyPoint <= 0;
  if (r) r.disabled = historyPoint >= history.length;
}

// 清空修改记录（一般在打开 / 加载新工程时调用，避免旧快照指向不同内容）
function clearHistory() {
  history = [];
  historyPoint = 0;
  renderHistory();
}

// 渲染右侧修改记录列表（从上到下：最早 → 最新）。
// 已应用的记录正常显示；撤销后的「未来」记录变灰，点击即重做。
function renderHistory() {
  const ul = $('historyList');
  if (!ul) return;
  ul.innerHTML = '';
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = '暂无修改记录';
    ul.appendChild(li);
    return;
  }
  for (let i = 0; i < history.length; i++) {
    const e = i + 1;
    const rec = history[i];
    const t = new Date(rec.ts);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const future = e > historyPoint;
    const li = document.createElement('li');
    li.className = 'history-item' + (future ? ' history-future' : '');
    li.title = future
      ? `点击重做到「${rec.label}」之后`
      : `点击回滚到「${rec.label}」之前`;
    li.innerHTML =
      `<div class="h-main">` +
        `<span class="h-idx">${e}</span>` +
        `<span class="h-label">${escapeHtml(rec.label)}</span>` +
        `<span class="h-time">${hh}:${mm}:${ss}</span>` +
      `</div>` +
      `<div class="h-detail">${escapeHtml(rec.detail || '')}</div>`;
    li.addEventListener('click', () => goTo(e));
    ul.appendChild(li);
  }
  updateUndoRedo();
}

// 把模型中存储的文本统一规范为「显示用 HTML」：
// - 含换行或 <font> 的原始字幕标记 -> 经 renderRich 转成安全的 HTML（去大小/颜色，留 b/i，换行转 <br>）；
// - 已是 HTML（含 <br>、<b> 等，来自之前保存的 .gsub）→ 原样返回。
function toHtml(s) {
  if (!s) return '';
  if (/[\n\r]/.test(s) || /<font\b/i.test(s)) return renderRich(s);
  return s;
}

// 毫秒 -> SRT 时间码（前端版，与 editor.js 的 msToTime 等价）
function msToTimeJs(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mills = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mills).padStart(3, '0')}`;
}

// 把「纯文本（一行一条）」解析为字幕条目：每行作为一条原文，顺序给占位时码（每行 3 秒）。
function parseLinesToItems(text) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  const GAP = 3000;
  let n = 0;
  // 双语纯文本导出格式：原文 + 「\\」两个反斜杠 + 译文（单行）。导入时按两个反斜杠拆回两列。
  const BS2 = String.fromCharCode(92, 92);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let source = line;
    let target = '';
    const sep = line.indexOf(BS2);
    if (sep !== -1) {
      source = line.slice(0, sep);
      target = line.slice(sep + 2);
    }
    // 非中文文本的中文全角标点归一化为英文标点（中文原文保持不变）
    source = normalizeImportText(source);
    target = normalizeImportText(target);
    items.push({
      index: 0,
      start: msToTimeJs(n * GAP),
      end: msToTimeJs((n + 1) * GAP),
      source,
      target,
    });
    n += 1;
  }
  return items;
}

// 把后端返回的「原始条目（source/target 为纯文本，可能含 \n）」套上 HTML 后载入编辑器。
async function applyImportedItems(rawItems, msg) {
  const items = (rawItems || []).map((it) => ({
    index: 0,
    start: it.start || '',
    end: it.end || '',
    source: toHtml(it.source || ''),
    target: toHtml(it.target || ''),
  }));
  await showLoading('正在导入…');
  await editor.setItemsAsync(items, setLoadingProgress);
  updateStats();
  clearHistory();
  updateSelectionStats();
  dirty = true;
  pushProjectBuffer();
  hideLoading();
  setStatus(msg);
}

// —— 加载进度遮罩 ——
// 大文件（上千条字幕）导入时一次性建表会卡顿数秒，先用遮罩 + 进度条给出可见反馈。
function showLoading(title) {
  const ov = $('loadingOverlay');
  if (title) $('loadingText').textContent = title;
  $('loadingProgressFill').style.width = '0%';
  $('loadingProgressLabel').textContent = '0%';
  ov.hidden = false;
  // 让出一帧，确保遮罩在重活开始前先绘制出来（否则可能看不到）
  return new Promise((r) => requestAnimationFrame(() => r()));
}
function setLoadingProgress(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
  $('loadingProgressFill').style.width = pct + '%';
  $('loadingProgressLabel').textContent = pct + '%';
}
function hideLoading() {
  $('loadingOverlay').hidden = true;
}

// 让用户选择 EDIUS 工程帧率，并记忆到 config（及内存 ediusFpsDefault，供导出默认）。
// opts：可选的帧率标签数组（字符串），默认 ['23.976','24','25']。
//   - 导入时传默认的 3 项（29.976 靠帧号自动识别，无需列入）；
//   - 导出时传 ['23.976','24','25','29.976'] 共 4 项。
// 返回选中的帧率数值；理论上不可关闭，保留 null 作为兜底。
let ediusFpsDefault = 25;

function askEdiusFps(opts) {
  const options = opts || ['23.976', '24', '25'];
  return new Promise((resolve) => {
    const dlg = $('fpsDialog');
    const container = $('fpsOptions');
    container.innerHTML = ''; // 动态重建按钮，支持不同调用场景的帧率集合
    const buttons = options.map((label) => {
      const b = document.createElement('button');
      b.className = 'fps-btn';
      b.dataset.fps = label;
      b.textContent = label + ' fps';
      b.classList.toggle('selected', parseFloat(label) === ediusFpsDefault);
      container.appendChild(b);
      return b;
    });
    dlg.hidden = false;
    const cleanup = () => {
      buttons.forEach((b) => b.removeEventListener('click', onClick));
      dlg.hidden = true;
    };
    const onClick = (e) => {
      const fps = parseFloat(e.currentTarget.dataset.fps);
      ediusFpsDefault = fps;
      saveConfig({ ediusFps: fps }); // 记忆，下次默认选中
      cleanup();
      resolve(fps);
    };
    buttons.forEach((b) => b.addEventListener('click', onClick));
  });
}

async function loadText(text) {
  // 自动识别字幕格式：
  //   1) EDIUS（HH:MM:SS:FF 起始 结束 文本，常见于 EDIUS 导出的 .txt）
  //   2) ASS（Advanced SubStation Alpha）：含 [Script Info] / [Events] 与 Dialogue: 行
  //   3) 其余走 SRT / 字幕通用解析
  await showLoading('正在解析字幕…');
  let result;
  if (isEdius(text)) {
    // 先隐藏解析进度遮罩（其 z-index 高于模态框），再确认工程帧率
    hideLoading();
    // 自动识别 29.976（帧号≥25 即可判定），免弹窗；其余帧率仍需用户确认
    let fps = ediusProbeFps(text);
    if (fps == null) fps = await askEdiusFps(['23.976', '24', '25']);
    if (fps == null) return { count: 0, bilingual: false };
    ediusFpsDefault = fps; // 记忆（供导出默认帧率保持一致）
    result = parseEdius(text, fps);
  } else {
    const isAss = /^\s*\[Script Info\]/im.test(text) || /^\s*Dialogue:/im.test(text);
    result = isAss ? parseAss(text) : parseSRT(text);
  }
  const { items, bilingual } = result;
  const htmlItems = items.map((it) => ({
    ...it,
    source: toHtml(it.source),
    target: toHtml(it.target),
  }));
  // 分块建表并回报进度，避免大文件卡死
  await editor.setItemsAsync(htmlItems, setLoadingProgress);
  updateStats();
  clearHistory();
  updateSelectionStats();
  dirty = true;
  pushProjectBuffer();
  hideLoading();
  return { count: items.length, bilingual };
}

// 加载内置示例
$('loadSample').addEventListener('click', async () => {
  const res = await fetch('sample.srt');
  const r = await loadText(await res.text());
  setStatus(`已加载示例 ${r.count} 条${r.bilingual ? '（已识别双语，分列两侧）' : ''}`);
});

// 上传本地文件（浏览器回退）：按扩展名路由 —— .gsub 走项目解析，其余走字幕解析
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  // 仅导入时码（浏览器回退）：走专用逻辑，不触发普通导入
  if (pendingTimecodeImport) {
    pendingTimecodeImport = false;
    await applyTimecodesFromText(text, f.name);
    e.target.value = '';
    return;
  }
  if (f.name.toLowerCase().endsWith('.gsub')) {
    openProjectFromText(text, f.name);
    return;
  }
  if (f.name.toLowerCase().endsWith('.txt')) {
    currentSourcePath = f.name; // 浏览器无完整路径，仅记录文件名
    // 带时间码的 EDIUS 格式 .txt 也走 loadText（自动识别）；否则按无时码纯文本处理
    if (isEdius(text)) {
      const r = await loadText(text);
      setStatus(`已加载文件：${f.name}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
    } else {
      const items = parseLinesToItems(text);
      const bil = items.some((it) => it.target && it.target.trim());
      applyImportedItems(items, `已导入文本：${f.name}（${items.length} 条 → ${bil ? '原文+译文' : '原文'}）`);
    }
    return;
  }
  currentSourcePath = f.name; // 浏览器无完整路径，仅记录文件名
  const r = await loadText(text);
  setStatus(`已加载文件：${f.name}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
});

// 打开 SRT / 字幕文件：Tauri 用原生对话框 + Rust 读取；pywebview 用 Python 原生对话框；
// 浏览器用隐藏 fileInput 回退
function openSrt() {
  if (isTauri()) {
    try {
      return (async () => {
        const path = await window.__TAURI__.dialog.open({
          multiple: false,
          filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'txt'] }],
        });
        if (!path) return;
        const text = await window.__TAURI__.core.invoke('read_file', { path });
        currentSourcePath = path;
        const r = await loadText(text);
        setStatus(`已打开：${path}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
      })().catch((e) => setStatus('打开失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('打开失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      return (async () => {
        const r = await window.pywebview.api.open_file();
        if (!r) return;
        currentSourcePath = r.path;
        const info = await loadText(r.text);
        setStatus(`已打开：${r.path}（${info.count} 条${info.bilingual ? ' · 双语' : ''}）`);
      })().catch((e) => setStatus('打开失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('打开失败：' + (e?.message || e));
    }
  } else {
    $('fileInput').click();
  }
}

// 导入纯文本文件：每行作为一条原文（pywebview 走 Python 原生对话框；其余回退 fileInput）。
function importTxt() {
  if (isPyWebView()) {
    try {
      return (async () => {
        const r = await window.pywebview.api.import_text();
        if (!r) return;
        currentSourcePath = r.path || '';
        const items = parseLinesToItems(r.text);
        const bil = items.some((it) => it.target && it.target.trim());
        await applyImportedItems(items, `已导入文本：${r.path}（${items.length} 条 → ${bil ? '原文+译文' : '原文'}）`);
      })().catch((e) => setStatus('导入失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('导入失败：' + (e?.message || e));
    }
  } else {
    $('fileInput').click();
  }
}

// 智能导入 Word 文档：pywebview 走 Python 端解析（自动识别时间码），其余环境暂不支持。
function importDocx() {
  if (isPyWebView()) {
    try {
      return (async () => {
        const r = await window.pywebview.api.import_docx();
        if (!r) return;
        if (r.error) { setStatus('Word 导入失败：' + r.error); return; }
        currentSourcePath = r.path || '';
        await applyImportedItems(r.items || [], `已智能导入：${r.path}（${r.items ? r.items.length : 0} 条，已自动识别时间码）`);
      })().catch((e) => setStatus('导入失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('导入失败：' + (e?.message || e));
    }
  } else {
    setStatus('Word 智能导入仅桌面版（.exe）支持');
  }
}

// 仅导入时码：用带时码的文件（EDIUS .txt / SRT / ASS 等）的时码，按行序替换当前列表的时码。
// 文本与译文保持不变；当前列表为空则提示。文件名仅用于状态栏显示。
// 浏览器回退时通过隐藏 fileInput 取文件，用 pendingTimecodeImport 标记用途。
let pendingTimecodeImport = false;

function importTimecodes() {
  if (!editor.getItems().length) {
    setStatus('当前列表为空，无法替换时码');
    return;
  }
  if (isTauri()) {
    try {
      return (async () => {
        const path = await window.__TAURI__.dialog.open({
          multiple: false,
          filters: [{ name: '时码文件', extensions: ['srt', 'vtt', 'ass', 'txt'] }],
        });
        if (!path) return;
        const text = await window.__TAURI__.core.invoke('read_file', { path });
        await applyTimecodesFromText(text, path);
      })().catch((e) => setStatus('导入时码失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('导入时码失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      return (async () => {
        const r = await window.pywebview.api.open_file();
        if (!r) return;
        await applyTimecodesFromText(r.text, r.path);
      })().catch((e) => setStatus('导入时码失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('导入时码失败：' + (e?.message || e));
    }
  } else {
    pendingTimecodeImport = true;
    $('fileInput').click();
  }
}

// 从文件文本解析时码并替换当前列表时码（按行序）。复用 loadText 的格式识别逻辑。
async function applyTimecodesFromText(text, path) {
  const current = editor.getItems();
  if (!current.length) { setStatus('当前列表为空，无法替换时码'); return; }

  // 解析时码（与 loadText 一致：EDIUS → ASS → SRT/VTT/纯文本）
  let parsed;
  if (isEdius(text)) {
    let fps = ediusProbeFps(text);
    if (fps == null) {
      hideLoading();
      fps = await askEdiusFps(['23.976', '24', '25']);
      if (fps == null) return; // 用户取消帧率选择
    }
    parsed = parseEdius(text, fps).items;
  } else {
    const isAss = /^\s*\[Script Info\]/im.test(text) || /^\s*Dialogue:/im.test(text);
    parsed = (isAss ? parseAss(text) : parseSRT(text)).items;
  }

  if (!parsed.length) { setStatus('所选文件未解析出任何时码'); return; }

  let replaced = 0;
  const updated = current.map((it, i) => {
    if (i < parsed.length && parsed[i].start && parsed[i].end) {
      replaced++;
      return { ...it, start: parsed[i].start, end: parsed[i].end };
    }
    return it;
  });
  editor.setItems(updated);
  updateStats();
  updateSelectionStats();
  dirty = true;
  pushProjectBuffer();

  const name = path ? `（${path.split(/[\\/]/).pop()}）` : '';
  let msg = `已用时码文件${name}替换 ${replaced} 条时码`;
  if (parsed.length < current.length) {
    msg += `；文件仅 ${parsed.length} 条，其余 ${current.length - parsed.length} 条时码未改动`;
  } else if (parsed.length > current.length) {
    msg += `；文件共 ${parsed.length} 条，超出当前列表的 ${parsed.length - current.length} 条已忽略`;
  }
  setStatus(msg);
}

// 下载导出（浏览器回退）
function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------------------
// 项目文件（.gsub / XML）：打开项目、保存项目
// --------------------------------------------------------------------------
const PROJECT_DEFAULT_NAME = 'subtitle_project.gsub';

// 另存为时的默认文件名：若当前是从某个 SRT/字幕文件打开的（currentSourcePath 非空、
// 且尚未归属某个工程文件 currentProjectPath），则用该文件名（去扩展名）同名存为 .gsub；
// 否则回退到通用默认名。这样「打开 movie.srt → 第一次保存工程」默认就叫 movie.gsub。
function defaultProjectName() {
  if (currentSourcePath) {
    const base = currentSourcePath.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const name = (stem || 'subtitle_project') + '.gsub';
    return name;
  }
  return PROJECT_DEFAULT_NAME;
}

// 用项目文本载入编辑器（被「打开项目」按钮与 .gsub 文件拖入/选择复用）
async function openProjectFromText(text, name, path) {
  try {
    const { items, meta } = parseProject(text);
    if (!items.length) {
      setStatus('项目文件为空，没有可载入的字幕');
      return;
    }
    // 旧版 .gsub 存的是原始字幕标记（含换行 / <font>），这里统一规范为显示用 HTML；
    // 新版 .gsub 已是 HTML，toHtml 会原样返回。
    const htmlItems = items.map((it) => ({
      ...it,
      source: toHtml(it.source),
      target: toHtml(it.target),
    }));
    await showLoading('正在打开项目…');
    await editor.setItemsAsync(htmlItems, setLoadingProgress);
    updateStats();
    clearHistory();
    updateSelectionStats();
    dirty = false;
    // 记录当前工程路径：来自「打开项目」对话框时 path 已知，可支持「直接保存 / 关闭自动保存」
    currentProjectPath = path || null;
    if (meta.sourcePath) currentSourcePath = meta.sourcePath;
    pushProjectBuffer();
    hideLoading();
    setStatus(`已打开项目：${name}（${items.length} 条）`);
  } catch (e) {
    hideLoading();
    setStatus('项目解析失败：' + (e.message || e));
  }
}

// 打开项目：Tauri 用原生对话框；pywebview 用 Python 原生对话框；浏览器用 fileInput 回退
function openProject() {
  if (isTauri()) {
    try {
      return (async () => {
        const path = await window.__TAURI__.dialog.open({
          multiple: false,
          filters: [{ name: '字幕项目', extensions: ['gsub'] }],
        });
        if (!path) return;
        const text = await window.__TAURI__.core.invoke('read_file', { path });
        openProjectFromText(text, path);
      })().catch((e) => setStatus('打开项目失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('打开项目失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      return (async () => {
        const r = await window.pywebview.api.open_project();
        if (!r) return;
        openProjectFromText(r.text, r.path, r.path);
      })().catch((e) => setStatus('打开项目失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('打开项目失败：' + (e?.message || e));
    }
  } else {
    $('fileInput').click(); // 浏览器回退：change 内按扩展名路由到项目解析
  }
}

// 保存项目：把当前所有字幕（时间码/原文/译文）与元数据写成 .gsub（XML）
// - 有明确工程路径（currentProjectPath）→ 直接覆盖该文件（快速保存，不弹对话框）；
// - 否则回退到「另存为」弹窗选择文件名。
async function saveProject() {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可保存的内容');
    return;
  }
  const xml = getProjectXml();

  if (isTauri()) {
    try {
      if (currentProjectPath) {
        await window.__TAURI__.core.invoke('write_file', {
          path: currentProjectPath,
          contents: xml,
        });
        dirty = false;
        pushProjectBuffer();
        setStatus(`项目已保存到：${currentProjectPath}`);
      } else {
        await saveProjectAs();
      }
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      if (currentProjectPath) {
        // 直接保存到当前工程文件，不弹对话框
        try {
          const path = await window.pywebview.api.save_project_to_path(currentProjectPath, xml);
          dirty = false;
          pushProjectBuffer();
          setStatus(`项目已保存到：${path}`);
        } catch (e) {
          // 直接保存失败（如路径非法/无写权限）→ 回退到「另存为」让用户重选
          await saveProjectAs();
        }
      } else {
        await saveProjectAs();
      }
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else {
    download(PROJECT_DEFAULT_NAME, xml);
    setStatus('已导出项目文件 .gsub');
  }
}

// 另存为：弹出保存对话框选择文件名，并把结果记为当前工程路径
async function saveProjectAs() {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可保存的内容');
    return;
  }
  const xml = getProjectXml();

  if (isTauri()) {
    try {
      const path = await window.__TAURI__.dialog.save({
        defaultPath: defaultProjectName(),
        filters: [{ name: '字幕项目', extensions: ['gsub'] }],
      });
      if (!path) return;
      await window.__TAURI__.core.invoke('write_file', { path, contents: xml });
      currentProjectPath = path;
      dirty = false;
      pushProjectBuffer();
      setStatus(`项目已保存到：${path}`);
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      const path = await window.pywebview.api.save_project(defaultProjectName(), xml);
      if (!path) return;
      currentProjectPath = path;
      dirty = false;
      pushProjectBuffer();
      setStatus(`项目已保存到：${path}`);
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else {
    download(defaultProjectName(), xml);
    setStatus('已导出项目文件 .gsub');
  }
}

$('saveProject').addEventListener('click', saveProject);

// --------------------------------------------------------------------------
// 导出字幕：纯文本 / SRT / VTT，可选 原文 / 译文 / 原文+译文（双行）
// --------------------------------------------------------------------------
// 取某条字幕在指定内容模式下要导出的纯文本行（已去标签，<br> 还原为换行；空行剔除）
function exportLines(it, content) {
  const s = plainText(it.source || '');
  const t = plainText(it.target || '');
  if (content === 'source') return [s].filter(Boolean);
  if (content === 'target') return [t || s].filter(Boolean); // 译文为空时回退原文
  // bilingual（纯文本）：原文与译文用两个反斜杠连成一行，如「原文\\译文」
  const parts = [];
  if (s) parts.push(s);
  if (t) parts.push(t);
  return [parts.join('\\\\')].filter(Boolean);
}

// 纯文本：每条之间不空行（单换行相连）；双语每条内为「原文\\译文」单行
function buildTxt(plain, content) {
  const blocks = plain
    .map((it) => exportLines(it, content).join('\n'))
    .filter((b) => b.length);
  return (blocks.length ? blocks.join('\n') + '\n' : '');
}

// SRT：序号 + 时间轴 + 内容块
function buildSrt(plain, content) {
  const cues = plain
    .map((it, i) => {
      const idx = it.index != null ? it.index : i + 1;
      const body = exportLines(it, content).join('\n');
      if (!body) return null;
      return `${idx}\n${it.start || '00:00:00,000'} --> ${it.end || '00:00:00,000'}\n${body}`;
    })
    .filter(Boolean);
  return (cues.length ? cues.join('\n\n') + '\n' : '');
}

// WebVTT：时间码逗号改点，前面加 WEBVTT 头
function buildVtt(plain, content) {
  const toVtt = (ts) => (ts || '00:00:00,000').replace(/,(\d{3})$/, '.$1');
  const blocks = plain
    .map((it) => {
      const body = exportLines(it, content).join('\n');
      if (!body) return null;
      return `${toVtt(it.start)} --> ${toVtt(it.end)}\n${body}`;
    })
    .filter(Boolean);
  return 'WEBVTT\n\n' + (blocks.length ? blocks.join('\n\n') + '\n' : '');
}

// EDIUS 导出：把 SRT 时间码（HH:MM:SS,mmm）反算回 EDIUS 时间码（HH:MM:SS:FF，FF=帧号）。
// 必须与导入 ediusToSrt 严格互逆：导入用 ms=round(FF/fps*1000)，故导出用 FF=round(小数秒×fps)，
// 且全程使用真实 fps（如 29.976 用 30000/1001）而非名义帧率，否则会错位（已踩坑）。
function srtToEdius(ts, fps) {
  const rate = fpsToValue(fps);
  const m = /^(\d{1,2}):(\d{2}):(\d{2}),(\d{3})$/.exec((ts || '').trim());
  if (!m) return '00:00:00:00';
  const H = +m[1], M = +m[2], S = +m[3], MS = +m[4];
  const fracSeconds = H * 3600 + M * 60 + S + MS / 1000;
  const sInt = Math.floor(fracSeconds);
  let frame = Math.round((fracSeconds - sInt) * rate);
  const nominalFps = Math.round(rate); // 仅用于进位保护
  // 进位保护：round 可能使帧号达到名义帧率上限（如 0.979×24≈24），此时进 1 秒、帧号归零
  let sec = sInt;
  if (frame >= nominalFps) { frame = 0; sec += 1; }
  const s = sec % 60;
  const mm = Math.floor(sec / 60) % 60;
  const hh = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(s)}:${p(frame)}`;
}

// EDIUS 纯文本导出：每行「起始时码 结束时码 文本」。
// 双语(content=bilingual)复用 exportLines 的「原文\\译文」单行分隔，与 EDIUS 导入格式一致；
// 原文/译文分别只取对应列（译文为空回退原文，与 txt 导出行为一致）。
function buildEdius(plain, content, fps) {
  const lines = [];
  for (const it of plain) {
    const start = srtToEdius(it.start || '00:00:00,000', fps);
    const end = srtToEdius(it.end || '00:00:00,000', fps);
    const text = exportLines(it, content).join('\n');
    if (!text) continue;
    lines.push(`${start} ${end} ${text}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

// 默认导出文件名：沿用当前源文件名（去扩展名），扩展名随格式变化；
// content 决定尾部标签（_原文 / _译文 / _双语），避免三种导出互相覆盖。
function exportDefaultName(format, content) {
  const ext = (format === 'txt' || format === 'edius') ? 'txt' : format;
  let base = 'subtitles';
  if (currentSourcePath) {
    const f = currentSourcePath.split(/[\\/]/).pop() || '';
    const dot = f.lastIndexOf('.');
    const stem = dot > 0 ? f.slice(0, dot) : f;
    if (stem) base = stem;
  }
  const tag = content === 'source' ? '_原文'
            : content === 'target' ? '_译文'
            : content === 'bilingual' ? '_双语' : '';
  return base + tag + '.' + ext;
}

// 生成导出文本；无内容返回 null（由调用方提示）。fps 仅 EDIUS 格式需要（帧率换算）。
function exportSubtitles(format, content, fps) {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可导出的内容');
    return null;
  }
  const plain = items.map((it) => ({
    index: it.index,
    start: it.start || '00:00:00,000',
    end: it.end || '00:00:00,000',
    source: it.source || '',
    target: it.target || '',
  }));
  if (format === 'txt') return buildTxt(plain, content);
  if (format === 'vtt') return buildVtt(plain, content);
  if (format === 'edius') return buildEdius(plain, content, fps);
  return buildSrt(plain, content);
}

// 直接导出（无弹窗）：按指定内容(content)与格式(format)生成文本并保存。
// content ∈ {source 原文, target 译文, bilingual 原文+译文双行}；format ∈ {txt, srt, vtt, edius}
async function doExportDirect(content, format) {
  // EDIUS 导出需要工程帧率：弹出帧率选择框（含 29.976，共 4 项），并记忆默认。
  let fps = null;
  if (format === 'edius') {
    fps = await askEdiusFps(['23.976', '24', '25', '29.976']);
    if (fps == null) return; // 用户取消帧率选择
  }
  const text = exportSubtitles(format, content, fps);
  if (text == null) return; // exportSubtitles 已提示「没有可导出的内容」
  const filename = exportDefaultName(format, content);
  const ext = (format === 'edius') ? 'txt' : format; // EDIUS 文件本质是 .txt
  if (isTauri()) {
    try {
      const path = await window.__TAURI__.dialog.save({
        defaultPath: filename,
        filters: [{ name: '导出文件', extensions: [ext] }],
      });
      if (!path) return;
      await window.__TAURI__.core.invoke('write_file', { path, contents: text });
      setStatus(`已导出：${path}`);
    } catch (e) {
      setStatus('导出失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      const path = await window.pywebview.api.save_export(filename, text);
      if (!path) return;
      setStatus(`已导出：${path}`);
    } catch (e) {
      setStatus('导出失败：' + (e?.message || e));
    }
  } else {
    download(filename, text);
    setStatus('已导出文件（浏览器下载）');
  }
}

// 导出原文 / 导出译文 / 导出全部 已作为「保存项目」下拉菜单内的二级子菜单（见 index.html #saveMenu），
// 其格式项带 data-export + data-format，点击处理在下方 saveMenu 的 click 委托中。

// 交换左右：把每一条的原文(source)与译文(target)原地互换（不重建 DOM，视图必刷新）
$('swapSides').addEventListener('click', () => {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可交换的内容');
    return;
  }
  flushPendingEdit();
  const before = deepClone(items);
  editor.swapSides();
  // 两列内容互换后，字数上限阈值也要同步交换，否则「原文列限制」会错配到译文列，
  // 导致超长标红提醒错位。
  const sEl = $('srcLenLimit');
  const tEl = $('tgtLenLimit');
  const tmp = srcLenLimit;
  srcLenLimit = tgtLenLimit;
  tgtLenLimit = tmp;
  if (sEl) sEl.value = String(srcLenLimit);
  if (tEl) tEl.value = String(tgtLenLimit);
  editor.setLengthLimits(srcLenLimit, tgtLenLimit);
  saveConfig({ lengthLimits: { source: srcLenLimit, target: tgtLenLimit } });
  dirty = true;
  schedulePushBuffer();
  pushHistory('文本互换', before, '原文 ↔ 译文 两列内容互换');
  setStatus('已交换左右内容（原文 ↔ 译文）');
});
// --------------------------------------------------------------------------
// 插入 / 删除字幕行：按钮点击 + Ins / Del 快捷键
// --------------------------------------------------------------------------
const confirmOverlay = $('confirmOverlay');

// 通用确认弹窗，返回 Promise<boolean>（确定=true / 取消或 Esc=false）
function confirmDialog(message) {
  return new Promise((resolve) => {
    const msg = $('confirmMsg');
    const okBtn = $('confirmOk');
    const cancelBtn = $('confirmCancel');
    if (msg) msg.textContent = message;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      confirmOverlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      confirmOverlay.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    confirmOverlay.addEventListener('keydown', onKey);
    confirmOverlay.hidden = false;
    try { okBtn.focus(); } catch (e) {}
  });
}

// 是否正有弹窗/面板打开（此时不响应 Ins/Del 行操作，避免误触）
function anyModalOpen() {
  const open = (id) => { const el = $(id); return el && !el.hidden; };
  return open('confirmOverlay') || open('findBar') || open('translateBar');
}

// 单元格内是否正处于「选中了一段文字」的状态（用于让 Del 原生删除文字而非删行）
function isTextSelectedInCell() {
  const ae = document.activeElement;
  if (ae && ae.isContentEditable) {
    const sel = window.getSelection();
    return !!(sel && !sel.isCollapsed && sel.toString().length > 0);
  }
  return false;
}

// 在选中行之后插入一行空白字幕（无选中行 / 列表为空时追加到末尾）
function doInsert() {
  const items = editor.getItems();
  const a = editor.getActiveIndex();
  const pos = a < 0 ? items.length : a + 1;
  flushPendingEdit();
  const before = deepClone(items);
  editor.insertRow(pos);
  dirty = true;
  schedulePushBuffer();
  pushHistory('插入行', before, `在第 ${pos + 1} 行插入空白字幕`);
  updateStats();
  updateSelectionStats();
  setStatus('已插入空白字幕行');
}

// 删除选中的一行或多行（删除前弹窗确认；单行/多行都会提示）
async function doDelete() {
  const sel = editor.getSelectedIndices();
  if (!sel.length) {
    setStatus('请先选中要删除的字幕行（单击选中，或按住 Shift 点击选择多行）');
    return;
  }
  const ok = await confirmDialog(
    sel.length === 1 ? '确定删除选中的 1 行字幕吗？' : `确定删除选中的 ${sel.length} 行字幕吗？`
  );
  if (!ok) return;
  flushPendingEdit();
  const before = deepClone(editor.getItems());
  editor.deleteRows(sel);
  dirty = true;
  schedulePushBuffer();
  pushHistory(`删除 ${sel.length} 行`, before, `删除 ${sel.length} 行字幕`);
  updateStats();
  updateSelectionStats();
  setStatus(`已删除 ${sel.length} 行字幕`);
}

$('insertRow').addEventListener('click', doInsert);
$('deleteRows').addEventListener('click', doDelete);

// Ins / Del 快捷键：插入 / 删除选中行。输入框内、或单元格已选中文字时不拦截，
// 让原生文本编辑行为生效；没有任何行选中时也不拦截 Del，避免误吞其它删除。
window.addEventListener('keydown', (e) => {
  if (anyModalOpen()) return;
  const ae = document.activeElement;
  const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  const inCell = ae && ae.isContentEditable; // 正在单元格内编辑文字时不拦截，让原生文本编辑生效
  if (e.key === 'Insert') {
    if (inField || inCell || isTextSelectedInCell()) return;
    e.preventDefault();
    doInsert();
  } else if (e.key === 'Delete') {
    if (inField || inCell || isTextSelectedInCell()) return;
    const sel = editor.getSelectedIndices();
    if (!sel.length) return;
    e.preventDefault();
    doDelete();
  }
});
// --------------------------------------------------------------------------
// 全文查找 / 替换
// --------------------------------------------------------------------------
const findBar = $('findBar');
const findQuery = $('findQuery');
const findReplace = $('findReplace');
const findCase = $('findCase');
const findWord = $('findWord');
const findRegex = $('findRegex');
const findInfo = $('findInfo');
const findPreview = $('findPreview');

const findState = { matches: [], idx: -1 };

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// 依据当前选项构造正则（global=true 用于全局匹配/替换）
function makeRegex(q, global) {
  const caseSensitive = findCase.checked;
  const wholeWord = findWord.checked;
  const asRegex = findRegex.checked;
  let pattern = q;
  let flags = global ? 'g' : '';
  if (!asRegex) pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord && !asRegex) pattern = '\\b' + pattern + '\\b';
  if (!caseSensitive) flags += 'i';
  return new RegExp(pattern, flags);
}

// 扫描全部字幕（原文 + 译文），按文档顺序返回所有命中
function buildMatches() {
  const q = findQuery.value;
  if (!q) return [];
  let re;
  try {
    re = makeRegex(q, true);
  } catch (e) {
    setStatus('正则表达式无效：' + e.message);
    return null;
  }
  const items = editor.getItems();
  const matches = [];
  const sides = ['source', 'target'];
  items.forEach((it, i) => {
    sides.forEach((side) => {
      const text = plainText(it[side] || '');
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        matches.push({
          itemIndex: i,
          side,
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
        });
      }
    });
  });
  return matches;
}

function openFindBar() {
  findBar.hidden = false;
  findQuery.focus();
  findQuery.select();
  runSearch(true);
}

function closeFindBar() {
  findBar.hidden = true;
  editor.clearMatch();
  findState.matches = [];
  findState.idx = -1;
  findInfo.textContent = '';
  findPreview.innerHTML = '';
}

// 重新计算命中；resetIdx=true 时回到第一个
function runSearch(resetIdx) {
  const matches = buildMatches();
  if (matches === null) return; // 正则错误已在 buildMatches 提示
  findState.matches = matches;
  if (resetIdx) findState.idx = matches.length ? 0 : -1;
  else if (findState.idx >= matches.length) findState.idx = matches.length - 1;
  updateFindUI();
}

function updateFindUI() {
  editor.clearMatch();
  const n = findState.matches.length;
  if (n === 0) {
    findInfo.textContent = findQuery.value ? '无匹配' : '';
    findPreview.innerHTML = '';
    if (findQuery.value) setStatus('没有匹配项');
    return;
  }
  const m = findState.matches[findState.idx];
  editor.setMatch(m.itemIndex, m.side);
  findInfo.textContent = `${findState.idx + 1} / ${n}`;

  const full = plainText(editor.getItems()[m.itemIndex][m.side] || '');
  const before = full.slice(Math.max(0, m.start - 24), m.start);
  const after = full.slice(m.end, m.end + 24);
  const sideName = m.side === 'source' ? '原文' : '译文';
  findPreview.innerHTML =
    `第 ${m.itemIndex + 1} 行 · ${sideName}：…` +
    escapeHtml(before) +
    `<mark>${escapeHtml(m.text)}</mark>` +
    escapeHtml(after) +
    '…';
  setStatus(`匹配 ${findState.idx + 1}/${n}（第 ${m.itemIndex + 1} 行 · ${sideName}）`);
}

function gotoMatch(delta) {
  const n = findState.matches.length;
  if (!n) return;
  findState.idx = (findState.idx + delta + n) % n;
  updateFindUI();
}

// 替换当前命中（逐处替换）——标签感知：保留 <b>/<i>/<u>/<br>，仅替换可见文字
function replaceCurrent() {
  const n = findState.matches.length;
  if (!n) {
    setStatus('没有可替换的内容');
    return;
  }
  const m = findState.matches[findState.idx];
  const items = editor.getItems();
  const it = items[m.itemIndex];
  flushPendingEdit();
  const before = deepClone(items);
  const re = makeRegex(findQuery.value, true);
  const { html } = replaceRich(it[m.side] || '', re, findReplace.value, {
    start: m.start,
    end: m.end,
  });
  it[m.side] = html;
  dirty = true;
  schedulePushBuffer();
  editor.setItems(items); // 刷新左右两栏
  const sideName = m.side === 'source' ? '原文' : '译文';
  pushHistory(
    `替换「${m.text}」`,
    before,
    `第${m.itemIndex + 1}行 ${sideName}：「${trunc(findQuery.value, 16)}」→「${trunc(findReplace.value, 16)}」`
  );
  runSearch(false); // 重新扫描，idx 保持当前位置
}

// 全部替换（两边、所有命中）——标签感知：保留格式，仅替换可见文字
function replaceAll() {
  const q = findQuery.value;
  if (!q) return;
  let re;
  try {
    re = makeRegex(q, true);
  } catch (e) {
    setStatus('正则表达式无效：' + e.message);
    return;
  }
  flushPendingEdit();
  const items = editor.getItems();
  const before = deepClone(items);
  let count = 0;
  const repl = findReplace.value;
  items.forEach((it) => {
    ['source', 'target'].forEach((side) => {
      const { html, count: c } = replaceRich(it[side] || '', re, repl);
      if (c) {
        it[side] = html;
        count += c;
      }
    });
  });
  dirty = true;
  schedulePushBuffer();
  editor.setItems(items);
  pushHistory(
    `全部替换（${count} 处）`,
    before,
    `全文将「${trunc(q, 16)}」→「${trunc(repl, 16)}」，共 ${count} 处`
  );
  editor.clearMatch();
  findState.matches = [];
  findState.idx = -1;
  findInfo.textContent = '';
  findPreview.innerHTML = '';
  setStatus(`已替换 ${count} 处`);
}

$('findReplaceToggle').addEventListener('click', () =>
  findBar.hidden ? openFindBar() : closeFindBar()
);
$('findClose').addEventListener('click', closeFindBar);
findQuery.addEventListener('input', () => runSearch(true));
[findCase, findWord, findRegex].forEach((cb) =>
  cb.addEventListener('change', () => runSearch(true))
);
$('findNext').addEventListener('click', () => gotoMatch(1));
$('findPrev').addEventListener('click', () => gotoMatch(-1));
$('findReplaceOne').addEventListener('click', replaceCurrent);
$('findReplaceAll').addEventListener('click', replaceAll);
findReplace.addEventListener('keydown', (e) => onFindKeydown(e, 1));
findQuery.addEventListener('keydown', (e) => onFindKeydown(e, 0));

// 在查找栏内的键盘快捷键：Enter=下一个，Shift+Enter=上一个，Esc=关闭
function onFindKeydown(e, isReplace) {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
}

// 全局 Ctrl/Cmd+F 打开查找栏
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findBar.hidden ? openFindBar() : findQuery.focus();
  }
});

// 关闭/隐藏页面时尽量把最新内容推给 Python（关闭自动保存的兜底；异步尽力而为）
window.addEventListener('pagehide', () => pushProjectBuffer());
window.addEventListener('beforeunload', () => pushProjectBuffer());

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const text = await f.text();
  if (f.name.toLowerCase().endsWith('.gsub')) {
    openProjectFromText(text, f.name);
    return;
  }
  currentSourcePath = f.name;
  const r = await loadText(text);
  setStatus(`已加载文件：${f.name}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
});

// 翻译面板（点击「翻译」按钮展开 / 收起，与查找替换一致）
const translateBar = $('translateBar');
function openTranslateBar() {
  translateBar.hidden = false;
  $('provider').focus();
}
function closeTranslateBar() {
  translateBar.hidden = true;
}

// 翻译
async function doTranslate(scope) {
  const provider = $('provider').value;
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  const whole = $('wholeDocMode').checked;
  const items = editor.getItems();

  if (provider === 'manual') {
    setStatus('当前为「手动」模式：请在右侧直接输入翻译。');
    return;
  }

  if ((provider === 'openai' || provider === 'deepl') && !apiKey) {
    setStatus('未填写 API Key，将尝试使用代理端环境变量 OPENAI_API_KEY / DEEPL_API_KEY；若失败请在上方填入 key');
  }

  try {
    if (scope === 'selected') {
      const ai = editor.getActiveIndex();
      if (ai < 0) {
        setStatus('请先在表格里点选一行，再点「翻译选中行」。');
        return;
      }
      const srcText = plainText(items[ai].source || '');
      if (!srcText.trim()) {
        setStatus(`第 ${ai + 1} 行原文为空，无需翻译。`);
        return;
      }
      setStatus(`正在翻译第 ${ai + 1} 行…`);
      flushPendingEdit();
      const before = deepClone(items);
      // 用 Array.isArray 兜底，避免翻译后端返回结构异常时解构报错
      const res = await translateLines([srcText], { provider, apiKey, model }, setStatus);
      const t = Array.isArray(res) ? res[0] : res;
      const tgt = normalizeTranslationLine(t || '');
      items[ai].target = tgt;
      editor.applyTargets();
      dirty = true;
      schedulePushBuffer();
      updateSelectionStats();
      pushHistory(
        `翻译 第${ai + 1}行`,
        before,
        `第${ai + 1}行 原文「${trunc(srcText, 16)}」→ 译文「${trunc(tgt, 16)}」`
      );
      setStatus(`已翻译第 ${ai + 1} 行`);
    } else if (whole) {
      // 整篇模式：把整篇原文作为一个请求发给引擎，保证全文人名/地名翻译一致。
      // 代价：单次请求更长，免费引擎（MyMemory）易因超长/超额度而报错；
      // 且无法给出真实百分比，进度条进入不确定（跑动）动画。
      flushPendingEdit();
      const before = deepClone(items);
      const combined = items.map((it) => plainText(it.source || '')).join('\n');
      setStatus('正在整篇翻译（保证人名/地名一致）…');
      showProgress(0, '正在整篇翻译（保证人名/地名一致）…', true);
      try {
        const translated = await translateDocument(combined, { provider, apiKey, model }, setStatus);
        const segs = alignSegments((translated || '').split('\n'), items.length);
        const normalized = segs.map(normalizeTranslationLine);
        items.forEach((it, i) => (it.target = normalized[i]));
        editor.applyTargets();
        dirty = true;
        schedulePushBuffer();
        updateSelectionStats();
        pushHistory(
          `整篇翻译全文（${items.length} 条）`,
          before,
          `整篇翻译 ${items.length} 条（${provider}）`
        );
        const okCount = normalized.filter((t) => t.trim()).length;
        setStatus(`已整篇翻译 ${okCount}/${items.length} 条（${provider}）`);
      } finally {
        hideProgress();
      }
    } else {
      // 逐行翻译：每行独立请求，既能真实反映「百分比进度」，也能避免把整篇
      // 一次性发给 MyMemory 这类免费引擎时因超长/超额度而静默返回空（表现为「翻译不出来」）。
      const total = items.length;
      const sources = items.map((it) => plainText(it.source || ''));
      const normalized = new Array(total).fill('');
      let failed = 0;
      let consecutiveFails = 0;
      flushPendingEdit();
      const before = deepClone(items);
      showProgress(0, `正在全文翻译 0/${total}…`);
      for (let i = 0; i < total; i++) {
        const src = sources[i];
        if (!src.trim()) {
          showProgress(((i + 1) / total) * 100, `正在全文翻译 ${i + 1}/${total}…`);
          continue;
        }
        let translated = '';
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const res = await translateLines([src], { provider, apiKey, model }, () => {});
            translated = normalizeTranslationLine(Array.isArray(res) ? res[0] : res);
            ok = true;
          } catch (e) {
            if (attempt === 1) {
              failed += 1;
              consecutiveFails += 1;
              setStatus('翻译出错：' + (e && e.message ? e.message : String(e)));
            }
          }
        }
        if (ok) consecutiveFails = 0;
        normalized[i] = translated || '';
        // 网络引擎（MyMemory/OpenAI/DeepL）逐行请求较密，稍作间隔避免被限流
        if (ok && (provider === 'mymemory' || provider === 'openai' || provider === 'deepl')) {
          await new Promise((r) => setTimeout(r, 120));
        }
        showProgress(((i + 1) / total) * 100, `正在全文翻译 ${i + 1}/${total}…`);
        // 连续失败过多（多为 MyMemory 配额用尽 / 网络异常）：提前中止，保留已翻译的部分
        if (consecutiveFails >= 5) {
          setStatus(`翻译中断：连续 ${consecutiveFails} 条失败，疑似翻译引擎配额用尽或网络异常，已翻译部分已保留`);
          break;
        }
      }
      items.forEach((it, i) => (it.target = normalized[i]));
      editor.applyTargets();
      dirty = true;
      schedulePushBuffer();
      updateSelectionStats();
      pushHistory(
        `翻译全文（${items.length} 条）`,
        before,
        `全文翻译 ${items.length} 条（${provider}）`
      );
      hideProgress();
      const okCount = normalized.filter((t) => t.trim()).length;
      setStatus(`已全文翻译 ${okCount}/${total} 条（${provider}）${failed ? `，${failed} 条失败` : ''}`);
    }
  } catch (e) {
    // 任何异常都明确提示，不再静默吞掉（便于排查「翻译选中行出错」）
    setStatus('翻译出错：' + (e && e.message ? e.message : String(e)));
  }
}

$('translateAll').addEventListener('click', () => doTranslate('all'));
$('translateSelected').addEventListener('click', () => doTranslate('selected'));
$('translateToggle').addEventListener('click', () =>
  translateBar.hidden ? openTranslateBar() : closeTranslateBar()
);
$('translateClose').addEventListener('click', closeTranslateBar);

// Esc 收起翻译面板（查找面板由自身输入框的 Esc 处理）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !translateBar.hidden) {
    closeTranslateBar();
  }
});

// 撤销 / 重做：关联右侧修改记录（点一下 = 后退 / 前进一步修改记录）
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

// 快捷键：Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Y（或 Ctrl/Cmd+Shift+Z）重做；
// 但正在单元格内编辑文字时不拦截，让原生文本撤销/重做生效。
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

// --------------------------------------------------------------------------
// 字体格式工具栏：选中单元格里的文字 -> 加粗 / 斜体 / 下划线
// --------------------------------------------------------------------------
function wireFormatBtn(id, cmd) {
  const btn = $(id);
  // 按下时不抢走单元格焦点，否则选区会被清空、execCommand 无处可用
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const ok = editor.applyFormat(cmd);
    if (!ok) setStatus('请先在某个单元格里选中要格式化的文字，再点击格式按钮');
  });
}
wireFormatBtn('fmtBold', 'bold');
wireFormatBtn('fmtItalic', 'italic');
wireFormatBtn('fmtUnderline', 'underline');

// --------------------------------------------------------------------------
// 程序配置：窗口大小 / 表格间距 / 文件打开位置 / 翻译引擎 由 Python 端读写 config.json
// --------------------------------------------------------------------------
let cellPad = 4;
// 字数上限：原文列 / 译文列允许的纯文字长度（0 = 不限制），超长单元格标红。
let srcLenLimit = 0;
let tgtLenLimit = 0;

function applyCellPadding(pad) {
  cellPad = Math.max(0, Math.min(20, pad | 0));
  document.documentElement.style.setProperty('--cell-pad', cellPad + 'px');
  const pv = $('padVal');
  if (pv) pv.textContent = String(cellPad);
}

function saveConfig(patch) {
  if (!isPyWebView()) return;
  try {
    window.pywebview.api.save_config(patch);
  } catch (e) {
    /* 忽略保存失败 */
  }
}

async function loadConfig() {
  if (!isPyWebView()) return; // 浏览器回退不读取配置
  try {
    const cfg = await window.pywebview.api.get_config();
    if (cfg?.provider) $('provider').value = cfg.provider;
    if (typeof cfg?.wholeDocMode === 'boolean') $('wholeDocMode').checked = cfg.wholeDocMode;
    // 「同步断句」：从配置读取（缺省 false=不勾选），统一 UI 勾选态与编辑器内部状态，
    // 并写回配置文件，保证「UI / 引擎 / 配置」三者一致。
    const syncSplit = typeof cfg?.syncSplitMode === 'boolean' ? cfg.syncSplitMode : false;
    $('syncSplit').checked = syncSplit;
    editor.setSyncSplit(syncSplit);
    saveConfig({ syncSplitMode: syncSplit });
    if (typeof cfg?.table?.cell_padding === 'number') {
      applyCellPadding(cfg.table.cell_padding);
    }
    // EDIUS 工程帧率记忆：下次打开 EDIUS 文件时默认选中上次的选择
    if (typeof cfg?.ediusFps === 'number') {
      ediusFpsDefault = cfg.ediusFps;
    }
    // 字数上限：原文 / 译文列文字长度阈值（0 = 不限制）
    if (cfg?.lengthLimits) {
      const s = Math.max(0, parseInt(cfg.lengthLimits.source, 10) || 0);
      const t = Math.max(0, parseInt(cfg.lengthLimits.target, 10) || 0);
      srcLenLimit = s;
      tgtLenLimit = t;
      const sEl = $('srcLenLimit');
      const tEl = $('tgtLenLimit');
      if (sEl) sEl.value = String(s);
      if (tEl) tEl.value = String(t);
      editor.setLengthLimits(s, t);
    }
  } catch (e) {
    /* 忽略：使用默认值 */
  }
}

// 表格间距 +/− 调节
$('padMinus').addEventListener('click', () => {
  applyCellPadding(cellPad - 1);
  saveConfig({ table: { cell_padding: cellPad } });
});
$('padPlus').addEventListener('click', () => {
  applyCellPadding(cellPad + 1);
  saveConfig({ table: { cell_padding: cellPad } });
});

// 字数上限输入框：改变后即时套用并重绘超长标红，并记忆到配置。
function applyLenLimits() {
  const sEl = $('srcLenLimit');
  const tEl = $('tgtLenLimit');
  srcLenLimit = Math.max(0, parseInt((sEl && sEl.value) || '0', 10) || 0);
  tgtLenLimit = Math.max(0, parseInt((tEl && tEl.value) || '0', 10) || 0);
  if (sEl) sEl.value = String(srcLenLimit);
  if (tEl) tEl.value = String(tgtLenLimit);
  editor.setLengthLimits(srcLenLimit, tgtLenLimit);
  saveConfig({ lengthLimits: { source: srcLenLimit, target: tgtLenLimit } });
}
if ($('srcLenLimit')) $('srcLenLimit').addEventListener('change', applyLenLimits);
if ($('tgtLenLimit')) $('tgtLenLimit').addEventListener('change', applyLenLimits);

// 翻译引擎变更时记录
$('provider').addEventListener('change', () => {
  saveConfig({ provider: $('provider').value });
});

// 「整篇翻译」开关变更时记录
$('wholeDocMode').addEventListener('change', () => {
  saveConfig({ wholeDocMode: $('wholeDocMode').checked });
});

// 「同步断句」开关变更时记录：控制断句时原文/译文是否同步拆行
$('syncSplit').addEventListener('change', () => {
  editor.setSyncSplit($('syncSplit').checked);
  saveConfig({ syncSplitMode: $('syncSplit').checked });
});

// --------------------------------------------------------------------------
// 「打开」按钮下拉：默认（直接点击）打开项目文件，下拉可切换为打开 SRT / 字幕
// --------------------------------------------------------------------------
const openDropdown = $('openDropdown');
const openMenu = $('openMenu');
const openCaret = $('openCaret');

function toggleOpenMenu(show) {
  const willShow = show === undefined ? openMenu.hidden : show;
  openMenu.hidden = !willShow;
  openCaret.setAttribute('aria-expanded', String(willShow));
}

// 直接点击「打开」主按钮：默认打开项目文件（.gsub）
$('openBtn').addEventListener('click', () => {
  openProject();
});

openCaret.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleOpenMenu();
});

openMenu.querySelectorAll('.dropdown-item').forEach((item) => {
  item.addEventListener('click', () => {
    toggleOpenMenu(false);
    const action = item.dataset.action;
    if (action === 'srt') openSrt();
    else if (action === 'txt') importTxt();
    else if (action === 'docx') importDocx();
    else if (action === 'tc') importTimecodes();
    else openProject();
  });
});

// 点击页面其它位置关闭下拉菜单
document.addEventListener('click', (e) => {
  if (!openDropdown.contains(e.target)) openMenu.hidden = true;
  if (!saveDropdown.contains(e.target)) saveMenu.hidden = true;
});

// --------------------------------------------------------------------------
// 「保存」按钮下拉：主按钮直接保存到当前工程；下拉含「另存为…」
// --------------------------------------------------------------------------
const saveDropdown = $('saveDropdown');
const saveMenu = $('saveMenu');
const saveCaret = $('saveCaret');

function toggleSaveMenu(show) {
  const willShow = show === undefined ? saveMenu.hidden : show;
  saveMenu.hidden = !willShow;
  saveCaret.setAttribute('aria-expanded', String(willShow));
}

saveCaret.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSaveMenu();
});

saveMenu.querySelectorAll('.dropdown-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    const exp = item.dataset.export;
    const fmt = item.dataset.format;
    // 导出子菜单项：直接按 content + format 导出并关闭菜单
    if (exp && fmt) {
      toggleSaveMenu(false);
      doExportDirect(exp, fmt);
      return;
    }
    if (action === 'saveAs') {
      toggleSaveMenu(false);
      saveProjectAs();
      return;
    }
    // 其余菜单项（当前无其它项）按「保存项目」处理
    toggleSaveMenu(false);
    saveProject();
  });
});

// 首次自动加载示例，便于立即预览
window.addEventListener('DOMContentLoaded', async () => {
  // 让字体格式按钮 / 原生 Ctrl+B/I/U 生成 <b>/<i>/<u> 表现型标签，而非内联 style
  try {
    document.execCommand('styleWithCSS', false, false);
  } catch (e) {
    /* 忽略：部分环境不支持该命令，不影响手动点击按钮（applyFormat 内也会再设一次） */
  }
  // 应用已成功启动：关闭启动看门狗，避免误触发自动重载
  window.__APP_BOOTED__ = true;
  try { clearTimeout(window.__BOOT_WATCHDOG__); } catch (e) {}
  try { sessionStorage.removeItem('sub_boot_retry'); } catch (e) {}

  // 显示程序版本号（标题旁徽标）；pywebview 后端从 Python 取，其他环境跳过
  if (isPyWebView()) {
    try {
      const ver = await window.pywebview.api.get_version();
      const badge = $('versionBadge');
      if (badge && ver) badge.textContent = 'v' + ver;
    } catch (e) { /* 取不到版本不影响主功能 */ }
  }

  renderHistory(); // 初始渲染（空列表）
  $('historyClear').addEventListener('click', () => {
    clearHistory();
    setStatus('已清空修改记录');
  });
  await loadConfig();
  $('loadSample').click();
});
