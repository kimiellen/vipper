/**
 * 书签管理弹窗（Alt+. 呼出）。
 *
 * 键盘交互（spec: Feature 2 交互流程）：
 * - 呼出后光标在搜索栏，输入即过滤
 * - ↓ 进入条目区，↑/↓ 移动选择，↑ 到顶返回搜索栏
 * - Enter：单 URL 书签直接打开；多 URL 书签进入二级菜单选 URL
 * - Esc：二级菜单返回上级；顶级关闭弹窗
 */

import { filterBookmarks, listBookmarks, type Bookmark } from '../../utils/vault';

type View =
  | { kind: 'bookmarks' }
  | { kind: 'urls'; bookmark: Bookmark };

interface Item {
  label: string;
  hint: string;
  action: () => void | Promise<void>;
}

const search = document.querySelector<HTMLInputElement>('#search')!;
const list = document.querySelector<HTMLUListElement>('#list')!;
const crumb = document.querySelector<HTMLDivElement>('#crumb')!;

let bookmarks: Bookmark[] = [];
let viewStack: View[] = [{ kind: 'bookmarks' }];
/** -1 表示焦点在搜索栏，>=0 为列表选中下标 */
let selected = -1;

const currentView = () => viewStack[viewStack.length - 1];

function currentItems(): Item[] {
  const view = currentView();
  if (view.kind === 'urls') {
    return view.bookmark.urls.map((url) => ({
      label: url,
      hint: '',
      action: () => open(url),
    }));
  }
  return filterBookmarks(bookmarks, search.value).map((b) => ({
    label: b.title,
    hint: b.urls.length === 1 ? b.urls[0] : `${b.urls.length} 个 URL ›`,
    action: () => {
      if (b.urls.length === 1) return open(b.urls[0]);
      viewStack.push({ kind: 'urls', bookmark: b });
      selected = 0;
      render();
    },
  }));
}

async function open(url: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'vipper:open', url });
  // 弹窗由 background 关闭（window.close 对非 window.open 创建的窗口不可靠）
}

function render(): void {
  const view = currentView();
  crumb.textContent = view.kind === 'urls' ? `‹ ${view.bookmark.title}（Esc 返回）` : '';

  const items = currentItems();
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div id="empty">无匹配书签</div>';
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = i === selected ? 'selected' : '';
    const label = document.createElement('span');
    label.textContent = item.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = item.hint;
    li.append(label, hint);
    list.append(li);
  });
  list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });

  if (selected === -1) search.focus();
  else search.blur();
}

document.addEventListener('keydown', (e) => {
  const items = currentItems();
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (selected < items.length - 1) { selected += 1; render(); }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (selected > -1) { selected -= 1; render(); }
      break;
    case 'Enter': {
      e.preventDefault();
      const idx = selected === -1 ? 0 : selected; // 搜索栏直接回车 = 打开第一个匹配项
      void items[idx]?.action();
      break;
    }
    case 'Escape':
      e.preventDefault();
      if (viewStack.length > 1) {
        viewStack.pop();
        selected = -1;
        render();
      } else {
        void chrome.runtime.sendMessage({ type: 'vipper:close-launcher' });
      }
      break;
  }
});

search.addEventListener('input', () => { selected = -1; render(); });

bookmarks = await listBookmarks();
render();
