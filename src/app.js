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

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function loadText(text) {
  const items = parseSRT(text);
  editor.setItems(items);
  dirty = false;
  setStatus(`已加载 ${items.length} 条字幕`);
}

// 加载内置示例
$('loadSample').addEventListener('click', async () => {
  const res = await fetch('sample.srt');
  loadText(await res.text());
});

// 上传本地字幕文件
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  loadText(await f.text());
  setStatus(`已加载文件：${f.name}（${editor.getItems().length} 条）`);
});

// 下载导出
function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$('exportTranslate').addEventListener('click', () => {
  download('subtitle_translated.srt', serializeSRT(editor.getItems(), { mode: 'translate' }));
  setStatus('已导出翻译版 SRT');
});

$('exportBilingual').addEventListener('click', () => {
  download('subtitle_bilingual.srt', serializeSRT(editor.getItems(), { mode: 'bilingual' }));
  setStatus('已导出双语 SRT');
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
