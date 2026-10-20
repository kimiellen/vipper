import { buildGroupSequence, resolveTargetGroup, resolveTargetTab, UNGROUPED } from '../utils/tabnav';
import { hostnameOf, matchUrl } from '../utils/matchUrl';
import { PASSWORD_SELECTOR, USERNAME_CANDIDATE_SELECTOR } from '../utils/loginForm';
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

async function findLauncherWindow(): Promise<chrome.windows.Window | undefined> {
  const wuiUrl = chrome.runtime.getURL('wui.html');
  return (await chrome.windows.getAll({ populate: true }))
    .find((w) => w.tabs?.some((t) => t.url === wuiUrl));
}

async function createLauncher(): Promise<void> {
  const wuiUrl = chrome.runtime.getURL('wui.html');
  // 记录来源标签（窗口 + 所在组），供"回车在来源组打开"使用
  const [source] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (source?.windowId !== undefined && source.url !== wuiUrl) {
    await chrome.storage.session.set({
      launcherSource: {
        windowId: source.windowId,
        groupId: source.groupId === UNGROUPED ? null : source.groupId,
      },
    });
  }
  await chrome.windows.create({
    url: wuiUrl,
    type: 'popup',
    width: 1600,
    height: 900,
    focused: true,
  });
}

/** Alt+.：呼出 wui 管理页。已打开时纯 toggle 关闭（spec 2026-10-15：Wayland 唤回聚焦不可靠，失焦时连按两次关+开即可重获焦点） */
async function openLauncher(): Promise<void> {
  const existing = await findLauncherWindow();
  if (existing?.id !== undefined) {
    await chrome.windows.remove(existing.id);
    return;
  }
  await createLauncher();
}

/** 锁定态 Alt+P：打开或聚焦 wui 解锁页，不 toggle（避免把已打开的解锁页关掉） */
async function showLauncher(): Promise<void> {
  const existing = await findLauncherWindow();
  if (existing?.id !== undefined) {
    try {
      await chrome.windows.update(existing.id, { focused: true });
    } catch { /* headless 不支持聚焦时忽略 */ }
    return;
  }
  await createLauncher();
}

/** 指定 frame 无 content script（扩展重载前打开的页面 / 注入时序窗口）时补注入 */
async function injectContentScript(tabId: number, frameId: number): Promise<boolean> {
  const target = { tabId, frameIds: [frameId] };
  try {
    await chrome.scripting.insertCSS({ target, files: ['content-scripts/content.css'] });
  } catch { /* CSS 失败不阻塞 JS 注入 */ }
  try {
    await chrome.scripting.executeScript({ target, files: ['content-scripts/content.js'] });
    return true;
  } catch {
    return false; // chrome:// 等不可注入页面
  }
}

/** 向指定 frame（默认顶层）发消息；无接收方时补注入，再等监听就绪后重试。返回是否送达 */
async function safeSend(tabId: number, msg: unknown, frameId = 0): Promise<boolean> {
  const target = { frameId };
  try {
    await chrome.tabs.sendMessage(tabId, msg, target);
    return true;
  } catch (err) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(err))) return false;
  }
  if (!(await injectContentScript(tabId, frameId))) return false;
  // 注入的 content script 经 requestIdleCallback 启动，等待监听就绪后重试
  for (let i = 0; i < 5; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, msg, target);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

// ---------- 登录提交自动保存（spec 2026-10-20） ----------

/** pending 只存在 SW 内存：不写 storage、不进日志；SW 回收即丢（此时不弹，不会写错数据） */
const LOGIN_PENDING_TTL_MS = 120_000;

interface LoginPending {
  username: string;
  password: string;
  pageUrl: string;
  title: string;
  capturedAt: number;
  prompted: boolean;
}

const loginPending = new Map<number, LoginPending>();
const loginStats = { captures: 0, navigationEvents: 0, prompts: 0, pushFailures: 0 };
let loginWatchAttached = false;

function onLoginTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void {
  if (changeInfo.status !== 'complete') return;
  if (!loginPending.has(tabId)) return;
  loginStats.navigationEvents++;
  void pushLoginPrompt(tabId);
}

function onLoginTabRemoved(tabId: number): void {
  clearLoginPending(tabId);
}

/** 只有存在 pending 时才挂导航监听，避免普通页面加载/关标签唤醒 SW */
function ensureLoginWatch(): void {
  if (loginWatchAttached) return;
  loginWatchAttached = true;
  chrome.tabs.onUpdated.addListener(onLoginTabUpdated);
  chrome.tabs.onRemoved.addListener(onLoginTabRemoved);
}

