/**
 * M9d 自动化验收：解锁页三态路由 + Alt+. 入口切换到 wui 管理页。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 未初始化打开 wui → 创建主密码模式（双输入框 + 警示）；创建成功动画后进主页面
 * - 锁定后重开 → 解锁模式；错误密码报错；正确密码进主页面
 * - 已解锁时 Alt+. 直达主页面（无覆盖层）
 * - 键盘：↓ 选中、Enter 多 URL 弹二级菜单、选中打开到来源组、窗口自动关闭
 * - 单 URL 书签 Enter 直接打开到来源组
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 0. 场景：来源标签放进组 G0（headless quirk：popup 窗口在场时分组会失败，必须在开 wui 前完成）----
const setup = JSON.parse(await sw(`(async () => {
  const win = await chrome.windows.getCurrent();
  const [t0] = await chrome.tabs.query({ windowId: win.id });
  const g0 = await chrome.tabs.group({ tabIds: [t0.id] });
  await chrome.tabs.update(t0.id, { active: true });
  return JSON.stringify({ win: win.id, g0 });
})()`));

async function waitWui() {
  const page = await attachPage('wui.html');
  for (let i = 0; i < 20; i++) {
    if (await page(`document.readyState === 'complete'`).catch(() => false)) break;
    await sleep(250);
  }
  await sleep(300);
  return page;
}

// ---- 1. 首次打开：创建主密码模式 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
let page = await waitWui();
check('未初始化：显示覆盖层且为创建模式（确认框 + 警示可见）',
  await page(`!document.querySelector('#unlock-overlay').hidden
    && !document.querySelector('#ov-pw2').hidden
    && !document.querySelector('#ov-warning').hidden`));

await page(`(() => {
  document.querySelector('#ov-pw1').value = 'm9d-test';
  document.querySelector('#ov-pw2').value = 'm9d-test';
  document.querySelector('#ov-submit').click();
})()`);
await sleep(4500); // PBKDF2 ~1s + 成功动画 ~1.8s
check('创建成功：覆盖层移除，主界面就绪（搜索框聚焦）',
  await page(`!document.querySelector('#unlock-overlay') && document.activeElement?.id === 'search'`));
check('创建即解锁', await sw(`__vipper.keychain.isUnlocked()`) === true);

// ---- 种子书签 ----
await sw(`(async () => {
  const mk = (title, urls) => __vipper.vault.addBookmark({ title, urls: urls.map((url) => ({ url, match: 'host' })) });
  await mk('GitHub', ['about:blank#gh-login']);
  await mk('Dev Portal', ['about:blank#dev-a', 'about:blank#dev-b']);
})()`);

// ---- 2. 锁定后重开：解锁模式 + 错误密码 ----
await sw(`__vipper.keychain.lock()`);
// 关掉第 1 部分的 wui 窗口，避免 attachPage 附着到旧窗口
await sw(`(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) if (w.tabs?.some((t) => t.url?.includes('wui.html'))) await chrome.windows.remove(w.id);
})()`);
await sleep(500);
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
page = await waitWui();
// 找到显示覆盖层的那个 wui 页面
const gateState = JSON.parse(await page(`JSON.stringify({
  overlay: !document.querySelector('#unlock-overlay')?.hidden,
  pw2Hidden: document.querySelector('#ov-pw2')?.hidden,
})`).catch(() => 'null'));
check('锁定后重开：解锁模式（确认框隐藏）', gateState && gateState.overlay && gateState.pw2Hidden === true, gateState);

await page(`(() => { document.querySelector('#ov-pw1').value = 'wrong'; document.querySelector('#ov-submit').click(); })()`);
await sleep(1500);
check('错误密码：报错可见', await page(`!document.querySelector('#ov-error').hidden && document.querySelector('#ov-error').textContent.includes('错误')`));

await page(`(() => { document.querySelector('#ov-pw1').value = 'm9d-test'; document.querySelector('#ov-submit').click(); })()`);
await sleep(4500);
check('正确密码：解锁进主页面', await page(`!document.querySelector('#unlock-overlay') && document.activeElement?.id === 'search'`));
// 关闭第 2 部分的窗口，避免干扰后续 hasPage 断言与分组 quirk
await sw(`(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) if (w.tabs?.some((t) => t.url?.includes('wui.html'))) await chrome.windows.remove(w.id);
})()`);
await sleep(500);

// ---- 3. Alt+. 入口（已解锁直达）+ 键盘打开 ----
// 焦点切回来源窗口（open-launcher 以 currentWindow 为来源）
await sw(`chrome.windows.update(${setup.win}, { focused: true })`);
await sw(`__vipper.dispatch('open-launcher')`);
page = await waitWui();
check('Alt+. 已解锁直达主页面（无覆盖层）',
  await page(`!document.querySelector('#unlock-overlay') && document.activeElement?.id === 'search'`));
// 回归：hidden 属性必须真实隐藏（display:flex 曾压过 hidden 导致遮罩常驻、页面不可操作）
check('二级菜单遮罩初始不可见（计算样式 display:none）',
  await page(`getComputedStyle(document.querySelector('#url-menu')).display === 'none'`));

// ---- Alt+. 纯 toggle：已打开（无论聚焦与否）再按 = 关闭；再按 = 重开 ----
await sw(`__vipper.dispatch('open-launcher')`);
await sleep(500);
check('已打开时再按 Alt+.：关闭窗口（纯 toggle）', !hasPage('wui.html'));
await sw(`__vipper.dispatch('open-launcher')`);
await sleep(300);
page = await waitWui();
check('再按 Alt+.：重新呼出', await page(`document.activeElement?.id === 'search'`));

// 搜索 dev → ↓ 选中 → Enter → 二级菜单 → ↓ Enter 打开第 2 个 URL
await page(`(() => { const s = document.querySelector('#search'); s.value = 'dev'; s.dispatchEvent(new Event('input')); })()`);
await sleep(200);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
check('↓ 选中 Dev Portal', await page(`document.querySelector('#results-body tr.row-selected td:nth-child(2)')?.textContent === 'Dev Portal'`));
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(200);
check('Enter 多 URL 书签：弹二级菜单（2 项）',
  await page(`!document.querySelector('#url-menu').hidden && document.querySelectorAll('#url-menu-card .menu-item').length === 2`));
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(600);

const opened = JSON.parse(await sw(`(async () => {
  const tabs = await chrome.tabs.query({ windowId: ${setup.win} });
  const t = tabs.find((t) => (t.url || '').includes('dev-b'));
  return JSON.stringify(t ? { url: t.url, groupId: t.groupId } : null);
})()`));
check('二级菜单选中第 2 个 URL 打开到来源组', opened?.url?.includes('dev-b') && opened?.groupId === setup.g0, opened);
check('打开后 wui 窗口自动关闭', !hasPage('wui.html'));

// ---- 4. 单 URL 书签直接打开 ----
await sleep(600);
await sw(`chrome.windows.update(${setup.win}, { focused: true })`);
await sw(`__vipper.dispatch('open-launcher')`);
page = await waitWui();
await page(`(() => { const s = document.querySelector('#search'); s.value = 'git'; s.dispatchEvent(new Event('input')); })()`);
await sleep(200);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(600);
const opened2 = JSON.parse(await sw(`(async () => {
  const tabs = await chrome.tabs.query({ windowId: ${setup.win} });
  const t = tabs.find((t) => (t.url || '').includes('gh-login'));
  return JSON.stringify(t ? { url: t.url, groupId: t.groupId } : null);
})()`));
check('单 URL 书签 Enter 直接打开到来源组（无二级菜单）', opened2?.url?.includes('gh-login') && opened2?.groupId === setup.g0, opened2);

summary();
close();
