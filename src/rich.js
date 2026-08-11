// src/rich.js
// 把 SRT / 字幕里的行内标记转换为安全的富文本 HTML。
// 只保留粗体 <b> 和斜体 <i> 标记（应用对应字体样式）；
// 字体大小 / 颜色 / 字体 / 下划线等其余标记一律忽略并剔除（不显示标签本身）。
// 同时提供 plainText() 用于翻译、查找预览等「只看文字」的场景。
// 此外提供 replaceRich()：标签感知的查找替换——只替换可见文字，
// 保留 <b>/<i>/<u>/<br> 等标签与格式，仅在某个容器标签内部文字被替换成空时才清掉该标签。

// 匹配任意标签（无论是否已知），统一抽出来处理
const TAG_RE = /<\/?[^>]+>/g;

// 占位符分隔符（私有区字符，正常文本里不会出现，且不会被下面的 HTML 转义影响）
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

// 单个标记 -> 安全 HTML。只有 b / i 保留，其余（font / u 等）直接剔除。
function convertTag(tag) {
  const t = tag.toLowerCase();
  if (t === '<b>' || t === '<b/>') return '<b>';
  if (t === '</b>') return '</b>';
  if (t === '<i>' || t === '<i/>') return '<i>';
  if (t === '</i>') return '</i>';
  return '';
}

/**
 * 把含字幕标记的原始文本转为可安全显示的富文本 HTML。
 * - 已知标记（b / i）被转换为对应 HTML，应用粗体 / 斜体，不显示标签本身；
 * - 其余标记（font / u 等）直接剔除，不显示标签、不套用样式；
 * - 其它所有字符统一做 HTML 转义，杜绝 XSS / 标签注入；
 * - 换行转为 <br>，便于在单元格里保留多行。
 */
export function renderRich(raw) {
  if (!raw) return '';
  const tokens = [];
  // 1) 先把所有标签抽成占位符，避免被后面的转义破坏
  let s = String(raw).replace(TAG_RE, (m) => {
    const tok = OPEN + tokens.length + CLOSE;
    tokens.push(m);
    return tok;
  });
  // 2) 转义其余所有内容
  s = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // 3) 换行 -> <br>
  s = s.replace(/\r?\n/g, '<br>');
  // 4) 还原标记（按原顺序，保留嵌套；未知标记被剔除）
  s = s.replace(
    new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'),
    (_, n) => convertTag(tokens[+n])
  );
  return s;
}

/**
 * 从富文本 / 字幕标记文本里抽取纯文字（去掉所有标签），用于翻译、查找、替换。
 * 行内 <br> 先还原成换行，避免跨行文字被接成一行。
 * 注意：这里会把实体（&amp; 等）解码为可见字符，使查找内容与界面显示一致。
 */
export function plainText(html) {
  return analyze(html).plain;
}

// ---------------------------------------------------------------------------
// 标签感知的替换所需的基础设施
// ---------------------------------------------------------------------------

// 把文本中的 XML/HTML 实体解码为可见字符（与渲染时相反）。
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return '';
  }
}

// 把可见文字重新转义为安全的 HTML 文本（防 XSS / 标签注入）。
function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把单元格 HTML 拆成 token 序列：
//  - {type:'text', raw}            文本片段（含实体，未解码）
//  - {type:'tag', raw, name, closing, void}   标签；void 表示自闭合/换行类（<br> 等）
function tokenize(html) {
  const tokens = [];
  const re = /<[^>]+>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', raw: html.slice(last, m.index) });
    const raw = m[0];
    const tagMatch = raw.match(/^<\s*(\/?)\s*([a-zA-Z0-9]+)/);
    const closing = !!(tagMatch && tagMatch[1] === '/');
    const name = (tagMatch ? tagMatch[2] : '').toLowerCase();
    const isVoid = name === 'br' || name === 'hr' || /\/\s*>$/.test(raw);
    tokens.push({ type: 'tag', raw, name, closing, void: isVoid });
    last = m.index + raw.length;
  }
  if (last < html.length) tokens.push({ type: 'text', raw: html.slice(last) });
  return tokens;
}

