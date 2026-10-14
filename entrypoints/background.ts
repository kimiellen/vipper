import { buildGroupSequence, resolveTargetGroup, resolveTargetTab, UNGROUPED } from '../utils/tabnav';
import { matchUrl } from '../utils/matchUrl';
import * as keychain from '../utils/keychain';
import * as vault from '../utils/vault';

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

/** Alt+.：呼出书签管理弹窗。先记录来源标签（窗口 + 所在组），供"回车在来源组打开"使用 */
async function openLauncher(): Promise<void> {
  const [source] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (source?.windowId === undefined) return;
  await chrome.storage.session.set({
    launcherSource: {
      windowId: source.windowId,
      groupId: source.groupId === UNGROUPED ? null : source.groupId,
    },
  });
  await chrome.windows.create({
    url: chrome.runtime.getURL('launcher.html'),
    type: 'popup',
    width: 640,
    height: 480,
    focused: true,
  });
}

/** 向页面 content script 发消息；chrome:// 等无法注入的页面静默失败 */
async function safeSend(tabId: number, msg: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch { /* 页面无 content script */ }
}

interface Candidate { bookmarkId: string; accountIndex: number; text: string }

/** 按 URL 匹配规则找出当前页面可用的账号候选 */
async function sendCandidates(tabId: number, pageUrl: string): Promise<void> {
  const idx = await vault.listIndex();
  const matched = idx.filter(
    (e) => e.status === 'active' && e.urls.some((u) => matchUrl(u.match, u.url, pageUrl)),
  );
  const candidates: Candidate[] = [];
  for (const e of matched) {
    const b = await vault.getBookmark(e.id); // 密文形态即可：仅需账号数与展示名
    if (!b) continue;
    b.accounts.forEach((a, i) =>
      candidates.push({ bookmarkId: b.id, accountIndex: i, text: `${b.title} · ${a.username}` }),
    );
  }
  if (candidates.length === 0) {
    await safeSend(tabId, { type: 'vipper:toast', text: '无匹配书签' });
  } else if (candidates.length === 1) {
    const c = candidates[0]!;
    await fillAccount(tabId, c.bookmarkId, c.accountIndex);
  } else {
    await safeSend(tabId, { type: 'vipper:picker', candidates });
  }
}

/** 解密指定账号并下发填充（明文只在消息里过境），随后刷新 lastUsedAt */
async function fillAccount(tabId: number, bookmarkId: string, accountIndex: number): Promise<void> {
  const b = await vault.getBookmarkDecrypted(bookmarkId);
  const a = b?.accounts[accountIndex];
  if (!a) return;
  await safeSend(tabId, { type: 'vipper:fill', username: a.username, password: a.password });
  await vault.touchLastUsed(bookmarkId);
}

/** Alt+P：当前页面主动填充；未解锁则引导页面内解锁 */
async function handleAutofill(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return;
  if (!(await keychain.isUnlocked())) {
    await safeSend(tab.id, { type: 'vipper:locked' });
    return;
  }
  await sendCandidates(tab.id, tab.url);
}

/** launcher 与 content script 的消息入口 */
function handleMessages(): void {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'vipper:open') {
      void (async () => {
        const { launcherSource } = (await chrome.storage.session.get('launcherSource')) as {
          launcherSource?: { windowId: number; groupId: number | null };
        };
        if (!launcherSource) return;
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.create({
            windowId: launcherSource.windowId,
            url: msg.url,
            active: true,
          });
        } catch {
          // 来源窗口已失效（关闭/竞态），退化为在当前窗口打开
          tab = await chrome.tabs.create({ url: msg.url, active: true });
        }
        if (launcherSource.groupId !== null && tab.id !== undefined) {
          try {
            await chrome.tabs.group({ groupId: launcherSource.groupId, tabIds: [tab.id] });
          } catch { /* 组已不存在则放弃入组 */ }
        }
        if (sender.tab?.windowId !== undefined) await chrome.windows.remove(sender.tab.windowId);
        if (msg.bookmarkId) await vault.touchLastUsed(msg.bookmarkId);
      })();
    }
    if (msg?.type === 'vipper:close-launcher' && sender.tab?.windowId !== undefined) {
      void chrome.windows.remove(sender.tab.windowId);
    }
    // content script：浮层内解锁
    if (msg?.type === 'vipper:unlock' && sender.tab?.id !== undefined) {
      void (async () => {
        const tabId = sender.tab!.id!;
        const ok = await keychain.unlock(msg.password);
        if (!ok) {
          await safeSend(tabId, { type: 'vipper:unlock-failed' });
          return;
        }
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) await sendCandidates(tabId, tab.url);
      })();
    }
    // content script：二级菜单选定后请求填充
    if (msg?.type === 'vipper:fill-request' && sender.tab?.id !== undefined) {
      void fillAccount(sender.tab.id, msg.bookmarkId, msg.accountIndex);
    }
  });
}

async function handleCommand(command: string): Promise<void> {
  console.log(`[vipper] command received: ${command}`);
  if (command === 'group-prev') await switchGroup(-1);
  if (command === 'group-next') await switchGroup(1);
  if (command === 'tab-prev') await switchTab(-1);
  if (command === 'tab-next') await switchTab(1);
  if (command === 'open-launcher') await openLauncher();
  if (command === 'autofill') await handleAutofill();
}

/** 自动归档调度：浏览器启动时跑一次，之后每日一次（spec: 归档） */
function scheduleAutoArchive(): void {
  const run = () => void vault.autoArchive().catch(() => { /* 未初始化等情况忽略 */ });
  chrome.runtime.onStartup.addListener(run);
  chrome.alarms.create('vipper:auto-archive', { periodInMinutes: 24 * 60 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vipper:auto-archive') run(); });
}

export default defineBackground(() => {
  trackLastActiveTab();
  handleMessages();
  scheduleAutoArchive();
  chrome.commands.onCommand.addListener((command) => void handleCommand(command));

  // chrome.commands 无编程触发 API，暴露给 CDP 自动化验收脚本驱动
  (globalThis as Record<string, unknown>).__vipper = {
    dispatch: handleCommand,
    vault,      // M4+ 验收：凭据库 CRUD
    keychain,   // M4+ 验收：解锁/锁定/设置
  };
});
