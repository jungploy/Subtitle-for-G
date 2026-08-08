// src/editor.js
// 表格方式的双语字幕编辑器：序号 / 起始时码 / 结束时码 / 时长 / 原文 / 译文
// 每行同一 <tr>，天然等高；原文/译文文本框自动撑高。

export function createEditor(container, { onChange } = {}) {
  container.innerHTML = `
    <div class="editor">
      <div class="table-wrap">
        <table class="sub-table" id="subTable">
          <colgroup>
            <col class="col-index" />
            <col class="col-start" />
            <col class="col-end" />
            <col class="col-duration" />
            <col class="col-source" />
            <col class="col-target" />
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
  let items = [];
  let activeIndex = -1;
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

  function makeCell(cls, content, editable = false) {
    const td = document.createElement('td');
    td.className = cls;
    if (editable) {
      const ta = document.createElement('textarea');
      ta.className = cls.replace('cell-', '') + '-line';
      ta.value = content || '';
      ta.spellcheck = false;
      ta.rows = 1;
      td.appendChild(ta);
      return { td, ta };
    }
    if (content !== undefined && content !== null) td.textContent = content;
    return { td };
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function makeRow(i, it) {
    const tr = document.createElement('tr');
    tr.className = 'sub-row';
    tr.dataset.index = i;

    const idxTd = makeCell('cell-index', it.index ?? i + 1);
    const startTd = makeCell('cell-start', it.start || '');
    const endTd = makeCell('cell-end', it.end || '');
    const durTd = makeCell('cell-duration', duration(it.start, it.end));

    const sourceCell = makeCell('cell-source', it.source, true);
    const targetCell = makeCell('cell-target', it.target, true);

    [idxTd, startTd, endTd, durTd, sourceCell, targetCell].forEach((c) =>
      tr.appendChild(c.td || c)
    );

    const sourceTa = sourceCell.ta;
    const targetTa = targetCell.ta;
    sourceTa.placeholder = '';
    targetTa.placeholder = '在此输入翻译…';

    sourceTa.addEventListener('input', () => {
      items[i].source = sourceTa.value;
      autoGrow(sourceTa);
      onChange && onChange(items);
    });
    targetTa.addEventListener('input', () => {
      items[i].target = targetTa.value;
      autoGrow(targetTa);
      onChange && onChange(items);
    });

    tr.addEventListener('click', (e) => {
      if (e.target !== sourceTa && e.target !== targetTa) setActive(i);
    });
    sourceTa.addEventListener('focus', () => setActive(i));
    targetTa.addEventListener('focus', () => setActive(i));

    // 首渲染后让文本框自适应高度
    requestAnimationFrame(() => {
      autoGrow(sourceTa);
      autoGrow(targetTa);
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
      const ta = tr.querySelector('.target-line');
      if (ta) {
        ta.value = it.target || '';
        autoGrow(ta);
      }
    });
  }

  // 用于查找替换的批量 setSource
  function setSource(i, val) {
    if (!items[i]) return;
    items[i].source = val;
    const tr = tbody.children[i];
    if (!tr) return;
    const ta = tr.querySelector('.source-line');
    if (ta) {
      ta.value = val;
      autoGrow(ta);
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

  return { setItems, getItems, getActiveIndex, applyTargets, setSource, render, setMatch, clearMatch };
}