// 分析单元格 HTML：产出可见纯文本 plain（<br> -> 换行），
// 以及每个 token 在 plain 中所占的 [plainStart, plainEnd) 区间。
// 容器标签（<b>/<i>/<u> 等）不贡献文字；void 标签（<br>）贡献一个换行。
function analyze(html) {
  const tokens = tokenize(html);
  let plain = '';
  const ranges = [];
  tokens.forEach((tok) => {
    if (tok.type === 'text') {
      const dec = decodeEntities(tok.raw);
      ranges.push({ plainStart: plain.length, plainEnd: plain.length + dec.length });
      plain += dec;
    } else if (tok.void) {
      ranges.push({ plainStart: plain.length, plainEnd: plain.length + 1 });
      plain += '\n';
    } else {
      ranges.push({ plainStart: plain.length, plainEnd: plain.length });
    }
  });
  return { tokens, plain, ranges };
}

// 按 JS String.replace 的语义展开替换模板里的 $& / $1 / $` / $' / $<name> / $$。
function evalTemplate(template, m, plain) {
  return String(template).replace(/\$(\$|&|`|'|\d+|<\w+>)/g, (full, g1) => {
    if (g1 === '$') return '$';
    if (g1 === '&') return m[0];
    if (g1 === '`') return plain.slice(0, m.index);
    if (g1 === "'") return plain.slice(m.index + m[0].length);
    if (/^\d+$/.test(g1)) {
      const n = parseInt(g1, 10);
      return m[n] !== undefined ? m[n] : '';
    }
    if (/^<(\w+)>$/.test(g1)) {
      const name = g1.slice(1, -1);
      return m.groups && m.groups[name] !== undefined ? m.groups[name] : '';
    }
    return full;
  });
}

// 把 plain 坐标 x 映射到 newPlain 坐标：
//  - 落在某个命中区间 [c.start, c.end] 内时，整体平移到该区间起点对应的位置；
//  - 否则按「此前所有命中的长度差」平移。
function makeNewPos(chosen) {
  return function newPos(x) {
    for (const c of chosen) {
      // 注意：命中区间的右端点 x === c.end 视为「命中之后」，落到替换串末尾之后；
      // 只有 x < c.end 才落在替换串内部，从而避免整段被命中时丢掉替换串尾部。
      if (x >= c.start && x < c.end) return x + c.deltaBeforeStart;
    }
    let d = 0;
    for (const c of chosen) if (c.start < x) d += c.delta;
    return x + d;
  };
}

// 递归清掉内部文字为空的容器标签（<b></b> 之类），嵌套的也一并清。
function cleanupEmptyTags(html) {
  let cur = html;
  let guard = 0;
  while (guard++ < 30) {
    const tokens = tokenize(cur);
    const openStack = [];
    const toRemove = new Set();
    tokens.forEach((tok, i) => {
      if (tok.type === 'tag' && !tok.void && !tok.closing) {
        openStack.push(i);
      } else if (tok.type === 'tag' && !tok.void && tok.closing) {
        let openIdx = -1;
        for (let k = openStack.length - 1; k >= 0; k--) {
          if (tokens[openStack[k]].name === tok.name) {
            openIdx = openStack[k];
            openStack.splice(k, 1);
            break;
          }
        }
        if (openIdx >= 0) {
          let innerLen = 0;
          for (let j = openIdx + 1; j < i; j++) {
            if (tokens[j].type === 'text') innerLen += decodeEntities(tokens[j].raw).length;
          }
          if (innerLen === 0) {
            toRemove.add(openIdx);
            toRemove.add(i);
          }
        }
      }
    });
    if (toRemove.size === 0) break;
    cur = tokens.filter((_, i) => !toRemove.has(i)).map((t) => t.raw).join('');
  }
  return cur;
}

