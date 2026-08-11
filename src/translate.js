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

// 全文翻译：把整篇原文（含换行）作为一次请求发给引擎，保证全文人名/地名一致。
// 返回的是整篇译文（字符串），前端再按换行切回每行并格式化。
export async function translateDocument(text, opts = {}, onStatus) {
  const { provider = 'mock', apiKey = '', model = '' } = opts;

  if (provider === 'manual') {
    onStatus && onStatus('手动模式：请在右侧直接输入翻译。');
    return text;
  }

  if (provider === 'mock') {
    onStatus && onStatus('演示翻译（mock）：请配置 API key 接入真实翻译。');
    // 回显原文，便于演示「按换行切行 + 格式化」的整条管线
    return text;
  }

  if (isTauri()) {
    onStatus && onStatus(`正在通过 ${provider} 全文翻译…`);
    try {
      const translations = await window.__TAURI__.core.invoke('translate', {
        lines: [text],
        whole: true,
        provider,
        apiKey,
        model,
        source: SOURCE_LANG,
        target: TARGET_LANG,
      });
      return Array.isArray(translations) ? translations[0] || '' : translations || '';
    } catch (e) {
      const msg = typeof e === 'string' ? e : e && e.message ? e.message : String(e);
      onStatus && onStatus(`翻译失败：${msg}`);
      throw e;
    }
  }

  if (isPyWebView()) {
    onStatus && onStatus(`正在通过 ${provider} 全文翻译…`);
    try {
      const translations = await window.pywebview.api.translate({
        lines: [text],
        whole: true,
        provider,
        apiKey,
        model,
        source: SOURCE_LANG,
        target: TARGET_LANG,
      });
      if (translations && translations.error) {
        throw new Error(translations.error);
      }
      return Array.isArray(translations) ? translations[0] || '' : translations || '';
    } catch (e) {
      const msg = typeof e === 'string' ? e : e && e.message ? e.message : String(e);
      onStatus && onStatus(`翻译失败：${msg}`);
      throw e;
    }
  }

  const endpoint =
    (typeof window !== 'undefined' && window.__TRANSLATE_ENDPOINT__) || DEFAULT_ENDPOINT;
  onStatus && onStatus(`正在通过 ${provider} 全文翻译…`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [text], whole: true, provider, apiKey, model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `代理返回 ${res.status}`);
    }
    const data = await res.json();
    const t = data.translations;
    return Array.isArray(t) ? t[0] || '' : t || '';
  } catch (e) {
    onStatus &&
      onStatus(`翻译失败：${e.message}（确认 server/translate-proxy.mjs 已启动）`);
    throw e;
  }
}

// 把译文切分结果对齐到原文的条数：
// - 段数不足：用空串补齐；
// - 段数过多：保留前 n-1 段，其余合并进最后一段（避免丢内容）。
export function alignSegments(segs, n) {
  const out = (segs || []).slice();
  if (out.length > n) {
    const extra = out.splice(n - 1);
    out[n - 1] = extra.join(' ');
  }
  while (out.length < n) out.push('');
  return out;
}

// 译文格式化（与翻译引擎无关，对所有来源的输出统一后处理）：
// 1) 书名/电影名等：已有的《》转为中文双引号 “”；
// 2) 英文人名：两个首字母大写的拉丁词之间加 ·（如 Tom Hanks → Tom·Hanks）；
// 3) 中文：去掉标点符号，句子/从句之间用空格分隔（保留 · 与 “”）。
export function normalizeTranslationLine(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/《([^》]*)》/g, '“$1”'); // 书名/电影名 → 中文双引号
  t = t.replace(/([A-Z][a-z]+)\s+([A-Z][a-z]+)/g, '$1·$2'); // 英文人名加 ·
  // 去掉绝大多数标点（保留 “” 与 ·），空白（含换行）一并归为空格
  t = t.replace(/[，。！？；：、,.!?;:'『』「」()（）\[\]【】—–…\s]+/g, ' ');
  // 清理引号两侧多余的空格，保持 “书名” 紧贴文字
  t = t.replace(/\s*“\s*/g, '“').replace(/\s*”\s*/g, '”');
  t = t.trim().replace(/\s{2,}/g, ' ');
  return t;
}
