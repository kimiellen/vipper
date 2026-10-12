import { buildGroupSequence, resolveTargetGroup, resolveTargetTab, UNGROUPED } from '../utils/tabnav';

/** 每组上次活跃标签的 storage.session key */
function lastActiveKey(windowId: number, groupId: number | null): string {
  return `lastActive:${windowId}:${groupId ?? 'implicit'}`;
}

/** 记忆标签激活事件，供切组时恢复到组内上次活跃标签 */
function trackLastActiveTab(): void {
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    try {
      const tab = await chrome.tabs.get(tabId); // 激活瞬间标签可能已被关闭
      const gid = tab.groupId === UNGROUPED ? null : tab.groupId;
      await chrome.storage.session.set({ [lastActiveKey(windowId, gid)]: tabId });
    } catch { /* 标签已不存在则放弃本次记忆 */ }
  });
}

/** Alt+↑/↓：按视觉顺序切换到前/后一个组，折叠其他组，不环绕 */
async function switchGroup(direction: -1 | 1): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id === undefined || active.windowId === undefined) return;

  const tabs = (await chrome.tabs.query({ windowId: active.windowId }))
    .sort((a, b) => a.index - b.index);
  const seq = buildGroupSequence(tabs);
  const target = resolveTargetGroup(seq, active.id, direction);
  if (!target) return;

  // 优先恢复目标组上次活跃的标签；记忆失效（标签已关闭/移出）则取组内首个
  const key = lastActiveKey(active.windowId, target.groupId);
  const remembered = (await chrome.storage.session.get(key))[key] as number | undefined;
  const targetTabId = remembered && target.tabIds.includes(remembered)
    ? remembered
    : target.tabIds[0];

  await chrome.tabs.update(targetTabId, { active: true });

  // 折叠其他真实组、展开目标组；目标是隐式组时折叠所有真实组
  await Promise.all(
    seq
      .filter((g): g is { groupId: number; tabIds: number[] } => g.groupId !== null)
      .map((g) =>
        chrome.tabGroups.update(g.groupId, { collapsed: g.groupId !== target.groupId }),
      ),
  );
}

/** Alt+Shift+←/→：当前组（含隐式组）内左/右切换标签，不跨组、不环绕 */
async function switchTab(direction: -1 | 1): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id === undefined || active.windowId === undefined) return;

  const tabs = (await chrome.tabs.query({ windowId: active.windowId }))
    .sort((a, b) => a.index - b.index);
  const cur = buildGroupSequence(tabs).find((g) => g.tabIds.includes(active.id!));
  if (!cur) return;

  const targetTabId = resolveTargetTab(cur, active.id, direction);
  if (targetTabId === null) return;
  await chrome.tabs.update(targetTabId, { active: true });
}

async function handleCommand(command: string): Promise<void> {
  console.log(`[vipper] command received: ${command}`);
  if (command === 'group-prev') await switchGroup(-1);
  if (command === 'group-next') await switchGroup(1);
  if (command === 'tab-prev') await switchTab(-1);
  if (command === 'tab-next') await switchTab(1);
}

export default defineBackground(() => {
  trackLastActiveTab();
  chrome.commands.onCommand.addListener((command) => void handleCommand(command));

  // chrome.commands 无编程触发 API，暴露给 CDP 自动化验收脚本驱动
  (globalThis as Record<string, unknown>).__vipper = { dispatch: handleCommand };
});