/**
 * 标签感知的查找替换。
 * @param {string} html   单元格当前 HTML（显示用，含 <b>/<i>/<u>/<br>）
 * @param {RegExp} re     已构建好的匹配正则（global 标志会被忽略，内部按全局处理）
 * @param {string} template 替换模板（支持 $&/$1/$`/$'/$<name>/$$）
 * @param {{start:number,end:number}} [onlyRange] 仅替换 plain 坐标下该区间的命中（用于「替换当前一处」）
 * @returns {{html:string, count:number}} 替换后的 HTML 与命中（被替换）数
 */
export function replaceRich(html, re, template, onlyRange) {
  if (!html) return { html: '', count: 0 };
  const { tokens, plain, ranges } = analyze(html);
  const flags = (re.flags.includes('i') ? 'i' : '') + (re.flags.includes('m') ? 'm' : '') + 'g';
  const gre = new RegExp(re.source, flags);

  const found = [];
  let mm;
  gre.lastIndex = 0;
  while ((mm = gre.exec(plain)) !== null) {
    if (mm[0].length === 0) {
      gre.lastIndex++;
      continue;
    }
    found.push({ start: mm.index, end: mm.index + mm[0].length, match: mm });
    if (onlyRange && found.length) break; // 单处替换只需定位到目标命中
  }

  let chosen = found;
  if (onlyRange) {
    chosen = found.filter((c) => c.start === onlyRange.start && c.end === onlyRange.end);
  }
  if (chosen.length === 0) return { html, count: 0 };

  // 预算每个命中的替换串与长度差
  chosen.forEach((c) => {
    c.rep = evalTemplate(template, c.match, plain);
    c.repLen = c.rep.length;
    c.delta = c.repLen - (c.end - c.start);
  });
  // 每个命中起点之前累计的长度差（用于坐标平移）
  chosen.forEach((c) => {
    let d = 0;
    for (const o of chosen) if (o.start < c.start) d += o.delta;
    c.deltaBeforeStart = d;
  });

  // 构造替换后的纯文本 newPlain
  let newPlain = '';
  let pos = 0;
  chosen.forEach((c) => {
    newPlain += plain.slice(pos, c.start);
    newPlain += c.rep;
    pos = c.end;
  });
  newPlain += plain.slice(pos);

  const newPos = makeNewPos(chosen);

  // 逐 token 还原 HTML：标签原样保留，文本片段取 newPlain 中对应区间并重新转义
  let out = '';
  tokens.forEach((tok, ti) => {
    if (tok.type === 'text') {
      const r = ranges[ti];
      const a = newPos(r.plainStart);
      const b = newPos(r.plainEnd);
      out += escapeHtmlText(newPlain.slice(a, b));
    } else {
      // 标签（含 <br>）原样保留，不改动
      out += tok.raw;
    }
  });

  return { html: cleanupEmptyTags(out), count: chosen.length };
}

/**
 * 按纯文本偏移量 plainOff 把一个单元格的 HTML 拆成 left / right 两半。
 * - 文本片段按解码后的长度在 plainOff 处切开（跨拆点的文本一分为二）；
 * - <br> 等 void 标签按 1 个换行计入偏移；b/i/u 等容器标签长度为 0；
 * - 用「打开标签栈」记录每个容器的归属侧：打开标签按自身位置归入左/右，
 *   闭合标签与其匹配的打开标签同侧；跨拆点的容器会在 left 末尾补闭合、
 *   在 right 开头补打开，保证两侧 HTML 都闭合、格式连续。
 * 用于「编辑时按 Enter 在光标处把当前字幕拆成两条」。
 */
