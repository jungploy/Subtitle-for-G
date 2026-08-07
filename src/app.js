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

// 拖拽文件到窗口即可打开（浏览器与 Tauri 通用：file.text() 读取内容）
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
