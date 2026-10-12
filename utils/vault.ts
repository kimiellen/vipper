/**
 * 书签数据模型与 storage.local 读写层。
 *
 * 数据模型（spec: Feature 2）：
 * - 一条书签 = 标题 + 多个 URL（记录字段在 M4 引入）
 * - 完全独立于 Chrome 原生书签，存 chrome.storage.local
 */

export interface Bookmark {
  id: string;
  title: string;
  urls: string[];
  createdAt: number;
}

const KEY = 'vault:bookmarks';

export async function listBookmarks(): Promise<Bookmark[]> {
  const data = await chrome.storage.local.get(KEY);
  return (data[KEY] as Bookmark[] | undefined) ?? [];
}

export async function addBookmark(input: { title: string; urls: string[] }): Promise<Bookmark> {
  const bookmark: Bookmark = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: [...(await listBookmarks()), bookmark] });
  return bookmark;
}

/** 关键字检索：标题或任一 URL 包含查询串（大小写不敏感）；空查询返回全部 */
export function filterBookmarks(bookmarks: Bookmark[], query: string): Bookmark[] {
  const q = query.trim().toLowerCase();
  if (!q) return bookmarks;
  return bookmarks.filter(
    (b) => b.title.toLowerCase().includes(q) || b.urls.some((u) => u.toLowerCase().includes(q)),
  );
}
