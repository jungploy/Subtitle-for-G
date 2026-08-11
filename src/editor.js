// src/editor.js
// 表格方式的双语字幕编辑器：序号 / 起始时码 / 结束时码 / 时长 / 原文 / 译文
// 每行同一 <tr>，天然等高；原文/译文文本框自动撑高。
// 原文/译文单元格均为富文本（contentEditable）：模型里存的是「显示用 HTML」
// （保留 <b>/<i>/<u> 与 <br>），编辑时直接读写 innerHTML，加粗/斜体/下划线等
// 格式变化随之落盘、并随 .gsub 项目文件往返。

import { plainText, splitHtml, trimHtml } from './rich.js';

export function createEditor(container, { onChange, onActiveChange, onEditBegin, onEditCommit, onStructuralChange } = {}) {
  container.innerHTML = `
    <div class="editor">
      <div class="table-wrap">
        <table class="sub-table" id="subTable">
          <colgroup>
            <col class="col-index" style="width:56px" />
            <col class="col-start" style="width:108px" />
            <col class="col-end" style="width:108px" />
            <col class="col-duration" style="width:80px" />
            <col class="col-source" style="width:420px" />
            <col class="col-target" style="width:420px" />
          </colgroup>
          <thead>
            <tr>
              <th>序号</th>
              <th>起始时码</th>
              <th>结束时码</th>
              <th>时长</th>
              <th>原文</th>
              <th>译文</th>
            </tr>
          </thead>
          <tbody id="rowsBody"></tbody>
        </table>
      </div>
    </div>`;

  const tbody = container.querySelector('#rowsBody');
  const table = container.querySelector('#subTable');
  const wrap = table.parentElement; // 滚动容器（.table-wrap），用于最小化补滚动
  const cols = table.querySelectorAll('colgroup col');
  let items = [];
  let activeIndex = -1;
  let activeEl = null; // 当前聚焦的富文本单元格（用于字体格式按钮）
  let activeSide = null; // 'source' | 'target'
  let matchEl = null;
  let selected = new Set();   // 当前选中的行（支持 Shift 多选，存行索引集合）
  let anchorIndex = -1;      // 多选锚点：Shift 扩展选区的起点
  let editingEl = null;      // 当前处于编辑态的富文本单元格（双击进入，单击其它行退出）
  let editingSide = null;    // 'source' | 'target'
  let editingIndex = -1;
  let syncSplit = false;     // 断句是否「原文/译文同步拆行」：true=同步，false=只拆当前编辑单元格（默认不勾选）

  // SRT 时间码 -> 毫秒
  function timeToMs(t) {
    const m = String(t).match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return 0;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ms = parseInt(m[4].padEnd(3, '0'), 10);
    return ((hh * 60 + mm) * 60 + ss) * 1000 + ms;
  }

  // 毫秒 -> SRT 时间码
  function msToTime(ms) {
    const total = Math.max(0, Math.floor(ms));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const mills = total % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mills).padStart(3, '0')}`;
  }

  function duration(start, end) {
    const d = timeToMs(end) - timeToMs(start);
    return msToTime(Math.max(0, d));
  }

  function makeCell(cls, content) {
    const td = document.createElement('td');
    td.className = cls;
    if (content !== undefined && content !== null) td.textContent = content;
    return { td };
  }

  // 富文本单元格：用 div 承载「显示用 HTML」，原文与译文均可在单元格里直接编辑。
  // 模型里存的就是 innerHTML（含 <b>/<i>/<u>/<br>），编辑时直接读写，格式变化可落盘。
  function makeRichCell(cls, html, side, i) {
    const td = document.createElement('td');
    td.className = cls;
    const div = document.createElement('div');
    div.className = cls.replace('cell-', '') + '-line';
    div.innerHTML = html || '';
    div.contentEditable = 'false';
    div.spellcheck = false;
    div.dataset.side = side;

    div.addEventListener('input', () => {
      items[i][side] = div.innerHTML;
      autoGrow(div);
      onChange && onChange(items);
    });
    // 聚焦时仅记录当前单元格（供字体格式按钮使用）；不在此触发 onEditBegin，
    // 编辑会话只在「双击进入」或「focusCell / 上下键切换」时开始，避免单击即进入编辑。
    div.addEventListener('focus', () => {
      activeEl = div;
      activeSide = side;
    });
    div.addEventListener('blur', () => {
      if (editingEl === div) exitEdit();
    });
    // 双击原文/译文单元格才进入编辑态；单击整行任意位置都只做「选中」，不进入编辑。
    div.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startEdit(i, side, 'point', { x: e.clientX, y: e.clientY });
    });
    div.addEventListener('keydown', (e) => {
      if (editingEl !== div) return; // 只有正在编辑的这个单元格才响应 Enter / 方向键
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.shiftKey) {
          // Ctrl / Shift + Enter：在当前字幕内插入换行（双行），不产生新字幕行
          e.preventDefault();
          insertLineBreak();
        } else {
          e.preventDefault();
          const plain = plainText(div.innerHTML);
          const off = caretPlainOffset(div);
          const total = plain.replace(/\n+$/, '').length;
          if (off >= total) jumpToNext();
          else splitAtCaret(off);
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const atBottom = e.key === 'ArrowDown';
        if (caretAtEdge(div, atBottom ? 'bottom' : 'top')) {
          const ni = atBottom
            ? Math.min(items.length - 1, i + 1)
            : Math.max(0, i - 1);
          if (ni !== i) {
            e.preventDefault();
            // 跨界到相邻行同侧单元格并继续编辑（光标置于末尾）
            exitEdit();
            focusCell(ni, side, true);
          }
        }
      }
    });
    td.appendChild(div);
    return { td, div };
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function makeRow(i, it) {
    const tr = document.createElement('tr');
    tr.className = 'sub-row';
    tr.dataset.index = i;

    const idxTd = makeCell('cell-index', it.index ?? i + 1);
    const startTd = makeCell('cell-start', it.start || '');
    const endTd = makeCell('cell-end', it.end || '');
    const durTd = makeCell('cell-duration', duration(it.start, it.end));

    const sourceCell = makeRichCell('cell-source', it.source, 'source', i);
    const targetCell = makeRichCell('cell-target', it.target, 'target', i);

    [idxTd, startTd, endTd, durTd, sourceCell, targetCell].forEach((c) =>
      tr.appendChild(c.td || c)
    );

    const sourceEl = sourceCell.div;
    const targetEl = targetCell.div;
    targetEl.dataset.placeholder = '在此输入翻译…';

    tr.addEventListener('mousedown', (e) => {
      // 编辑态下点击别的行：先退出编辑态，再让目标行可被正常选中。
      if (editingEl && editingIndex !== i) exitEdit();
      // 非编辑态：在「文本选区竞争发生之前」就决定行选中——立即 preventDefault
      // 阻止浏览器把 Shift/拖拽单击当成跨单元格文本选区扩展（这正是 WebView2 下
      // 「选不了多行」的根因），并当场 selectRow，使选择稳定可靠。
      // 双击进入编辑不受影响：startEdit 会主动 focus 单元格并重置选区。
      if (!editingEl) {
        e.preventDefault();
        selectRow(i, e.shiftKey, e.ctrlKey || e.metaKey);
      }
    });
    tr.addEventListener('click', (e) => {
      // 非编辑态：行选中已在 mousedown 阶段完成（包括 Ctrl 切换只触发一次）。
      // 这里只清除可能残留的浏览器文本选区，避免 ::selection 高亮盖过行选中背景。
      // 注意：不能在 click 里再 selectRow，否则 Ctrl 切换会被 mousedown+click
      // 双触发而相互抵消（加一次又删一次）。
      if (!editingEl) {
        const s = window.getSelection && window.getSelection();
        if (s && s.removeAllRanges) s.removeAllRanges();
      }
    });

    // 首渲染后让单元格自适应高度
    requestAnimationFrame(() => {
      autoGrow(sourceEl);
      autoGrow(targetEl);
    });

    return tr;
  }

  function render() {
    // DOM 重建前清空编辑态（旧单元格节点即将被销毁）
    editingEl = null;
    editingIndex = -1;
    editingSide = null;
    activeEl = null;
    activeSide = null;
    tbody.innerHTML = '';
    items.forEach((it, i) => tbody.appendChild(makeRow(i, it)));
    highlightSelection();
  }

  // 依据 selected / activeIndex 刷新行的选中态：所有 selected 行加 .selected，
  // 最近一次点击/聚焦的行（activeIndex）额外加 .active 作为强高亮。
  function highlightSelection() {
    tbody.querySelectorAll('tr').forEach((tr) => {
      const i = +tr.dataset.index;
      tr.classList.toggle('selected', selected.has(i));
      tr.classList.toggle('active', i === activeIndex);
    });
  }

  // 把目标行滚动进可视区，但「仅在不完全可见时才滚动」，且不强制居中。
  // 之前是强制滚动到容器正中，点一下就跳一下，体验别扭；现在只补滚动到刚好可见。
  // 用 getBoundingClientRect 计算（与 offsetParent 无关），更稳健。
  function scrollToRow(i) {
    const tr = tbody.children[i];
    if (!tr || !wrap) return;
    const trRect = tr.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const top = trRect.top - wrapRect.top + wrap.scrollTop;
    const bottom = top + trRect.height;
    const margin = 8;
    // 行在视口上方之外 -> 向下滚动到刚好露出（留 margin）
    if (top < wrap.scrollTop + margin) {
      wrap.scrollTop = Math.max(0, top - margin);
    }
    // 行在视口下方之外 -> 向上滚动到刚好露出（留 margin）
    else if (bottom > wrap.scrollTop + wrap.clientHeight - margin) {
      wrap.scrollTop = bottom - wrap.clientHeight + margin;
    }
    // 已在视口内：不动（不再强制居中，避免点击即跳动）
  }

  // 判断光标是否位于单元格可视区域的上边缘 / 下边缘（用于 Up/Down 跨界到上一/下一行）。
  // 多行（含自动换行）单元格内，仅当光标在首行（Up）或末行（Down）时才跨界，
  // 否则保留原生行为在行间移动光标。空单元格视为处于边缘。
  function caretAtEdge(div, dir) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false; // 有选区（非纯光标）时不跨界
    const rect = range.getBoundingClientRect();
    const cellRect = div.getBoundingClientRect();
    if (rect.top === 0 && rect.bottom === 0) return true; // 空文本，视为边缘
    const threshold = 6;
    if (dir === 'top') return rect.top - cellRect.top <= threshold;
    return cellRect.bottom - rect.bottom <= threshold;
  }

  // 进入 / 切换编辑态：把指定行、指定侧单元格设为可编辑并聚焦。
  // caretMode: 'end' | 'start' | 'point'；point 时把光标放到 (x,y)（双击进入用）。
  // 注意：onEditBegin 只在这里触发，保证「一次编辑会话」与历史记录一一对应。
  function startEdit(i, side, caretMode, point) {
    const tr = tbody.children[i];
    if (!tr) return;
    const sel = side === 'source' ? '.source-line' : '.target-line';
    const el = tr.querySelector(sel);
    if (!el) return;
    if (editingEl && editingEl !== el) exitEdit();
    el.contentEditable = 'true';
    editingEl = el;
    editingSide = side;
    editingIndex = i;
    activeEl = el;
    activeSide = side;
    if (document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
    const s = window.getSelection();
    if (caretMode === 'point' && point) {
      placeCaretAtPoint(el, point.x, point.y);
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(caretMode !== 'end'); // 'end' -> 末尾；'start' -> 开头
      s.removeAllRanges();
      s.addRange(range);
    }
    setActive(i);
    onEditBegin && onEditBegin({ index: i, side });
  }

  // 退出编辑态：先把单元格内容同步回模型并提交编辑会话（触发历史记录），
  // 再把单元格设回不可编辑，清空编辑态与字体格式所需的 activeEl。
  // 由 startEdit（切换）、blur（失焦）、行点击（切到别的行）调用。
  function exitEdit() {
    if (!editingEl) return;
    items[editingIndex][editingSide] = editingEl.innerHTML;
    onChange && onChange(items);
    editingEl.contentEditable = 'false';
    editingEl = null;
    editingSide = null;
    editingIndex = -1;
    activeEl = null;
    activeSide = null;
    onEditCommit && onEditCommit();
  }

  // 计算当前光标的「纯文本偏移量」：遍历单元格 DOM，文本节点累加字符数、
  // <br> 计为 1（与 rich.js 的 plainText 中 \n 对应），到达光标所在节点时取偏移量并停止。
  function caretPlainOffset(div) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    const endContainer = range.endContainer;
    const endOffset = range.endOffset;
    let pos = 0;
    let done = false;
    function addNode(node) {
      if (done) return;
      if (node === endContainer) {
        if (node.nodeType === Node.TEXT_NODE) pos += endOffset;
        else {
          for (let k = 0; k < endOffset && k < node.childNodes.length; k++) addNode(node.childNodes[k]);
        }
        done = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) { pos += node.textContent.length; return; }
      if (node.nodeName === 'BR') { pos += 1; return; }
      for (const child of node.childNodes) addNode(child);
    }
    addNode(div);
    return pos;
  }

  // 把光标放到 (x,y) 坐标处（用于双击进入编辑时定位到点击位置）。
  function placeCaretAtPoint(el, x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        range = document.createRange();
        range.setStart(p.offsetNode, p.offset);
        range.collapse(true);
      }
    }
    if (!range) return;
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  // 聚焦到指定行、指定侧的富文本单元格并进入编辑态（上下键切换 / 插入新行后用）。
  function focusCell(i, side, atEnd) {
    startEdit(i, side, atEnd ? 'end' : 'start');
  }

  // 计算「另一侧」在同步拆分时应切断的纯文本偏移：按 n 个换行（= 编辑侧左半里
  // 的换行数）对应的行边界来切，保持双语逐行对齐。n<=0 或另一侧换行不够时，
  // 返回整段长度（另一侧整体留在左半，右半对应列为空）。
  function otherSplitOffset(plain, n) {
    if (n <= 0) return plain.length;
    let count = 0;
    let idx = -1;
    while (count < n) {
      idx = plain.indexOf('\n', idx + 1);
      if (idx === -1) return plain.length;
      count++;
    }
    return idx + 1;
  }

  // Enter 且光标不在文本末尾：把当前单元格从光标处拆成两段。
  // 右半的去向（始终按「下方单元格」决定）：
  //  - 若该单元格正下方的「同列单元格」为空（且存在）→ 直接把右半填进下方单元格，不新建字幕行；
  //  - 若下方单元格已有数据（或当前已是最后一行、没有下方单元格）→ 新建一行承载右半，原有行被下推不丢失。
  // 双语同步（受 syncSplit 开关控制）：
  //  - 开启「同步断句」→ 编辑侧拆分后，另一侧当前行有内容则同步拆分（保持双语逐行对齐）；
  //    复用下方单元格时，只有当下方同列「另一侧」也为空才写入，避免覆盖已有数据。
  //  - 关闭「同步断句」→ 只拆当前编辑的单元格，另一侧保持原样（新行/下方单元格的该列留空）。
  // 字体格式由 splitHtml 跨拆点保留（b/i/u 不丢）；
  // 仅「新建一行」场景才会把时间码按 50/50 平分（复用下方单元格时沿用该行原有时间码）。
  function splitAtCaret(off) {
    const el = editingEl;
    if (!el) return;
    const side = editingSide;
    const i = editingIndex;
    const html = el.innerHTML; // 在 exitEdit 之前读取，避免失焦后选区丢失
    const { left, right } = splitHtml(html, off);
    // 拆分出的右侧若没有任何实质内容，则不拆分（避免产生空行），
    // 直接跳到下一条字幕并进入编辑态。
    if (!plainText(right).trim()) {
      exitEdit();
      const ni = i + 1;
      if (ni >= items.length) selectRow(i, false);
      else startEdit(ni, side, 'end');
      return;
    }
    exitEdit();
    // 拆分前快照必须放在「修改 items」之前捕获，否则撤销无法恢复到拆分前的样子。
    const before = items.map((it) => ({ ...it }));
    const item = items[i];
    const otherSide = side === 'source' ? 'target' : 'source';
    // n：编辑侧左半里的换行数，用于另一侧同步拆分的行边界。
    const n = (plainText(left).match(/\n/g) || []).length;
    // 计算另一侧（双语同步）应切断的纯文本偏移。
    function computeOtherOffset(otherHtml) {
      const oPlain = plainText(otherHtml);
      if (n > 0) return otherSplitOffset(oPlain, n);
      const ePlain = plainText(html);
      const ratio = ePlain.length ? off / ePlain.length : 0;
      return Math.round(oPlain.length * ratio);
    }

    const hasBelow = i + 1 < items.length;
    const below = hasBelow ? items[i + 1] : null;
    const belowSideEmpty = below ? !plainText(below[side] || '').trim() : false;
    const reuseBelow = belowSideEmpty; // 下方单元格存在且为空 → 复用，不新建行

    if (reuseBelow) {
      // —— 复用下方空单元格：不新建字幕行 ——
      // 去掉拆点两侧的衔接空白：旧行（left）去末尾空格、新行（right/下方单元格）去开头空格。
      item[side] = trimHtml(left, { left: false, right: true });
      below[side] = trimHtml(right, { left: true, right: false });
      // 双语同步（best-effort）：仅当开启「同步断句」且下方单元格的「另一侧」也为空时才写入，避免覆盖已有数据。
      const otherHtml = item[otherSide] || '';
      if (syncSplit && otherHtml && (!below[otherSide] || !plainText(below[otherSide]).trim())) {
        const oOff = computeOtherOffset(otherHtml);
        let { left: oLeft, right: oRight } = splitHtml(otherHtml, oOff);
        oLeft = trimHtml(oLeft, { left: false, right: true });
        oRight = trimHtml(oRight, { left: true, right: false });
        if (plainText(oRight).trim()) {
          item[otherSide] = oLeft;
          below[otherSide] = oRight;
        }
      }
      onChange && onChange(items);
      onStructuralChange && onStructuralChange(`拆分 第${i + 1}行 ${side === 'source' ? '原文' : '译文'}（填入下方空单元格）`, before);
      activeIndex = i + 1;
      anchorIndex = i + 1;
      selected = new Set([i + 1]);
      render();
      startEdit(i + 1, side, 'start');
      return;
    }

    // —— 下方单元格有数据（或没有下方行）→ 新建一行 ——
    const newItem = { index: 0, start: '', end: '', source: '', target: '' };
    // 编辑侧：左半留原行（去末尾衔接空格，避免渲染出前导/尾随空白），右半进新行（去开头衔接空格）。
    item[side] = trimHtml(left, { left: false, right: true });
    newItem[side] = trimHtml(right, { left: true, right: false });
    // 另一侧同步拆分（保持双语逐行对齐 / 按光标比例）；被同步侧空白则新行该列留空。
    // 仅在「同步断句」开启时才拆分另一侧；关闭时只拆当前编辑单元格，另一侧不动。
    const otherHtml = item[otherSide] || '';
    if (syncSplit && otherHtml) {
      const oOff = computeOtherOffset(otherHtml);
      let { left: oLeft, right: oRight } = splitHtml(otherHtml, oOff);
      oLeft = trimHtml(oLeft, { left: false, right: true });
      oRight = trimHtml(oRight, { left: true, right: false });
      if (plainText(oRight).trim()) {
        item[otherSide] = oLeft;
        newItem[otherSide] = oRight;
      } else {
        item[otherSide] = otherHtml;
        newItem[otherSide] = '';
      }
    }
    const sMs = timeToMs(item.start);
    const eMs = timeToMs(item.end);
    if (sMs < eMs) {
      const mid = Math.round((sMs + eMs) / 2);
      item.end = msToTime(mid);
      newItem.start = msToTime(mid);
      newItem.end = msToTime(eMs);
    }
    items.splice(i + 1, 0, newItem);
    renumber();
    onChange && onChange(items);
    onStructuralChange && onStructuralChange(`拆分 第${i + 1}行 ${side === 'source' ? '原文' : '译文'}（新建一行）`, before);
    activeIndex = i + 1;
    anchorIndex = i + 1;
    selected = new Set([i + 1]);
    render();
    startEdit(i + 1, side, 'start');
  }

  // Enter 且光标已在文本末尾：直接跳到下一条字幕并进入编辑态。
  function jumpToNext() {
    const el = editingEl;
    if (!el) return;
    const side = editingSide;
    const i = editingIndex;
    exitEdit();
    if (i + 1 >= items.length) { selectRow(i, false); return; }
    startEdit(i + 1, side, 'end');
  }

  // Ctrl / Shift + Enter：在当前字幕单元格内插入换行（<br>），变成双行显示，
  // 但不产生新的字幕行（仍是一条字幕）。
  function insertLineBreak() {
    const el = editingEl;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    const after = document.createRange();
    after.setStartAfter(br);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    items[editingIndex][editingSide] = el.innerHTML;
    onChange && onChange(items);
    autoGrow(el);
  }

  function setActive(i) {
    activeIndex = i;
    highlightSelection();
    scrollToRow(i);
    onActiveChange && onActiveChange(i);
  }

  // 行选择：
  //  - rangeExtend（Shift）= 以 anchorIndex 为起点选到 i 的整段区间（连续多选）。
  //  - toggle（Ctrl / Cmd）= 切换单行的选中态（追加或取消），不影响其它已选行。
  //  - 两者皆否 = 单选 i 并重置锚点。
  // activeIndex 始终指向最近一次点击/聚焦的行（用于插入定位与强高亮）。
  function selectRow(i, rangeExtend, toggle) {
    if (rangeExtend && anchorIndex >= 0) {
      const lo = Math.min(anchorIndex, i);
      const hi = Math.max(anchorIndex, i);
      selected = new Set();
      for (let k = lo; k <= hi; k++) selected.add(k);
    } else if (toggle) {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      anchorIndex = i;
    } else {
      selected = new Set([i]);
      anchorIndex = i;
    }
    activeIndex = i;
    highlightSelection();
    scrollToRow(i);
    onActiveChange && onActiveChange(i);
  }

  function setItems(newItems) {
    items = newItems || [];
    activeIndex = -1;
    anchorIndex = -1;
    selected = new Set();
    render();
  }

  // 批量载入（文件导入用）：与 setItems 行为一致，但分块追加 DOM 行并让出主线程，
  // 通过 onProgress(done, total) 回报进度，避免大文件（上千条）一次性建表导致界面卡死。
  async function setItemsAsync(newItems, onProgress) {
    items = newItems || [];
    editingEl = null;
    editingIndex = -1;
    editingSide = null;
    activeEl = null;
    activeSide = null;
    activeIndex = -1;
    anchorIndex = -1;
    selected = new Set();
    tbody.innerHTML = '';
    const total = items.length;
    const CHUNK = 80;
    for (let i = 0; i < total; i += CHUNK) {
      const end = Math.min(i + CHUNK, total);
      for (let j = i; j < end; j++) tbody.appendChild(makeRow(j, items[j]));
      if (onProgress) onProgress(end, total);
      // 让出主线程，使进度条有机会重绘（同时给浏览器喘息）
      await new Promise((r) => setTimeout(r, 0));
    }
    highlightSelection();
    return total;
  }
  function getItems() {
    return items;
  }
  function getActiveIndex() {
    return activeIndex;
  }

  // 设置「同步断句」开关：true=断句时原文与译文同步拆行；false=只拆当前编辑单元格。
  function setSyncSplit(val) {
    syncSplit = !!val;
  }

  // 翻译回填后刷新目标列
  function applyTargets() {
    items.forEach((it, i) => {
      const tr = tbody.children[i];
      if (!tr) return;
      const el = tr.querySelector('.target-line');
      if (el) {
        el.innerHTML = it.target || '';
        autoGrow(el);
      }
    });
  }

  // 用于查找替换的批量 setSource
  function setSource(i, val) {
    if (!items[i]) return;
    items[i].source = val;
    const tr = tbody.children[i];
    if (!tr) return;
    const el = tr.querySelector('.source-line');
    if (el) {
      el.innerHTML = val;
      autoGrow(el);
    }
  }

  function clearMatch() {
    if (matchEl) {
      matchEl.classList.remove('match');
      matchEl = null;
    }
  }
  function setMatch(i, side) {
    clearMatch();
    const tr = tbody.children[i];
    if (!tr) return;
    const ta = tr.querySelector(side === 'source' ? '.source-line' : '.target-line');
    if (ta) {
      ta.classList.add('match');
      matchEl = ta;
    }
    selectRow(i, false);
  }

  // 重排每条字幕的序号（index），保证与行位置一一对应、连续。
  function renumber() {
    items.forEach((it, i) => { it.index = i + 1; });
  }

  // 在 pos（0 基）处插入一行空白字幕：新行插到 pos 位置，原 pos 及之后的行顺延；
  // 默认 pos 在活动行之后（pos = activeIndex + 1），列表为空或没有活动行时追加到末尾。
  // 插入后选中并聚焦新行，便于立即输入。
  function insertRow(pos) {
    if (pos == null || pos < 0) pos = items.length;
    pos = Math.max(0, Math.min(items.length, pos));
    items.splice(pos, 0, { index: 0, start: '', end: '', source: '', target: '' });
    renumber();
    activeIndex = pos;
    anchorIndex = pos;
    selected = new Set([pos]);
    render();
    focusCell(pos, 'source', false);
    onActiveChange && onActiveChange(pos);
  }

  // 删除给定索引集合的行（从高到低删除避免索引错位），随后重排序号；
  // 删除后将活动行定位到原第一个被删位置（越界则钳到末尾/清空）。
  function deleteRows(idxs) {
    const set = new Set(idxs);
    if (!set.size) return;
    const sorted = [...set].sort((a, b) => b - a);
    for (const i of sorted) items.splice(i, 1);
    renumber();
    let newActive = Math.min(...set);
    if (newActive >= items.length) newActive = items.length - 1;
    activeIndex = newActive < 0 ? -1 : newActive;
    anchorIndex = activeIndex;
    selected = activeIndex >= 0 ? new Set([activeIndex]) : new Set();
    render();
    if (activeIndex >= 0) scrollToRow(activeIndex);
    onActiveChange && onActiveChange(activeIndex);
  }

  // 返回当前选中的行索引（升序）
  function getSelectedIndices() {
    return [...selected].sort((a, b) => a - b);
  }

  // 列宽拖拽：在表头右缘放一个把手，拖动时直接改对应 <col> 的像素宽
  function setupResizers() {
    const ths = table.querySelectorAll('thead th');
    ths.forEach((th, idx) => {
      if (idx >= cols.length) return;
      const resizer = document.createElement('span');
      resizer.className = 'col-resizer';
      th.appendChild(resizer);
      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const col = cols[idx];
        const startX = e.clientX;
        const startW = col.getBoundingClientRect().width;
        document.body.style.cursor = 'col-resize';
        th.classList.add('resizing');
        function onMove(ev) {
          const newW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
          col.style.width = newW + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          th.classList.remove('resizing');
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }
  setupResizers();

  // 原地交换每一行的 原文/译文：直接对调底层数据与文本框值，不销毁重建 DOM，
  // 避免在某些 WebView 环境下「数据已换但视图未刷新」的不同步问题。
  function swapSides() {
    items.forEach((it, i) => {
      const t = it.source;
      it.source = it.target;
      it.target = t;
      const tr = tbody.children[i];
      if (!tr) return;
      const sEl = tr.querySelector('.source-line');
      const tEl = tr.querySelector('.target-line');
      if (sEl) {
        sEl.innerHTML = it.source;
        autoGrow(sEl);
      }
      if (tEl) {
        tEl.innerHTML = it.target;
        autoGrow(tEl);
      }
    });
  }

  // 字体格式：对当前聚焦单元格里的选区应用 加粗/斜体/下划线。
  // 按钮在 mousedown 时已 preventDefault，焦点与选区仍停留在编辑区，execCommand 可作用于选区。
  // styleWithCSS=false 让浏览器用 <b>/<i>/<u> 等表现型标签而非内联 style。
  function applyFormat(cmd) {
    if (!activeEl) return false;
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(cmd);
      items[activeIndex][activeSide] = activeEl.innerHTML;
      onChange && onChange(items);
    } catch (e) {
      return false;
    }
    return true;
  }

  return { setItems, setItemsAsync, getItems, getActiveIndex, applyTargets, setSource, render, setMatch, clearMatch, swapSides, applyFormat, selectRow, insertRow, deleteRows, getSelectedIndices, setSyncSplit };
}
