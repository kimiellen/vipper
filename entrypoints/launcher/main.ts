/**
 * 书签管理弹窗（Alt+. 呼出）。
 *
 * 键盘交互（spec: Feature 2 交互流程）：
 * - 呼出后光标在搜索栏，输入即过滤（按 lastUsedAt 降序）
 * - ↓ 进入条目区，↑/↓ 移动选择，↑ 到顶返回搜索栏
 * - Enter：单 URL 书签直接打开；多 URL 书签进入二级菜单选 URL
 * - Ctrl+E 编辑选中条目；Ctrl+N 新建书签；Ctrl+M 打开管理表页
 * - Esc：二级菜单返回上级；顶级关闭弹窗
 */

import { filterIndex, listIndex, type IndexEntry } from '../../utils/vault';

type View =
  | { kind: 'bookmarks' }
  | { kind: 'urls'; entry: IndexEntry };

interface Item {
  label: string;
  hint: string;
  /** 供 favicon 与 Ctrl+E 使用 */
  bookmarkId: string;
  firstUrl: string;
  action: () => void | Promise<void>;
}

const search = document.querySelector<HTMLInputElement>('#search')!;
const list = document.querySelector<HTMLUListElement>('#list')!;
const crumb = document.querySelector<HTMLDivElement>('#crumb')!;

let entries: IndexEntry[] = [];
let viewStack: View[] = [{ kind: 'bookmarks' }];
/** -1 表示焦点在搜索栏，>=0 为列表选中下标 */
let selected = -1;
/** 最近一次渲染的条目，供快捷键定位 */
let lastItems: Item[] = [];

const currentView = (): View => viewStack[viewStack.length - 1]!;

function currentItems(): Item[] {
  const view = currentView();
  if (view.kind === 'urls') {
    return view.entry.urls.map((u) => ({
      label: u.url,
      hint: '',
      bookmarkId: view.entry.id,
      firstUrl: u.url,
      action: () => open(view.entry.id, u.url),
    }));
  }
  return filterIndex(entries, search.value)
    .filter((e) => e.status === 'active')
    .map((e) => ({
      label: e.title,
      hint: e.urls.length === 1 ? e.urls[0]!.url : `${e.urls.length} 个 URL ›`,
      bookmarkId: e.id,
      firstUrl: e.urls[0]?.url ?? '',
      action: () => {
        if (e.urls.length === 1) return open(e.id, e.urls[0]!.url);
        viewStack.push({ kind: 'urls', entry: e });
        selected = 0;
        render();
      },
    }));
}

async function open(bookmarkId: string, url: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'vipper:open', url, bookmarkId });
  // 弹窗由 background 关闭（window.close 对非 window.open 创建的窗口不可靠）
}

function openEditor(id?: string): Promise<unknown> {
  return chrome.windows.create({
    url: chrome.runtime.getURL(`editor.html${id ? `?id=${id}` : ''}`),
    type: 'popup', width: 720, height: 640, focused: true,
  });
}

function openManager(): Promise<unknown> {
  return chrome.windows.create({
    url: chrome.runtime.getURL('manager.html'),
    type: 'popup', width: 640, height: 520, focused: true,
  });
}

function faviconUrl(pageUrl: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=16`);
}

function render(): void {
  const view = currentView();
  crumb.textContent = view.kind === 'urls' ? `‹ ${view.entry.title}（Esc 返回）` : '';

  const items = currentItems();
  lastItems = items;
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div id="empty">无匹配书签</div>';
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = i === selected ? 'selected' : '';
    if (item.firstUrl.startsWith('http')) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = faviconUrl(item.firstUrl);
      li.append(img);
    }
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
  const items = lastItems;
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
    default:
      if (e.ctrlKey && currentView().kind === 'bookmarks') {
        if (e.key === 'e') {
          e.preventDefault();
          const it = items[selected === -1 ? 0 : selected];
          if (it) void openEditor(it.bookmarkId);
        } else if (e.key === 'n') {
          e.preventDefault();
          void openEditor();
        } else if (e.key === 'm') {
          e.preventDefault();
          void openManager();
        }
      }
  }
});

search.addEventListener('input', () => { selected = -1; render(); });

entries = await listIndex();
render();
