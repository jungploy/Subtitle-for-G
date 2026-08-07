// src/translate.js
// 翻译抽象层：manual / mock / openai / deepl
//
// Web 版经本地代理 server/translate-proxy.mjs 转发，
// 避免 API key 暴露在浏览器、规避 CORS。
// 桌面版（Tauri）可改为调用 window.__TAURI__.invoke('translate', ...)（见文件底部注释）。

const DEFAULT_ENDPOINT = 'http://localhost:8787/api/translate';

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

  // 真实翻译：走本地代理
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

/*
 * 桌面版（Tauri）接入示例 —— 在 src-tauri 的权限中开放「translate」命令后使用：
 *
 * export async function translateLines(lines, opts = {}, onStatus) {
 *   const { provider = 'mock', apiKey = '', model = '' } = opts;
 *   if (provider === 'manual' || provider === 'mock') {
 *     if (provider === 'manual') { onStatus && onStatus('手动模式'); return lines.slice(); }
 *     onStatus && onStatus('演示翻译（mock）');
 *     return lines.map((l) => (l ? `[译] ${l}` : ''));
 *   }
 *   onStatus && onStatus(`正在通过 ${provider} 翻译…`);
 *   const translations = await window.__TAURI__.invoke('translate', {
 *     lines, provider, apiKey, model,
 *   });
 *   return translations;
 * }
 */
