// src/editor.js
// 表格方式的双语字幕编辑器：序号 / 起始时码 / 结束时码 / 时长 / 原文 / 译文
// 每行同一 <tr>，天然等高；原文/译文文本框自动撑高。
// 原文/译文单元格均为富文本（contentEditable）：模型里存的是「显示用 HTML」
// （保留 <b>/<i>/<u> 与 <br>），编辑时直接读写 innerHTML，加粗/斜体/下划线等
// 格式变化随之落盘、并随 .gsub 项目文件往返。

export function createEditor(container, { onChange } = {}) {
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
  const cols = table.querySelectorAll('colgroup col');
  let items = [];
  let activeIndex = -1;
  let activeEl = null; // 当前聚焦的富文本单元格（用于字体格式按钮）
  let activeSide = null; // 'source' | 'target'
  let matchEl = null;

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
    div.contentEditable = 'true';
    div.spellcheck = false;
    div.dataset.side = side;
    td.appendChild(div);

    div.addEventListener('input', () => {
      items[i][side] = div.innerHTML;
      autoGrow(div);
      onChange && onChange(items);
    });
    div.addEventListener('focus', () => {
      activeEl = div;
      activeSide = side;
      setActive(i);
    });
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

    tr.addEventListener('click', () => setActive(i));

    // 首渲染后让单元格自适应高度
    requestAnimationFrame(() => {
      autoGrow(sourceEl);
      autoGrow(targetEl);
    });

    return tr;
  }

  function render() {
    tbody.innerHTML = '';
    items.forEach((it, i) => tbody.appendChild(makeRow(i, it)));
    if (activeIndex >= 0) highlight(activeIndex);
  }

  function highlight(i) {
    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.classList.toggle('active', +tr.dataset.index === i);
    });
  }

  function scrollToRow(i) {
    const tr = tbody.children[i];
    if (!tr) return;
    const wrap = table.parentElement;
    wrap.scrollTop = tr.offsetTop - wrap.clientHeight / 2 + tr.offsetHeight / 2;
  }

  function setActive(i) {
    activeIndex = i;
    highlight(i);
    scrollToRow(i);
  }

  function setItems(newItems) {
    items = newItems || [];
    activeIndex = -1;
    render();
  }
  function getItems() {
    return items;
  }
  function getActiveIndex() {
    return activeIndex;
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
    setActive(i);
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

  return { setItems, getItems, getActiveIndex, applyTargets, setSource, render, setMatch, clearMatch, swapSides, applyFormat };
}