export function splitHtml(html, plainOff) {
  const tokens = tokenize(html);
  let leftPos = 0;
  let left = '';
  let right = '';
  const stack = []; // { name, side, split }
  for (const tok of tokens) {
    if (tok.type === 'text') {
      const dec = decodeEntities(tok.raw);
      const start = leftPos;
      const end = leftPos + dec.length;
      if (end <= plainOff) {
        left += tok.raw;
        leftPos = end;
      } else if (start >= plainOff) {
        right += tok.raw;
      } else {
        // 文本片段被拆点切开：前半留 left，后半进 right
        const take = plainOff - start;
        left += escapeHtmlText(dec.slice(0, take));
        right += escapeHtmlText(dec.slice(take));
        leftPos = plainOff;
        // 跨拆点的容器：left 末尾补闭合、right 开头补打开，并标记这些打开项为「已拆分」
        for (let k = stack.length - 1; k >= 0; k--) {
          stack[k].split = true;
          left += '</' + stack[k].name + '>';
          right = '<' + stack[k].name + '>' + right;
        }
      }
    } else if (tok.void) {
      if (leftPos < plainOff) { left += tok.raw; leftPos += 1; }
      else { right += tok.raw; }
    } else if (!tok.closing) {
      const side = leftPos < plainOff ? 'left' : 'right';
      if (side === 'left') left += tok.raw; else right += tok.raw;
      stack.push({ name: tok.name, side, split: false });
    } else {
      // 闭合标签：与栈顶同名打开标签同侧；若该打开标签处于跨拆点状态则跳过（平衡已由拆点处理）
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === tok.name) { idx = k; break; }
      }
      if (idx >= 0) {
        const entry = stack[idx];
        if (!entry.split) {
          if (entry.side === 'left') left += tok.raw; else right += tok.raw;
        } else {
          // 跨拆点容器的闭合标签归入 right，闭合右侧被重新打开的容器（左侧已由拆点补闭合）
          right += tok.raw;
        }
        stack.splice(idx, 1);
      }
      // 找不到匹配（异常 HTML）时忽略该闭合标签
    }
  }
  return { left, right };
}

/**
 * 去掉 HTML 一侧/两侧的纯文本空白（保留 <b>/<i>/<u>/<br> 标签与格式）。
 * 仅裁 text 节点里的首尾空白字符；标签原样保留（开头的 <br> 视作空白一并清除）。
 * 用于「拆行」后去掉左半末尾、右半开头的多余空格，避免新/旧行前后留空。
 * @param {string} html
 * @param {{left?:boolean, right?:boolean}} [opt] left=去开头、right=去末尾，默认两者都做
 * @returns {string}
 */
export function trimHtml(html, opt = {}) {
  if (!html) return '';
  const doLeft = opt.left !== false; // 默认去开头
  const doRight = opt.right !== false; // 默认去末尾
  const tokens = tokenize(html);
  const isBlank = (tok) =>
    tok.type === 'text' && decodeEntities(tok.raw).trim() === '';
  // 去开头空白
  let cur = tokens;
  if (doLeft) {
    let trimming = true;
    const kept = [];
    for (const tok of cur) {
      if (!trimming) { kept.push(tok); continue; }
      if (tok.type === 'text') {
        if (isBlank(tok)) continue; // 整段空白，丢弃
        tok.raw = tok.raw.replace(/^\s+/, ''); // 裁前导空白
        trimming = false;
        kept.push(tok);
      } else if (tok.void) {
        continue; // 开头的 <br> 视作空白，丢弃
      } else {
        kept.push(tok); // 标签（open/close）保留并继续寻找首个文本
      }
    }
    cur = kept;
  }
  // 去末尾空白
  if (doRight) {
    let trimming = true;
    const kept = [];
    for (let i = cur.length - 1; i >= 0; i--) {
      const tok = cur[i];
      if (!trimming) { kept.unshift(tok); continue; }
      if (tok.type === 'text') {
        if (isBlank(tok)) continue;
        tok.raw = tok.raw.replace(/\s+$/, ''); // 裁尾随空白
        trimming = false;
        kept.unshift(tok);
      } else if (tok.void) {
        continue;
      } else {
        kept.unshift(tok);
      }
    }
    cur = kept;
  }
  return cur.map((t) => t.raw).join('');
}

