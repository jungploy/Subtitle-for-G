// src/translate.js
// 翻译抽象层：manual / mock / 真实(my memory / openai / deepl)
//
// - 浏览器 / Web 预览：走本地代理 server/translate-proxy.mjs（key 不进前端、规避 CORS）
// - 桌面端（Tauri 原生窗口）：检测到 window.__TAURI__ 时改为 invoke('translate')，
//   翻译在 Rust 本地进程完成，同样不暴露 key、无 CORS。
// - 桌面端（Python pywebview 壳）：检测到 window.pywebview.api 时改为调用
//   window.pywebview.api.translate(...)，翻译在 Python 本地进程完成，同样不暴露 key。

const DEFAULT_ENDPOINT = 'http://localhost:8787/api/translate';
const SOURCE_LANG = 'en';
const TARGET_LANG = 'zh-CN';

function isTauri() {
  return typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core;
}

function isPyWebView() {
  return typeof window !== 'undefined' && window.pywebview && window.pywebview.api;
}

export async function translateLines(lines, opts = {}, onStatus) {
  const { provider = 'mock', apiKey = '', model = '' } = opts;

  if (provider === 'manual') {
    onStatus && onStatus('手动模式：请在右侧直接输入翻译。');
    return lines.slice();
  }

  if (provider === 'mock') {
    onStatus && onStatus('演示翻译（mock）：请配置 API key 接入真实翻译。');
    return lines.map((l) => (l ? `[译] ${l}` : ''));
  }

  // 桌面端（Tauri）：交给 Rust 本地进程翻译，无需代理、无需 endpoint
  if (isTauri()) {
    onStatus && onStatus(`正在通过 ${provider} 翻译 ${lines.length} 条…`);
    try {
      const translations = await window.__TAURI__.core.invoke('translate', {
        lines,
        provider,
        apiKey,
        model,
        source: SOURCE_LANG,
        target: TARGET_LANG,
      });
      return translations;
    } catch (e) {
      const msg = typeof e === 'string' ? e : e && e.message ? e.message : String(e);
      onStatus && onStatus(`翻译失败：${msg}`);
      throw e;
    }
  }

  // 桌面端（Python pywebview 壳）：交给 Python 本地进程翻译
  if (isPyWebView()) {
    onStatus && onStatus(`正在通过 ${provider} 翻译 ${lines.length} 条…`);
    try {
      const translations = await window.pywebview.api.translate({
        lines,
        provider,
        apiKey,
        model,
        source: SOURCE_LANG,
        target: TARGET_LANG,
      });
      if (translations && translations.error) {
        throw new Error(translations.error);
      }
      return translations;
    } catch (e) {
      const msg = typeof e === 'string' ? e : e && e.message ? e.message : String(e);
      onStatus && onStatus(`翻译失败：${msg}`);
      throw e;
    }
  }

  // Web 版：走本地代理
  const endpoint =
    (typeof window !== 'undefined' && window.__TRANSLATE_ENDPOINT__) || DEFAULT_ENDPOINT;
  onStatus && onStatus(`正在通过 ${provider} 翻译 ${lines.length} 条…`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines, provider, apiKey, model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `代理返回 ${res.status}`);
    }
    const data = await res.json();
    return data.translations;
  } catch (e) {
    onStatus &&
      onStatus(`翻译失败：${e.message}（确认 server/translate-proxy.mjs 已启动）`);
    throw e;
  }
}