function dropLoginWatchIfIdle(): void {
  if (!loginWatchAttached || loginPending.size > 0) return;
  loginWatchAttached = false;
  chrome.tabs.onUpdated.removeListener(onLoginTabUpdated);
  chrome.tabs.onRemoved.removeListener(onLoginTabRemoved);
}

function clearLoginPending(tabId: number): void {
  loginPending.delete(tabId);
  dropLoginWatchIfIdle();
}

function loginTitle(p: LoginPending): string {
  return p.title || hostnameOf(p.pageUrl);
}

async function handleLoginCapture(tab: chrome.tabs.Tab, msg: Record<string, unknown>): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  const username = typeof msg.username === 'string' ? msg.username.trim() : '';
  const password = typeof msg.password === 'string' ? msg.password : '';
  const frameUrl = typeof msg.pageUrl === 'string' ? msg.pageUrl : '';
  const isTop = msg.top === true;
  // 顶层 frame 用提交时的 location；iframe 用 tab.url（顶层登录页地址），跨域 iframe 读不到 top.location
  const pageUrl = isTop ? frameUrl : tab.url ?? frameUrl;
  if (!username || !password) return;
  if (!/^https?:/i.test(pageUrl)) return;
  if (!(await keychain.isUnlocked())) return; // 锁定态静默丢弃，不暂存明文等解锁

  const prev = loginPending.get(tabId);
  if (
    prev &&
    prev.username === username &&
    prev.password === password &&
    prev.pageUrl === pageUrl &&
    Date.now() - prev.capturedAt < 2000
  ) return; // click 与 submit 属于同一次提交

  const title = isTop
    ? (typeof msg.title === 'string' ? msg.title.trim() : '')
    : (tab.title ?? (typeof msg.title === 'string' ? msg.title : '')).trim();
  loginPending.set(tabId, {
    username,
    password,
    pageUrl,
    title,
    capturedAt: Date.now(),
    prompted: false,
  });
  loginStats.captures++;
  ensureLoginWatch();
  // 导航可能在监听注册完成前就结束（提交 → SW 处理有 await），兜底 1.2s 再推一次；
  // SPA / 失败登录（URL 不变）也由这里覆盖，与页面侧 1s 自取互为备份。
  setTimeout(() => void pushLoginPrompt(tabId), 1200);
}

async function pushLoginPrompt(tabId: number): Promise<void> {
  const p = loginPending.get(tabId);
  if (!p || p.prompted) return;
  if (Date.now() - p.capturedAt > LOGIN_PENDING_TTL_MS) {
    clearLoginPending(tabId);
    return;
  }
  if (!(await keychain.isUnlocked())) {
    clearLoginPending(tabId);
    return;
  }

  const matched = (await vault.listIndex()).filter(
    (e) => e.status === 'active' && e.urls.some((u) => matchUrl(u.match, u.url, p.pageUrl)),
  );
  // M22 只接无匹配的新建；有匹配的追加（含同 username 静默）由 M23 接上
  if (matched.length > 0) {
    clearLoginPending(tabId);
    return;
  }

  const [tags, links, settings] = await Promise.all([
    vault.listTags(),
    vault.listLinkedInfos(),
    keychain.getSettings(),
  ]);
  p.prompted = true;
  const ok = await safeSend(
    tabId,
    {
      type: 'vipper:save-prompt',
      kind: 'new',
      title: loginTitle(p),
      url: p.pageUrl,
      username: p.username,
      tags,
      links,
      lang: settings.lang,
      theme: settings.theme,
    },
    0, // 登录表单可能在 iframe 内，弹窗只发顶层 frame
  );
  if (ok) loginStats.prompts++;
  else {
    loginStats.pushFailures++;
    clearLoginPending(tabId);
  }
}

/** 只接受仍存在于管理表的 id，避免选中后表被删导致悬空引用 */
function selectedIds(value: unknown, existing: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((v): v is string => typeof v === 'string'));
  return existing.filter((id) => wanted.has(id));
}

async function handleLoginSave(tabId: number, msg: Record<string, unknown>): Promise<void> {
  const p = loginPending.get(tabId);
  if (!p) {
    await safeSend(tabId, { type: 'vipper:save-result', ok: false, message: 'session expired' }, 0);
    return;
  }
  if (msg.action === 'discard') {
    clearLoginPending(tabId);
    return;
  }
  if (msg.action !== 'save') return;

  const title = (typeof msg.title === 'string' ? msg.title.trim() : '') || loginTitle(p);
  const [tagTable, linkTable] = await Promise.all([vault.listTags(), vault.listLinkedInfos()]);
  try {
    await vault.addBookmark({
      title,
      urls: [{ url: p.pageUrl, match: 'host' }],
      tags: selectedIds(msg.tags, tagTable.map((t) => t.id)),
      linkedInfos: selectedIds(msg.linkedInfos, linkTable.map((l) => l.id)),
      accounts: [{ username: p.username, password: p.password }],
      remarks: '',
    });
    clearLoginPending(tabId);
    await safeSend(tabId, { type: 'vipper:save-result', ok: true }, 0);
  } catch (err) {
    // 失败保留 pending：解锁/存储恢复后用户可再点保存
    await safeSend(tabId, { type: 'vipper:save-result', ok: false, message: String(err) }, 0);
  }
}

