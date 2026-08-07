// src/app.js
import { parseSRT, serializeSRT } from './srt.js';
import { createEditor } from './editor.js';
import { translateLines } from './translate.js';

const editor = createEditor(document.getElementById('editorMount'), {
  onChange: () => {
    dirty = true;
  },
});
let dirty = false;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

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

async function loadText(text) {
  const { items, bilingual } = parseSRT(text);
  editor.setItems(items);
  dirty = false;
  return { count: items.length, bilingual };
}

// 加载内置示例
$('loadSample').addEventListener('click', async () => {
  const res = await fetch('sample.srt');
  const r = await loadText(await res.text());
  setStatus(`已加载示例 ${r.count} 条${r.bilingual ? '（已识别双语，分列两侧）' : ''}`);
});

// 上传本地字幕文件（浏览器回退）
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = await loadText(await f.text());
  setStatus(`已加载文件：${f.name}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
});

// 打开文件：Tauri 用原生对话框 + Rust 读取；pywebview 用 Python 原生对话框；
// 浏览器用隐藏 fileInput 回退
$('openFile').addEventListener('click', async () => {
  if (isTauri()) {
    try {
      const path = await window.__TAURI__.dialog.open({
        multiple: false,
        filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'txt'] }],
      });
      if (!path) return;
      const text = await window.__TAURI__.core.invoke('read_file', { path });
      const r = await loadText(text);
      setStatus(`已打开：${path}（${r.count} 条${r.bilingual ? ' · 双语' : ''}）`);
    } catch (e) {
      setStatus('打开失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      const r = await window.pywebview.api.open_file();
      if (!r) return;
      const info = await loadText(r.text);
      setStatus(`已打开：${r.path}（${info.count} 条${info.bilingual ? ' · 双语' : ''}）`);
    } catch (e) {
      setStatus('打开失败：' + (e?.message || e));
    }
  } else {
    $('fileInput').click();
  }
});

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

// 导出：Tauri/pywebview 用原生「另存为」对话框 + 本地写入；浏览器用 Blob 下载
async function doExport(mode, defaultName, okMsg) {
  const text = serializeSRT(editor.getItems(), { mode });
  if (isTauri()) {
    try {
      const path = await window.__TAURI__.dialog.save({
        defaultPath: defaultName,
        filters: [{ name: 'SubRip 字幕', extensions: ['srt'] }],
      });
      if (!path) return;
      await window.__TAURI__.core.invoke('write_file', { path, contents: text });
      setStatus(`已保存到：${path}`);
    } catch (e) {
      setStatus('保存失败：' + (e?.message || e));
    }
  } else if (isPyWebView()) {
    try {
      const path = await window.pywebview.api.save_as(defaultName, text);
      if (!path) return;
      setStatus(`已保存到：${path}`);
    } catch (e) {
      setStatus('保存失败：' + (e?.message || e));
    }
  } else {
    download(defaultName, text);
    setStatus(okMsg);
  }
}

$('exportTranslate').addEventListener('click', () =>
  doExport('translate', 'subtitle_translated.srt', '已导出翻译版 SRT')
);

$('exportBilingual').addEventListener('click', () =>
  doExport('bilingual', 'subtitle_bilingual.srt', '已导出双语 SRT')
);

// 交换左右：把每一条的原文(source)与译文(target)互换后重渲染
$('swapSides').addEventListener('click', () => {
  const items = editor.getItems();
  if (!items.length) {
    setStatus('没有可交换的内容');
    return;
  }
  items.forEach((it) => {
    const t = it.source;
    it.source = it.target;
    it.target = t;
  });
  editor.setItems(items);
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
      const text = it[side] || '';
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

  const full = editor.getItems()[m.itemIndex][m.side] || '';
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
  const text = it[m.side] || '';
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
      const text = it[side] || '';
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
  const r = await loadText(await f.text());
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
      const [t] = await translateLines([items[ai].source], { provider, apiKey, model }, setStatus);
      items[ai].target = t;
      editor.applyTargets();
      setStatus(`已翻译第 ${ai + 1} 行`);
    } else {
      setStatus(`正在翻译全部 ${items.length} 条…`);
      const translations = await translateLines(
        items.map((it) => it.source),
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

// 首次自动加载示例，便于立即预览
window.addEventListener('DOMContentLoaded', () => {
  $('loadSample').click();
});
