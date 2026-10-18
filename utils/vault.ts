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
export interface Account { username: string; password: string }
export interface NoteRecord { template: 'note'; name: string; content: string }
export interface SecretRecord { template: 'secret'; name: string; content: string }
export type VaultRecord = NoteRecord | SecretRecord;

export interface Bookmark {
  id: string;
  title: string;
  remarks: string;
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

/** 索引条目：只含搜索/列表/匹配需要的明文字段（accountCount 仅计数，不含账号内容） */
export interface IndexEntry {
  id: string;
  title: string;
  remarks: string;
  tags: string[];
  linkedInfos: string[];
  urls: BookmarkUrl[];
  accountCount: number;
  lastUsedAt: number;
  status: 'active' | 'archived';
}

const IDX = 'idx';
const META_MIGRATIONS = 'meta:migrations';
const bmKey = (id: string) => `bm:${id}`;
const arcKey = (id: string) => `arc:${id}`;
const keyOf = (b: Pick<Bookmark, 'id' | 'status'>) => (b.status === 'archived' ? arcKey(b.id) : bmKey(b.id));

/** 旧版字段（2026-10-17 remark → remarks）与规范化入口 */
type LegacyBookmark = Omit<Bookmark, 'remarks'> & { remarks?: string; remark?: string };
type LegacyIndexEntry = Omit<IndexEntry, 'remarks'> & { remarks?: string; remark?: string };

function normalizeBookmark(b: LegacyBookmark): Bookmark {
  const { remark, ...rest } = b;
  return { ...rest, remarks: rest.remarks ?? remark ?? '' };
}

function normalizeIndexEntry(e: LegacyIndexEntry): IndexEntry {
  const { remark, ...rest } = e;
  return { ...rest, remarks: rest.remarks ?? remark ?? '' };
}

let remarksMigration: Promise<void> | null = null;

/** 一次性迁移：把 idx / bm: / arc: 里的旧 remark 字段改为 remarks（meta:migrations 标记） */
function migrateRemarks(): Promise<void> {
  remarksMigration ??= doMigrateRemarks().catch((e) => {
    remarksMigration = null;
    throw e;
  });
  return remarksMigration;
}

async function doMigrateRemarks(): Promise<void> {
  const state = ((await chrome.storage.local.get(META_MIGRATIONS))[META_MIGRATIONS] ?? {}) as {
    remarksRenamed?: boolean;
  };
  if (state.remarksRenamed) return;

  const all = await chrome.storage.local.get(null);
  const patch: Record<string, unknown> = {};
  const isLegacy = (v: object) =>
    Object.prototype.hasOwnProperty.call(v, 'remark') || !Object.prototype.hasOwnProperty.call(v, 'remarks');
  for (const [key, val] of Object.entries(all)) {
    if (key === IDX && Array.isArray(val)) {
      if ((val as object[]).some(isLegacy)) patch[IDX] = (val as LegacyIndexEntry[]).map(normalizeIndexEntry);
    } else if ((key.startsWith('bm:') || key.startsWith('arc:')) && val && typeof val === 'object' && isLegacy(val)) {
      patch[key] = normalizeBookmark(val as LegacyBookmark);
    }
  }
  patch[META_MIGRATIONS] = { ...state, remarksRenamed: true };
  await chrome.storage.local.set(patch);
}

const toIndex = (b: Bookmark): IndexEntry => ({
  id: b.id,
  title: b.title,
  remarks: b.remarks,
  tags: b.tags,
  linkedInfos: b.linkedInfos,
  urls: b.urls,
  accountCount: b.accounts.length,
  lastUsedAt: b.lastUsedAt,
  status: b.status,
});

export async function listIndex(): Promise<IndexEntry[]> {
  await migrateRemarks();
  const raw = ((await chrome.storage.local.get(IDX))[IDX] as LegacyIndexEntry[] | undefined) ?? [];
  return raw.map(normalizeIndexEntry);
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
    remarks: '', tags: [], linkedInfos: [], accounts: [], records: [],
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
  bookmark = normalizeBookmark(bookmark); // 写入统一规范化：兼容 v1 导入对象的旧 remark 字段
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
  await migrateRemarks();
  const data = await chrome.storage.local.get([bmKey(id), arcKey(id)]);
  const raw = (data[bmKey(id)] ?? data[arcKey(id)]) as LegacyBookmark | undefined;
  return raw ? normalizeBookmark(raw) : null;
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

/** 自动归档：lastUsedAt 超过阈值（meta:settings，默认 0 = 不开启）的活跃条目归档。返回归档的 id 列表 */
export async function autoArchive(): Promise<string[]> {
  const { autoArchiveDays } = await getSettings();
  if (autoArchiveDays <= 0) return []; // 0 = 不开启（必须短路，否则 cutoff=now 会归档全部）
  const cutoff = Date.now() - autoArchiveDays * 86_400_000;
  const stale = (await listIndex()).filter((e) => e.status === 'active' && e.lastUsedAt < cutoff);
  for (const e of stale) await archiveBookmark(e.id);
  return stale.map((e) => e.id);
}

// ---------- 管理表：tag / 关联信息（先建后选，不即输即建） ----------

/** Catppuccin 14 彩色：tag 的可选颜色 */
export const TAG_COLORS = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface Tag { id: string; name: string; color: TagColor }
export interface LinkedInfo { id: string; name: string; value: string }

const META_TAGS = 'meta:tags';
const META_LINKS = 'meta:links';

async function listTable<T>(key: string): Promise<T[]> {
  return ((await chrome.storage.local.get(key))[key] as T[] | undefined) ?? [];
}

export const listTags = () => listTable<Tag>(META_TAGS);
export const listLinkedInfos = () => listTable<LinkedInfo>(META_LINKS);

/** 重名拒绝（防语义重复）；color 缺省 mauve */
export async function addTag(name: string, color: TagColor = 'mauve'): Promise<Tag> {
  const tags = await listTags();
  if (tags.some((t) => t.name === name)) throw new Error(`tag 已存在: ${name}`);
  if (!TAG_COLORS.includes(color)) throw new Error(`非法 tag 颜色: ${color}`);
  const tag: Tag = { id: crypto.randomUUID(), name, color };
  await chrome.storage.local.set({ [META_TAGS]: [...tags, tag] });
  return tag;
}

/** 重名/重值拒绝 */
export async function addLinkedInfo(name: string, value: string): Promise<LinkedInfo> {
  const links = await listLinkedInfos();
  if (links.some((l) => l.name === name || l.value === value)) {
    throw new Error(`关联信息已存在: ${name} ${value}`);
  }
  const link: LinkedInfo = { id: crypto.randomUUID(), name, value };
  await chrome.storage.local.set({ [META_LINKS]: [...links, link] });
  return link;
}

/** 更新 tag（重名拒绝，排除自身） */
export async function updateTag(id: string, patch: { name?: string; color?: TagColor }): Promise<void> {
  const tags = await listTags();
  const tag = tags.find((t) => t.id === id);
  if (!tag) throw new Error('tag 不存在');
  if (patch.name && tags.some((t) => t.id !== id && t.name === patch.name)) {
    throw new Error(`tag 已存在: ${patch.name}`);
  }
  if (patch.color && !TAG_COLORS.includes(patch.color)) throw new Error(`非法 tag 颜色: ${patch.color}`);
  Object.assign(tag, patch);
  await chrome.storage.local.set({ [META_TAGS]: tags });
}

/** 更新关联信息（重名/重值拒绝，排除自身） */
export async function updateLinkedInfo(id: string, patch: { name?: string; value?: string }): Promise<void> {
  const links = await listLinkedInfos();
  const link = links.find((l) => l.id === id);
  if (!link) throw new Error('关联信息不存在');
  if (links.some((l) => l.id !== id && (l.name === patch.name || l.value === patch.value))) {
    throw new Error('关联信息已存在（重名或重值）');
  }
  Object.assign(link, patch);
  await chrome.storage.local.set({ [META_LINKS]: links });
}

/** 被书签引用的管理表条目拒绝删除 */
async function assertNotReferenced(kind: 'tags' | 'linkedInfos', id: string): Promise<void> {
  const refs = (await listIndex()).filter((e) => e[kind].includes(id));
  if (refs.length > 0) {
    throw new Error(`被 ${refs.length} 条书签引用（${refs.map((e) => e.title).join('、')}），不能删除`);
  }
}

export async function deleteTag(id: string): Promise<void> {
  await assertNotReferenced('tags', id);
  await chrome.storage.local.set({ [META_TAGS]: (await listTags()).filter((t) => t.id !== id) });
}

export async function deleteLinkedInfo(id: string): Promise<void> {
  await assertNotReferenced('linkedInfos', id);
  await chrome.storage.local.set({ [META_LINKS]: (await listLinkedInfos()).filter((l) => l.id !== id) });
}

// ---------- 导入导出（spec: 导入导出） ----------

export interface VaultExport {
  app: 'vipper';
  version: 1 | 2;
  exportedAt: number;
  bookmarks: Bookmark[];
  tags: Tag[];
  linkedInfos: LinkedInfo[];
}

/** 导出全量明文（含归档条目）。需已解锁——敏感字段解密后导出 */
export async function exportAll(): Promise<VaultExport> {
  if (!(await getKey())) throw new Error('vault locked');
  const bookmarks: Bookmark[] = [];
  for (const e of await listIndex()) {
    const b = await getBookmarkDecrypted(e.id);
    if (b) bookmarks.push(b);
  }
  return {
    app: 'vipper', version: 2, exportedAt: Date.now(),
    bookmarks, tags: await listTags(), linkedInfos: await listLinkedInfos(),
  };
}

/**
 * 导入 = 数据恢复（spec 2026-10-15）：校验结构后全量替换——清空现有书签与管理表，
 * 再写入导入内容（明文敏感字段重新加密落盘）。不做增量合并；UI 层需先验证主密码。
 * 需已解锁。返回恢复的书签数。
 */
export async function importAll(data: VaultExport): Promise<{ added: number }> {
  if (data?.app !== 'vipper' || !Array.isArray(data.bookmarks)) throw new Error('不是有效的 vipper 导出文件');
  if (!(await getKey())) throw new Error('vault locked');

  // 清空现有书签（idx + bm:/arc:）与管理表
  const old = await listIndex();
  await chrome.storage.local.remove([
    IDX, META_TAGS, META_LINKS,
    ...old.flatMap((e) => [bmKey(e.id), arcKey(e.id)]),
  ]);

  // 管理表整表写入（恢复语义：导入文件即全量真源，引用 id 原样保留）
  await chrome.storage.local.set({ [META_TAGS]: data.tags ?? [], [META_LINKS]: data.linkedInfos ?? [] });
  // v1 导出文件用 remark，v2 用 remarks——saveBookmark 内统一规范化
  for (const b of data.bookmarks) await saveBookmark(b);
  return { added: data.bookmarks.length };
}
