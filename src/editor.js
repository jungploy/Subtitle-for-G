// src/editor.js
// 双语逐行编辑器：左右两栏按行索引对齐，选中联动高亮 + 滚动对齐，原文/翻译均可编辑。

export function createEditor(container, { onChange } = {}) {
  container.innerHTML = `
    <div class="editor">
      <div class="pane">
        <div class="pane-title">原文 · Source</div>
        <div class="rows" id="rowsSource"></div>
      </div>
      <div class="pane">
        <div class="pane-title">翻译 · Target</div>
        <div class="rows" id="rowsTarget"></div>
      </div>
    </div>`;

  const rowsSource = container.querySelector('#rowsSource');
  const rowsTarget = container.querySelector('#rowsTarget');
  let items = [];
  let activeIndex = -1;

  function makeRow(i, value, cls, placeholder) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = i;

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = i + 1;

    const ta = document.createElement('textarea');
    ta.className = 'line ' + cls;
    ta.value = value;
    ta.placeholder = placeholder || '';
    ta.spellcheck = false;

    const field = cls === 'source-line' ? 'source' : 'target';
    const side = cls === 'source-line' ? 'source' : 'target';

    ta.addEventListener('input', () => {
      items[i][field] = ta.value;
      syncRowHeight(i);
      onChange && onChange(items);
    });
    ta.addEventListener('focus', () => setActive(i));
    ta.addEventListener('click', () => setActive(i));

    row.appendChild(badge);
    row.appendChild(ta);
    return row;
  }

  function render() {
    rowsSource.innerHTML = '';
    rowsTarget.innerHTML = '';
    items.forEach((it, i) => {
      rowsSource.appendChild(makeRow(i, it.source, 'source-line', ''));
      rowsTarget.appendChild(makeRow(i, it.target, 'target-line', '在此输入翻译…'));
    });
    syncAllHeights();
    if (activeIndex >= 0) highlight(activeIndex);
  }

  // 让左右同一行高度一致（取两侧最大值），保证逐行严格对齐
  function syncRowHeight(i) {
    const s = rowsSource.children[i]?.querySelector('.line');
    const t = rowsTarget.children[i]?.querySelector('.line');
    if (!s || !t) return;
    s.style.height = 'auto';
    t.style.height = 'auto';
    const h = Math.max(s.scrollHeight, t.scrollHeight);
    s.style.height = h + 'px';
    t.style.height = h + 'px';
  }
  function syncAllHeights() {
    for (let i = 0; i < items.length; i++) syncRowHeight(i);
  }

  function highlight(i) {
    rowsSource.querySelectorAll('.row').forEach((r) =>
      r.classList.toggle('active', +r.dataset.index === i)
    );
    rowsTarget.querySelectorAll('.row').forEach((r) =>
      r.classList.toggle('active', +r.dataset.index === i)
    );
  }

  // 让某一侧滚动，使第 i 行居中
  function scrollPaneToRow(pane, i) {
    const el = pane.children[i];
    if (!el) return;
    pane.scrollTop = el.offsetTop - pane.clientHeight / 2 + el.offsetHeight / 2;
  }

  // 选中第 i 行：两侧高亮，且两侧都滚动到该行居中 —— 清晰对应
  function setActive(i) {
    activeIndex = i;
    highlight(i);
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
  function clearMatch() {
    if (matchEl) {
      matchEl.classList.remove('match');
      matchEl = null;
    }
  }
  function setMatch(i, side) {
    clearMatch();
    const pane = side === 'source' ? rowsSource : rowsTarget;
    const row = pane.children[i];
    if (!row) return;
    const ta = row.querySelector('.line');
    if (ta) {
      ta.classList.add('match');
      matchEl = ta;
    }
    setActive(i);
  }

  return { setItems, getItems, getActiveIndex, applyTargets, setSource, render, setMatch, clearMatch };
}
