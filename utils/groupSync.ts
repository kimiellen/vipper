/**
 * 浏览器 → 管理页回流（spec: 同步模型 / M29）。
 *
 * 事件 → 语义：
 * - `tabs.onUpdated(url/title)`：同 tabId 跳转 → 改写未锁定条目的 url/标题
 * - `tabs.onRemoved`：单个标签关闭 → 删除未锁定条目；
 *   `isWindowClosing`（整窗关闭）→ 快照保留，仅映射作废（spec 关闭语义 2026-10-29）
 * - `tabGroups.onRemoved`：chrome 组整体关闭 → 映射作废，快照保留
 * - `tabs.onUpdated(groupId)`：进组/出组（实测 Chrome 154 会派发）；连同
 *   `tabs.onCreated/onMoved/onAttached/onDetached` → 去抖 resync：
 *   进组 = 新增条目；出组 = 删除未锁定条目；条目顺序对齐浏览器标签顺序
 *
 * 锁定条目豁免一切改写/删除。映射（opengrp:<id>）在 storage.session，
 * SW 休眠/重启不丢失；每组一个 promise 队列串行化读写，避免事件交错竞态。
 */

import * as groups from './groups';

// ---------- 每组串行队列 ----------

const queues = new Map<string, Promise<void>>();

function enqueue(groupId: string, fn: () => Promise<void>): void {
  const p = (queues.get(groupId) ?? Promise.resolve()).then(fn).catch(() => {});
  queues.set(groupId, p);
}

/** 回流写入后通知 wui 实时刷新（无接收方时忽略） */
function notify(groupId: string): void {
  void chrome.runtime.sendMessage({ type: 'vipper:group-synced', groupId }).catch(() => {});
}

async function findByTabId(
  tabId: number,
): Promise<{ groupId: string; mapping: groups.OpenGroupMapping; entryId: string } | null> {
  const all = await groups.listOpenGroupMappings();
  for (const [groupId, mapping] of Object.entries(all)) {
    const entryId = mapping.tabs[tabId];
    if (entryId) return { groupId, mapping, entryId };
  }
  return null;
}

// ---------- 跳转回流：tabs.onUpdated ----------

function onTabUpdated(tabId: number, changeInfo: { url?: string; title?: string; groupId?: number }): void {
  if (changeInfo.groupId !== undefined) scheduleResyncAll(); // 进组/出组（Chrome 154 实测派发）
  if (!changeInfo.url && !changeInfo.title) return;
  void (async () => {
    const hit = await findByTabId(tabId);
    if (!hit) return;
    enqueue(hit.groupId, async () => {
      const def = await groups.getGroup(hit.groupId);
      const entry = def?.entries.find((e) => e.id === hit.entryId);
      if (!def || !entry || entry.locked) return;
      if (changeInfo.url) entry.url = changeInfo.url;
      if (changeInfo.title) entry.title = changeInfo.title;
      await groups.saveGroup(def);
      notify(hit.groupId);
    });
  })();
}

// ---------- 关闭回流：tabs.onRemoved ----------

function onTabRemoved(tabId: number, removeInfo: { isWindowClosing: boolean }): void {
  void (async () => {
    const hit = await findByTabId(tabId);
    if (!hit) return;
    const { groupId, entryId } = hit;
    if (removeInfo.isWindowClosing) {
      // 整窗关闭 ≠ 删除页面：快照保留，映射作废（chrome 组已随窗口消失）
      enqueue(groupId, () => groups.clearOpenGroupMapping(groupId));
      return;
    }
    enqueue(groupId, async () => {
      const cur = await groups.getOpenGroupMapping(groupId);
      if (!cur) return;
      delete cur.tabs[tabId];
      await groups.setOpenGroupMapping(groupId, cur);
      const def = await groups.getGroup(groupId);
      const entry = def?.entries.find((e) => e.id === entryId);
      if (def && entry && !entry.locked) {
        def.entries = def.entries.filter((e) => e.id !== entryId);
        await groups.saveGroup(def);
        notify(groupId);
      }
    });
  })();
}

// ---------- 进出组 + 顺序对齐：去抖 resync ----------

const resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleResyncAll(): void {
  void (async () => {
    const all = await groups.listOpenGroupMappings();
    for (const groupId of Object.keys(all)) {
      clearTimeout(resyncTimers.get(groupId));
      resyncTimers.set(
        groupId,
        setTimeout(() => {
          resyncTimers.delete(groupId);
          enqueue(groupId, () => resync(groupId));
        }, 200),
      );
    }
  })();
}

/** 成员对齐：进组新增条目、出组删除未锁定条目、条目顺序对齐浏览器标签顺序 */
async function resync(groupId: string): Promise<void> {
  const mapping = await groups.getOpenGroupMapping(groupId);
  if (!mapping) return;
  const chromeTabs = await chrome.tabs.query({ groupId: mapping.chromeGroupId });
  if (chromeTabs.length === 0) {
    // chrome 组已消失（空组自动移除）：映射作废，快照保留
    await groups.clearOpenGroupMapping(groupId);
    return;
  }
  const def = await groups.getGroup(groupId);
  if (!def) {
    await groups.clearOpenGroupMapping(groupId);
    return;
  }

  let changed = false;
  const currentIds = new Set(chromeTabs.map((t) => t.id!));
  const knownIds = new Set(Object.keys(mapping.tabs).map(Number));

  // 出组/关闭：known - current → 未锁定删条目，映射摘除
  for (const tabId of knownIds) {
    if (currentIds.has(tabId)) continue;
    const entryId = mapping.tabs[tabId]!;
    delete mapping.tabs[tabId];
    const entry = def.entries.find((e) => e.id === entryId);
    if (entry && !entry.locked) {
      def.entries = def.entries.filter((e) => e.id !== entryId);
      changed = true;
    }
  }

  // 进组：current - known → 新条目（位置由下面的顺序对齐统一处理）
  for (const tab of chromeTabs) {
    if (knownIds.has(tab.id!)) continue;
    const entry: groups.GroupEntry = {
      id: crypto.randomUUID(),
      url: tab.url ?? 'about:blank',
      title: tab.title || tab.url || 'about:blank',
      locked: false,
    };
    mapping.tabs[tab.id!] = entry.id;
    def.entries.push(entry);
    changed = true;
  }

  // 顺序对齐浏览器标签顺序；无标签映射的条目（锁定且已不在组内）保持相对位置附后
  const byEntryId = new Map(def.entries.map((e) => [e.id, e]));
  const ordered: groups.GroupEntry[] = [];
  for (const tab of chromeTabs) {
    const entryId = mapping.tabs[tab.id!];
    const entry = byEntryId.get(entryId!);
    if (entry) {
      ordered.push(entry);
      byEntryId.delete(entryId!);
    }
  }
  ordered.push(...byEntryId.values());
  if (ordered.some((e, i) => e.id !== def.entries[i]?.id)) {
    def.entries = ordered;
    changed = true;
  }

  await groups.setOpenGroupMapping(groupId, mapping);
  if (changed) {
    await groups.saveGroup(def);
    notify(groupId);
  }
}

// ---------- 接线 ----------

export function setupGroupSync(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => onTabUpdated(tabId, changeInfo));
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => onTabRemoved(tabId, removeInfo));
  chrome.tabGroups.onRemoved.addListener((group) => {
    // chrome 组整体关闭：快照保留，映射作废（与 isWindowClosing 路径幂等）
    void (async () => {
      const all = await groups.listOpenGroupMappings();
      for (const [groupId, m] of Object.entries(all)) {
        if (m.chromeGroupId === group.id) enqueue(groupId, () => groups.clearOpenGroupMapping(groupId));
      }
    })();
  });
  // 进出组主要由 onUpdated(groupId) 覆盖；这些事件兜底跨窗口移动与组内排序
  chrome.tabs.onCreated.addListener(scheduleResyncAll);
  chrome.tabs.onMoved.addListener(scheduleResyncAll);
  chrome.tabs.onAttached.addListener(scheduleResyncAll);
  chrome.tabs.onDetached.addListener(scheduleResyncAll);
}
