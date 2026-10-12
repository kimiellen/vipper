/**
 * 书签库：完整条目模型 + storage.local 拆 key 布局。
 *
 * 布局（spec: 存储布局）：
 *   idx        → 轻量索引（搜索/列表只读它）
 *   bm:<id>    → 活跃条目详情
 *   arc:<id>   → 归档条目详情
 *   meta:tags / meta:links / meta:settings → 管理表与配置
 *
 * 加密约定：saveBookmark 接收明文敏感字段、落盘前加密（需已解锁）；
 * getBookmark 返回原始存储形态（敏感字段为密文）；getBookmarkDecrypted 返回明文（需已解锁）。
 */

import { decryptString, encryptString, isEncrypted } from './crypto';
import { getKey, getSettings } from './keychain';

export type UrlMatch = 'host' | 'exact' | 'prefix';
export interface BookmarkUrl { url: string; match: UrlMatch }
export interface Account { username: string; password: string; label?: string }
export interface NoteRecord { template: 'note'; name: string; content: string }
export interface SecretRecord { template: 'secret'; name: string; content: string }
export type VaultRecord = NoteRecord | SecretRecord;

export interface Bookmark {
  id: string;
  title: string;
  remark: string;
  tags: string[];
  linkedInfos: string[];
  urls: BookmarkUrl[];
  accounts: Account[];
  records: VaultRecord[];
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

/** 索引条目：只含搜索/列表/匹配需要的明文字段 */
export interface IndexEntry {
  id: string;
  title: string;
  tags: string[];
  linkedInfos: string[];
  urls: BookmarkUrl[];
  lastUsedAt: number;
  status: 'active' | 'archived';
}

const IDX = 'idx';
const bmKey = (id: string) => `bm:${id}`;
const arcKey = (id: string) => `arc:${id}`;
const keyOf = (b: Pick<Bookmark, 'id' | 'status'>) => (b.status === 'archived' ? arcKey(b.id) : bmKey(b.id));

const toIndex = (b: Bookmark): IndexEntry => ({
  id: b.id,
  title: b.title,
  tags: b.tags,
  linkedInfos: b.linkedInfos,
  urls: b.urls,
  lastUsedAt: b.lastUsedAt,
  status: b.status,
});

export async function listIndex(): Promise<IndexEntry[]> {
  return ((await chrome.storage.local.get(IDX))[IDX] as IndexEntry[] | undefined) ?? [];
}

async function writeIndex(entries: IndexEntry[]): Promise<void> {
  await chrome.storage.local.set({ [IDX]: entries });
}

/** 对条目的敏感字段做加密/解密变换 */
async function mapSensitive(b: Bookmark, fn: (v: string) => Promise<string>): Promise<Bookmark> {
  return {
    ...b,
    accounts: await Promise.all(b.accounts.map(async (a) => ({ ...a, password: await fn(a.password) }))),
    records: await Promise.all(
      b.records.map(async (r) => (r.template === 'secret' ? { ...r, content: await fn(r.content) } : r)),
    ),
  };
}

export type NewBookmark = Partial<Bookmark> & { title: string; urls: BookmarkUrl[] };

export async function addBookmark(input: NewBookmark): Promise<Bookmark> {
  const now = Date.now();
  const bookmark: Bookmark = {
    remark: '', tags: [], linkedInfos: [], accounts: [], records: [],
    status: 'active', createdAt: now, updatedAt: now, lastUsedAt: now,
    ...input,
    id: crypto.randomUUID(),
  };
  await saveBookmark(bookmark);
  return bookmark;
}

/**
 * 保存条目：敏感字段加密后落盘，同步更新索引。
 * 含未加密的敏感字段时要求已解锁。
 */
export async function saveBookmark(bookmark: Bookmark): Promise<void> {
  const hasPlainSensitive =
    bookmark.accounts.some((a) => !isEncrypted(a.password)) ||
    bookmark.records.some((r) => r.template === 'secret' && !isEncrypted(r.content));

  let toStore = { ...bookmark, updatedAt: Date.now() };
  if (hasPlainSensitive) {
    const key = await getKey();
    if (!key) throw new Error('vault locked');
    toStore = await mapSensitive(toStore, async (v) => (isEncrypted(v) ? v : encryptString(key, v)));
  }

  // 状态切换时清理另一侧的 key
  await chrome.storage.local.remove(bookmark.status === 'archived' ? bmKey(bookmark.id) : arcKey(bookmark.id));
  await chrome.storage.local.set({ [keyOf(toStore)]: toStore });

  const idx = await listIndex();
  const i = idx.findIndex((e) => e.id === bookmark.id);
  const entry = toIndex(toStore);
  if (i === -1) idx.push(entry);
  else idx[i] = entry;
  await writeIndex(idx);
}

/** 读取条目原始形态（敏感字段为密文），活跃/归档都找 */
export async function getBookmark(id: string): Promise<Bookmark | null> {
  const data = await chrome.storage.local.get([bmKey(id), arcKey(id)]);
  return (data[bmKey(id)] as Bookmark | undefined) ?? (data[arcKey(id)] as Bookmark | undefined) ?? null;
}

/** 读取条目明文形态（需已解锁） */
export async function getBookmarkDecrypted(id: string): Promise<Bookmark | null> {
  const raw = await getBookmark(id);
  if (!raw) return null;
  const key = await getKey();
  if (!key) throw new Error('vault locked');
  return mapSensitive(raw, async (v) => (isEncrypted(v) ? decryptString(key, v) : v));
}

export async function deleteBookmark(id: string): Promise<void> {
  await chrome.storage.local.remove([bmKey(id), arcKey(id)]);
  await writeIndex((await listIndex()).filter((e) => e.id !== id));
}

/** 打开/填充后调用，驱动 lastUsedAt 排序与自动归档 */
export async function touchLastUsed(id: string): Promise<void> {
  const b = await getBookmark(id);
  if (!b) return;
  await saveBookmark({ ...b, lastUsedAt: Date.now() }); // 敏感字段已是密文，无需解锁
}

/** 索引级检索：标题或任一 URL 包含查询串（大小写不敏感）；空查询返回全部（按 lastUsedAt 降序） */
export function filterIndex(entries: IndexEntry[], query: string): IndexEntry[] {
  const sorted = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const q = query.trim().toLowerCase();
  if (!q) return sorted;
  return sorted.filter(
    (e) => e.title.toLowerCase().includes(q) || e.urls.some((u) => u.url.toLowerCase().includes(q)),
  );
}

// ---------- 归档 ----------

/** 手动归档：数据从 bm: 挪到 arc:（saveBookmark 按 status 处理迁移与索引） */
export async function archiveBookmark(id: string): Promise<void> {
  const b = await getBookmark(id);
  if (!b || b.status === 'archived') return;
  await saveBookmark({ ...b, status: 'archived' });
}

export async function restoreBookmark(id: string): Promise<void> {
  const b = await getBookmark(id);
  if (!b || b.status === 'active') return;
  await saveBookmark({ ...b, status: 'active' });
}

/** 自动归档：lastUsedAt 超过阈值（meta:settings，默认 180 天）的活跃条目归档。返回归档的 id 列表 */
export async function autoArchive(): Promise<string[]> {
  const { autoArchiveDays } = await getSettings();
  const cutoff = Date.now() - autoArchiveDays * 86_400_000;
  const stale = (await listIndex()).filter((e) => e.status === 'active' && e.lastUsedAt < cutoff);
  for (const e of stale) await archiveBookmark(e.id);
  return stale.map((e) => e.id);
}

// ---------- 管理表：tag / 关联信息（先建后选，不即输即建） ----------

export interface Tag { id: string; name: string }
export interface LinkedInfo { id: string; type: string; value: string }

const META_TAGS = 'meta:tags';
const META_LINKS = 'meta:links';

async function listTable<T>(key: string): Promise<T[]> {
  return ((await chrome.storage.local.get(key))[key] as T[] | undefined) ?? [];
}

export const listTags = () => listTable<Tag>(META_TAGS);
export const listLinkedInfos = () => listTable<LinkedInfo>(META_LINKS);

/** 重名/重值拒绝（防语义重复） */
export async function addTag(name: string): Promise<Tag> {
  const tags = await listTags();
  if (tags.some((t) => t.name === name)) throw new Error(`tag 已存在: ${name}`);
  const tag: Tag = { id: crypto.randomUUID(), name };
  await chrome.storage.local.set({ [META_TAGS]: [...tags, tag] });
  return tag;
}

export async function addLinkedInfo(type: string, value: string): Promise<LinkedInfo> {
  const links = await listLinkedInfos();
  if (links.some((l) => l.type === type && l.value === value)) {
    throw new Error(`关联信息已存在: ${type} ${value}`);
  }
  const link: LinkedInfo = { id: crypto.randomUUID(), type, value };
  await chrome.storage.local.set({ [META_LINKS]: [...links, link] });
  return link;
}

export async function deleteTag(id: string): Promise<void> {
  await chrome.storage.local.set({ [META_TAGS]: (await listTags()).filter((t) => t.id !== id) });
}

export async function deleteLinkedInfo(id: string): Promise<void> {
  await chrome.storage.local.set({ [META_LINKS]: (await listLinkedInfos()).filter((l) => l.id !== id) });
}