interface FrameFields {
  password: boolean;
  username: boolean;
}

/**
 * 定位承载登录表单的 frame，返回 frameId（找不到回落 0，由顶层提示「未找到登录表单」）。
 * 表单可能在跨域 iframe 内，顶层 document 跨域查不到，只能让浏览器在每个 frame 各跑一次探测：
 * 有可见密码框的 frame 优先，其次有可见账号框的 frame（同分按 frameId，顶层在前）。
 */
async function findFillFrame(tabId: number): Promise<number> {
  let results: chrome.scripting.InjectionResult<FrameFields>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [PASSWORD_SELECTOR, USERNAME_CANDIDATE_SELECTOR],
      func: (passwordSel: string, candidateSel: string): FrameFields => {
        const visible = (el: HTMLElement): boolean =>
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const hasVisible = (sel: string): boolean =>
          [...document.querySelectorAll<HTMLInputElement>(sel)].some((el) => !el.disabled && visible(el));
        // 隐藏的诱饵密码框（如 163 邮箱）不算登录表单
        return {
          password: hasVisible(passwordSel),
          username: hasVisible(candidateSel),
        };
      },
    });
  } catch {
    return 0; // 不可注入页面
  }
  const probes = results
    .flatMap((r) => (r.result ? [{ frameId: r.frameId, ...r.result }] : []))
    .sort((a, b) => a.frameId - b.frameId);
  return probes.find((p) => p.password)?.frameId ?? probes.find((p) => p.username)?.frameId ?? 0;
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

/** 解密指定账号并定向下发填充（明文只在消息里过境），随后刷新 lastUsedAt */
async function fillAccount(tabId: number, bookmarkId: string, accountIndex: number): Promise<void> {
  const b = await vault.getBookmarkDecrypted(bookmarkId);
  const a = b?.accounts[accountIndex];
  if (!a) return;
  await safeSend(
    tabId,
    { type: 'vipper:fill', username: a.username, password: a.password },
    await findFillFrame(tabId),
  );
  await vault.touchLastUsed(bookmarkId);
}

/** Alt+P：当前页面主动填充；锁定则打开 wui 解锁页 */
async function handleAutofill(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return;
  if (!(await keychain.isUnlocked())) {
    await showLauncher();
    return;
  }
  await sendCandidates(tab.id, tab.url);
}

/** wui 管理页与 content script 的消息入口 */
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
          // 先关闭 wui 弹窗再入组：headless Chromium 有 popup 在场时分组会失败的 quirk，
          // 真机顺序无关，但先关窗对用户也无感知差异（新标签已激活）
          if (sender.tab?.windowId !== undefined) await chrome.windows.remove(sender.tab.windowId);
          try {
            await chrome.tabs.group({ groupId: launcherSource.groupId, tabIds: [tab.id] });
          } catch { /* 组已不存在则放弃入组 */ }
        } else if (sender.tab?.windowId !== undefined) {
          await chrome.windows.remove(sender.tab.windowId);
        }
        if (msg.bookmarkId) await vault.touchLastUsed(msg.bookmarkId);
      })();
    }
    // content script：二级菜单选定后请求填充
    if (msg?.type === 'vipper:fill-request' && sender.tab?.id !== undefined) {
      void fillAccount(sender.tab.id, msg.bookmarkId, msg.accountIndex);
    }
    // content script：登录提交捕获 / SPA 无导航时请求推送 / 弹窗保存
    if (msg?.type === 'vipper:login-capture' && sender.tab) {
      void handleLoginCapture(sender.tab, msg);
    }
    if (msg?.type === 'vipper:save-prompt-request' && sender.tab?.id !== undefined) {
      void pushLoginPrompt(sender.tab.id);
    }
    if (msg?.type === 'vipper:login-save' && sender.tab?.id !== undefined) {
      void handleLoginSave(sender.tab.id, msg);
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
    login: {    // M22+ 验收：登录 pending 摘要（不含密码）
      pending: () =>
        [...loginPending.entries()].map(([tabId, p]) => ({
          tabId,
          username: p.username,
          prompted: p.prompted,
          capturedAt: p.capturedAt,
        })),
      stats: () => ({ ...loginStats }),
    },
  };
});
