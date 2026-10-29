/**
 * 标签组快照库（Feature 3）：vipper 自建的标签组管理数据。
 *
 * 布局（spec: Feature 3 数据模型）：
 *   idx:groups          → 组索引（chips 渲染顺序 = 数组顺序）
 *   grp:<id>            → 组详情（含 entries）
 *   meta:lastOpenedGroup → 最后一次回车打开过的组 id（chips 光标初始位置）
 *
 * Chrome 无 API 枚举 saved tab groups，本模块是唯一事实来源。
 * 无敏感信息，不加密。
 */

/** Chrome tabGroups 的 9 色枚举（与 chrome.tabGroups.Color 一致） */
export const GROUP_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** 组颜色 → Catppuccin token 变量名（跟随主题，light/dark 各自取对应色值） */
export const GROUP_COLOR_VARS: Record<GroupColor, string> = {
  grey: '--fg-muted',
  blue: '--cat-blue',
  red: '--cat-red',
  yellow: '--cat-yellow',
  green: '--cat-green',
  pink: '--cat-pink',
  purple: '--cat-mauve',
  cyan: '--cat-sky',
  orange: '--cat-peach',
};

export interface GroupEntry {
  id: string;
  url: string;
  title: string;
  /** 锁定条目冻结：不参与浏览器侧回流，跳转/关闭均不改写（spec: 同步模型） */
  locked: boolean;
}

export interface TabGroupDef {
  id: string;
  title: string;
  color: GroupColor;
  entries: GroupEntry[];
  createdAt: number;
  updatedAt: number;
}

/** 索引条目：chips 渲染只需这些字段 */
export interface GroupIndexEntry {
  id: string;
  title: string;
  color: GroupColor;
  entryCount: number;
  updatedAt: number;
}

const IDX = 'idx:groups';
const LAST_OPENED = 'meta:lastOpenedGroup';
const grpKey = (id: string) => `grp:${id}`;

export async function listGroups(): Promise<GroupIndexEntry[]> {
  return ((await chrome.storage.local.get(IDX))[IDX] as GroupIndexEntry[] | undefined) ?? [];
}

async function writeIndex(entries: GroupIndexEntry[]): Promise<void> {
  await chrome.storage.local.set({ [IDX]: entries });
}

export async function getGroup(id: string): Promise<TabGroupDef | null> {
  return ((await chrome.storage.local.get(grpKey(id)))[grpKey(id)] as TabGroupDef | undefined) ?? null;
}

const toIndex = (g: TabGroupDef): GroupIndexEntry => ({
  id: g.id,
  title: g.title,
  color: g.color,
  entryCount: g.entries.length,
  updatedAt: g.updatedAt,
});

export async function addGroup(input: { title: string; color: GroupColor }): Promise<TabGroupDef> {
  const title = input.title.trim();
  if (!title) throw new Error('组名不能为空');
  if (!GROUP_COLORS.includes(input.color)) throw new Error(`非法组颜色: ${input.color}`);
  const now = Date.now();
  const group: TabGroupDef = {
    id: crypto.randomUUID(), title, color: input.color,
    entries: [], createdAt: now, updatedAt: now,
  };
  await chrome.storage.local.set({ [grpKey(group.id)]: group });
  await writeIndex([...(await listGroups()), toIndex(group)]);
  return group;
}

/** 保存组详情并同步索引（updatedAt 自动刷新） */
export async function saveGroup(group: TabGroupDef): Promise<void> {
  const toStore = { ...group, updatedAt: Date.now() };
  await chrome.storage.local.set({ [grpKey(toStore.id)]: toStore });
  const idx = await listGroups();
  const i = idx.findIndex((e) => e.id === toStore.id);
  const entry = toIndex(toStore);
  if (i === -1) idx.push(entry);
  else idx[i] = entry;
  await writeIndex(idx);
}

/** 最后一次回车打开过的组（chips 光标初始位置，跨重启保留） */
export async function getLastOpenedGroupId(): Promise<string | null> {
  return ((await chrome.storage.local.get(LAST_OPENED))[LAST_OPENED] as string | undefined) ?? null;
}

export async function setLastOpenedGroupId(id: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_OPENED]: id });
}
