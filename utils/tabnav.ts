/**
 * 标签组导航的纯逻辑层：把窗口内的标签按标签栏视觉顺序折叠成"组序列"。
 *
 * 规则（spec: Feature 1）：
 * - 真实标签组按组内首个标签的位置排序
 * - 连续的一段未分组标签构成一个"隐式组"（被真实组隔断的散标签是不同隐式组）
 * - 上/下 = 组序列中的前/后一个
 */

export interface GroupEntry {
  /** 真实组 id；隐式组为 null */
  groupId: number | null;
  /** 组内标签 id，按视觉顺序 */
  tabIds: number[];
}

export const UNGROUPED = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

/** tabs 必须已按 index 升序排列 */
export function buildGroupSequence(tabs: chrome.tabs.Tab[]): GroupEntry[] {
  const seq: GroupEntry[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const gid = tab.groupId === UNGROUPED ? null : tab.groupId;
    const last = seq[seq.length - 1];
    if (last && last.groupId === gid) {
      last.tabIds.push(tab.id);
    } else {
      seq.push({ groupId: gid, tabIds: [tab.id] });
    }
  }
  return seq;
}

/**
 * 计算切组目标。
 * @returns 目标组条目；到达边界（不环绕）或当前标签不在序列中时返回 null
 */
export function resolveTargetGroup(
  seq: GroupEntry[],
  activeTabId: number,
  direction: -1 | 1,
): GroupEntry | null {
  const curIdx = seq.findIndex((g) => g.tabIds.includes(activeTabId));
  if (curIdx === -1) return null;
  const next = seq[curIdx + direction];
  return next ?? null;
}

/**
 * 计算组内（含隐式组）左/右切换目标。不跨组、不环绕。
 * @returns 目标标签 id；到达组内边界或标签不在组中时返回 null
 */
export function resolveTargetTab(
  entry: GroupEntry,
  activeTabId: number,
  direction: -1 | 1,
): number | null {
  const idx = entry.tabIds.indexOf(activeTabId);
  if (idx === -1) return null;
  return entry.tabIds[idx + direction] ?? null;
}
