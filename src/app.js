// src/app.js
import { parseSRT } from './srt.js';
import { createEditor } from './editor.js';
import { translateLines } from './translate.js';
import { serializeProject, parseProject } from './project.js';
import { plainText } from './rich.js';

const editor = createEditor(document.getElementById('editorMount'), {
  onChange: () => {
    dirty = true;
  },
});
let dirty = false;
// 当前打开的源文件路径（用于保存项目时写进 meta；浏览器环境下仅保留文件名）
let currentSourcePath = '';

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

// 状态栏右侧统计：字幕总行数
function updateStats() {
  const items = editor.getItems() || [];
  statsEl.textContent = `共 ${items.length} 条`;
}

async function loadText(text) {
  const { items, bilingual } = parseSRT(text);
  editor.setItems(items);
  updateStats();
  dirty = false;
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
  if (f.name.toLowerCase().endsWith('.gsub')) {
    openProjectFromText(text, f.name);
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
          filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'txt'] }],
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

// 用项目文本载入编辑器（被「打开项目」按钮与 .gsub 文件拖入/选择复用）
function openProjectFromText(text, name) {
  try {
    const { items, meta } = parseProject(text);
    if (!items.length) {
      setStatus('项目文件为空，没有可载入的字幕');
      return;
    }
    editor.setItems(items);
    updateStats();
    dirty = false;
    if (meta.sourcePath) currentSourcePath = meta.sourcePath;
    setStatus(`已打开项目：${name}（${items.length} 条）`);
  } catch (e) {
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
        openProjectFromText(r.text, r.path);
      })().catch((e) => setStatus('打开项目失败：' + (e?.message || e)));
    } catch (e) {
      setStatus('打开项目失败：' + (e?.message || e));
    }
  } else {
    $('fileInput').click(); // 浏览器回退：change 内按扩展名路由到项目解析
  }
}

// 保存项目：把当前所有字幕（时间码/原文/译文）与元数据写成 .gsub（XML）
async function saveProject() {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可保存的内容');
    return;
  }
  const hasTarget = items.some((it) => (it.target || '').trim().length);
  const xml = serializeProject(items, {
    sourcePath: currentSourcePath,
    bilingual: hasTarget,
    created: new Date().toISOString(),
  });

  if (isTauri()) {
    try {
      const path = await window.__TAURI__.dialog.save({
        defaultPath: PROJECT_DEFAULT_NAME,
        filters: [{ name: '字幕项目', extensions: ['gsub'] }],
      });
      if (!path) return;
      await window.__TAURI__.core.invoke('write_file', { path, contents: xml });
      setStatus(`项目已保存到：${path}`);
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      const path = await window.pywebview.api.save_project(PROJECT_DEFAULT_NAME, xml);
      if (!path) return;
      setStatus(`项目已保存到：${path}`);
    } catch (e) {
      setStatus('保存项目失败：' + (e?.message || e));
    }
  } else {
    download(PROJECT_DEFAULT_NAME, xml);
    setStatus('已导出项目文件 .gsub');
  }
}

$('saveProject').addEventListener('click', saveProject);

// 交换左右：把每一条的原文(source)与译文(target)原地互换（不重建 DOM，视图必刷新）
$('swapSides').addEventListener('click', () => {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可交换的内容');
    return;
  }
  editor.swapSides();
  dirty = true;
  setStatus('已交换左右内容（原文 ↔ 译文）');
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

// 替换当前命中（逐处替换）
function replaceCurrent() {
  const n = findState.matches.length;
  if (!n) {
    setStatus('没有可替换的内容');
    return;
  }
  const m = findState.matches[findState.idx];
  const items = editor.getItems();
  const it = items[m.itemIndex];
  const text = plainText(it[m.side] || '');
  const repl = findReplace.value;
  it[m.side] = text.slice(0, m.start) + repl + text.slice(m.end);
  dirty = true;
  editor.setItems(items); // 刷新左右两栏
  runSearch(false); // 重新扫描，idx 保持当前位置
}

// 全部替换（两边、所有命中）
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
  const items = editor.getItems();
  let count = 0;
  const repl = findReplace.value;
  items.forEach((it) => {
    ['source', 'target'].forEach((side) => {
      const text = plainText(it[side] || '');
      if (!text) return;
      it[side] = text.replace(re, () => {
        count++;
        return repl;
      });
    });
  });
  dirty = true;
  editor.setItems(items);
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

// 翻译
async function doTranslate(scope) {
  const provider = $('provider').value;
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
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
        setStatus('请先点选一行再翻译选中行。');
        return;
      }
      setStatus(`正在翻译第 ${ai + 1} 行…`);
      const [t] = await translateLines([plainText(items[ai].source)], { provider, apiKey, model }, setStatus);
      items[ai].target = t;
      editor.applyTargets();
      setStatus(`已翻译第 ${ai + 1} 行`);
    } else {
      setStatus(`正在翻译全部 ${items.length} 条…`);
      const translations = await translateLines(
        items.map((it) => plainText(it.source)),
        { provider, apiKey, model },
        setStatus
      );
      translations.forEach((t, i) => (items[i].target = t));
      editor.applyTargets();
      setStatus(`已翻译全部 ${items.length} 条（${provider}）`);
    }
  } catch (e) {
    // 错误已在 translateLines 内通过 onStatus 提示
  }
}

$('translateAll').addEventListener('click', () => doTranslate('all'));
$('translateSelected').addEventListener('click', () => doTranslate('selected'));

// --------------------------------------------------------------------------
// 程序配置：窗口大小 / 表格间距 / 文件打开位置 / 翻译引擎 由 Python 端读写 config.json
// --------------------------------------------------------------------------
let cellPad = 4;

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
    if (typeof cfg?.table?.cell_padding === 'number') {
      applyCellPadding(cfg.table.cell_padding);
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

// 翻译引擎变更时记录
$('provider').addEventListener('change', () => {
  saveConfig({ provider: $('provider').value });
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
    else openProject();
  });
});

// 点击页面其它位置关闭下拉菜单
document.addEventListener('click', (e) => {
  if (!openDropdown.contains(e.target)) openMenu.hidden = true;
});

// 首次自动加载示例，便于立即预览
window.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  $('loadSample').click();
});
