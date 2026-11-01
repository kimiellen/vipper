/**
 * 浏览器原生书签读取（Chrome `chrome.bookmarks` API，manifest 需 bookmarks 权限）。
 *
 * 只读：把树形书签展平为条目列表，文件夹路径原样保留给调用方写入 remarks
 * （spec: 导入导出 · 浏览器书签导入，2026-11-01）。
 */

/** 一条待导入的浏览器书签；folderPath 形如「书签栏 / 开发」，根级为空串 */
export interface BrowserBookmarkItem {
  title: string;
  url: string;
  folderPath: string;
  /** Chrome dateAdded（毫秒）；个别节点可能缺失 */
  dateAdded?: number;
}

/** 读取整棵书签树并展平。无 bookmarks 权限时 chrome.bookmarks 为 undefined。 */
export async function collectBrowserBookmarks(): Promise<BrowserBookmarkItem[]> {
  if (!chrome.bookmarks) throw new Error('缺少 bookmarks 权限');
  const tree = await chrome.bookmarks.getTree();
  const items: BrowserBookmarkItem[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]): void => {
    for (const node of nodes) {
      if (node.url) {
        items.push({ title: node.title, url: node.url, folderPath: path.join(' / '), dateAdded: node.dateAdded });
      } else if (node.children) {
        walk(node.children, node.title ? [...path, node.title] : path);
      }
    }
  };
  walk(tree, []);
  return items;
}
