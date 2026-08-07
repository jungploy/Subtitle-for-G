// src/editor.js
// 双语逐行编辑器：左侧时间码面板 + 左原文 / 右译文 两栏按行索引对齐，
// 选中联动高亮 + 滚动对齐，原文/翻译均可编辑。

export function createEditor(container, { onChange } = {}) {
  container.innerHTML = `
    <div class="editor">
      <div class="pane timeline">
        <div class="pane-title">序号 · 时间码</div>
        <div class="rows" id="rowsTime"></div>
      </div>
      <div class="pane">
        <div class="pane-title">原文 · Source</div>
        <div class="rows" id="rowsSource"></div>
      </div>
      <div class="pane">
        <div class="pane-title">翻译 · Target</div>
        <div class="rows" id="rowsTarget"></div>
      </div>
    </div>`;

  const rowsTime = container.querySelector('#rowsTime');
  const rowsSource = container.querySelector('#rowsSource');
  const rowsTarget = container.querySelector('#rowsTarget');
  let items = [];
  let activeIndex = -1;
  let scrollLock = false;

  function makeRow(i, value, cls, placeholder) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = i;

    const ta = document.createElement('textarea');
    ta.className = 'line ' + cls;
    ta.value = value;
    ta.placeholder = placeholder || '';
    ta.spellcheck = false;

    const field = cls === 'source-line' ? 'source' : 'target';

    ta.addEventListener('input', () => {
      items[i][field] = ta.value;
      syncRowHeight(i);
      onChange && onChange(items);
    });
    ta.addEventListener('focus', () => setActive(i));
    ta.addEventListener('click', () => setActive(i));

    row.appendChild(ta);
    return row;
  }

  // 左侧时间码面板的一行：序号 / 起始 / 结束
  function makeTimeRow(i, it) {
    const row = document.createElement('div');
    row.className = 'time-row';
    row.dataset.index = i;

    const idx = document.createElement('div');
    idx.className = 'tc-index';
    idx.textContent = '#' + (it.index ?? i + 1);

    const start = document.createElement('div');
    start.className = 'tc-start';
    start.textContent = it.start || '';

    const end = document.createElement('div');
    end.className = 'tc-end';
    end.textContent = it.end || '';

    row.appendChild(idx);
    row.appendChild(start);
    row.appendChild(end);
    row.addEventListener('click', () => setActive(i));
    return row;
  }

  function render() {
    rowsTime.innerHTML = '';
    rowsSource.innerHTML = '';
    rowsTarget.innerHTML = '';
    items.forEach((it, i) => {
      rowsTime.appendChild(makeTimeRow(i, it));
      rowsSource.appendChild(makeRow(i, it.source, 'source-line', ''));
      rowsTarget.appendChild(makeRow(i, it.target, 'target-line', '在此输入翻译…'));
    });
    syncAllHeights();
    if (activeIndex >= 0) highlight(activeIndex);
  }

  // 让三栏同一行高度一致：取「原文文本框 / 译文文本框 / 时间码行」三者自然高度的最大值，
  // 保证逐行严格对齐。注意时间码行本身含 3 行文字、且带 1px 下边框，必须纳入计算，
  // 否则会被压低导致内容溢出、与右两栏不在同一水平线上。
  function syncRowHeight(i) {
    const s = rowsSource.children[i]?.querySelector('.line');
    const t = rowsTarget.children[i]?.querySelector('.line');
    const timeRow = rowsTime.children[i];
    if (!s || !t) return;
    // 先还原为 auto，才能测得真实自然高度
    s.style.height = 'auto';
    t.style.height = 'auto';
    if (timeRow) timeRow.style.height = 'auto';
    const hs = s.scrollHeight;
    const ht = t.scrollHeight;
    const htrow = timeRow ? timeRow.scrollHeight + 1 : 0; // +1 补偿时间行 1px 下边框
    const h = Math.max(hs, ht, htrow, 28);
    s.style.height = h + 'px';
    t.style.height = h + 'px';
    if (timeRow) timeRow.style.height = h + 'px';
  }
  function syncAllHeights() {
    for (let i = 0; i < items.length; i++) syncRowHeight(i);
  }

  function highlight(i) {
    [rowsTime, rowsSource, rowsTarget].forEach((pane) =>
      pane.querySelectorAll('.row, .time-row').forEach((r) =>
        r.classList.toggle('active', +r.dataset.index === i)
      )
    );
  }

  // 让某一侧滚动，使第 i 行居中
  function scrollPaneToRow(pane, i) {
    const el = pane.children[i];
    if (!el) return;
    pane.scrollTop = el.offsetTop - pane.clientHeight / 2 + el.offsetHeight / 2;
  }

  // 三栏滚动联动：任一栏滚动，其余同步
  function syncScroll(srcPane) {
    if (scrollLock) return;
    scrollLock = true;
    const top = srcPane.scrollTop;
    [rowsTime, rowsSource, rowsTarget].forEach((p) => {
      if (p !== srcPane) p.scrollTop = top;
    });
    scrollLock = false;
  }
  [rowsTime, rowsSource, rowsTarget].forEach((p) =>
    p.addEventListener('scroll', () => syncScroll(p))
  );

  // 窗口缩放 / 字体晚加载时重新对齐三栏行高，防止对齐漂移
  window.addEventListener('resize', syncAllHeights);
  // 延迟一帧再算一次，规避首帧字体/布局未稳定导致的测高偏差
  requestAnimationFrame(syncAllHeights);

  // 选中第 i 行：三栏高亮，且都滚动到该行居中 —— 清晰对应
  function setActive(i) {
    activeIndex = i;
    highlight(i);
    scrollPaneToRow(rowsTime, i);
    scrollPaneToRow(rowsSource, i);
    scrollPaneToRow(rowsTarget, i);
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
  // 翻译回填后，把 target 写回文本框并重新对齐高度
  function applyTargets() {
    items.forEach((it, i) => {
      const ta = rowsTarget.children[i]?.querySelector('.line');
      if (ta) ta.value = it.target || '';
    });
    syncAllHeights();
  }
  function setSource(i, val) {
    if (!items[i]) return;
    items[i].source = val;
    const ta = rowsSource.children[i]?.querySelector('.line');
    if (ta) ta.value = val;
    syncRowHeight(i);
  }

  // 查找高亮：高亮第 i 行指定一侧，并清除上一次高亮
  let matchEl = null;
  let matchTimeEl = null;
  function clearMatch() {
    if (matchEl) {
      matchEl.classList.remove('match');
      matchEl = null;
    }
    if (matchTimeEl) {
      matchTimeEl.classList.remove('match');
      matchTimeEl = null;
    }
  }
  function setMatch(i, side) {
    clearMatch();
    const pane = side === 'source' ? rowsSource : rowsTarget;
    const row = pane.children[i];
    if (row) {
      const ta = row.querySelector('.line');
      if (ta) {
        ta.classList.add('match');
        matchEl = ta;
      }
    }
    const trow = rowsTime.children[i];
    if (trow) {
      trow.classList.add('match');
      matchTimeEl = trow;
    }
    setActive(i);
  }

  return { setItems, getItems, getActiveIndex, applyTargets, setSource, render, setMatch, clearMatch };
}
