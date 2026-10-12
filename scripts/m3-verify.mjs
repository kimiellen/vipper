/**
 * M3 自动化验收：Alt+. 书签弹窗全流程。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言：
 * - 弹窗打开、搜索栏自动聚焦
 * - 关键字检索过滤
 * - ↓ 进入列表、方向键移动
 * - 单 URL 书签 Enter 直接打开到来源组
 * - 多 URL 书签 Enter 进入二级菜单，选择后打开对应 URL
 * - 打开后弹窗自动关闭
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景：来源标签放进组 G0；种子书签（单 URL / 多 URL / 无关项）----
const setup = JSON.parse(await sw(`(async () => {
  const KEY = 'vault:bookmarks';
  await chrome.storage.local.set({ [KEY]: [
    { id: 'b1', title: 'GitHub', urls: ['about:blank#gh-login'], createdAt: 1 },
    { id: 'b2', title: 'Dev Portal', urls: ['about:blank#dev-a', 'about:blank#dev-b'], createdAt: 2 },
    { id: 'b3', title: 'Mail', urls: ['about:blank#mail'], createdAt: 3 },
  ] });
  const win = await chrome.windows.getCurrent();
  const [t0] = await chrome.tabs.query({ windowId: win.id });
  const g0 = await chrome.tabs.group({ tabIds: [t0.id] });
  await chrome.tabs.update(t0.id, { active: true });
  return JSON.stringify({ win: win.id, source: t0.id, g0 });
})()`));
console.log('场景就绪:', JSON.stringify(setup));

// ---- 呼出弹窗 ----
await sw(`__vipper.dispatch('open-launcher')`);
const page = await attachPage('launcher.html');
// 等页面脚本加载完成
for (let i = 0; i < 20; i++) {
  if (await page(`!!document.querySelector('#list li')`).catch(() => false)) break;
  await sleep(250);
}

check('弹窗打开且搜索栏自动聚焦', await page(`document.activeElement?.id === 'search'`));

// ---- 检索过滤 ----
await page(`(() => {
  const s = document.querySelector('#search');
  s.value = 'dev';
  s.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(100);
check("检索 'dev'：过滤后仅剩 1 条（Dev Portal）", await page(`document.querySelectorAll('#list li').length === 1`));

// ---- ↓ 进入列表 + 多 URL 钻取 ----
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
check('↓ 进入条目区并选中第 1 项', await page(`document.querySelector('#list li.selected span')?.textContent === 'Dev Portal'`));

await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(100);
check('Enter 多 URL 书签：进入二级菜单（2 个 URL）', await page(`document.querySelectorAll('#list li').length === 2`));

await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(400);

// ---- 断言新标签开在来源组 G0、URL 正确、弹窗已关闭 ----
const opened = JSON.parse(await sw(`(async () => {
  const tabs = await chrome.tabs.query({ windowId: ${setup.win} });
  const t = tabs.find((t) => (t.url || '').includes('dev-b'));
  return JSON.stringify(t ? { url: t.url, groupId: t.groupId, active: t.active } : null);
})()`));
check('二级菜单选中第 2 个 URL 并打开', opened?.url?.includes('dev-b'), opened);
check('新标签在来源组 G0 中', opened?.groupId === setup.g0, opened);
check('弹窗已自动关闭', !hasPage('launcher.html'));

// ---- 单 URL 书签直接打开（无二级菜单）----
await sw(`__vipper.dispatch('open-launcher')`);
const page2 = await attachPage('launcher.html');
for (let i = 0; i < 20; i++) {
  if (await page2(`!!document.querySelector('#list li')`).catch(() => false)) break;
  await sleep(250);
}
await page2(`(() => {
  const s = document.querySelector('#search');
  s.value = 'git';
  s.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await page2(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await page2(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(400);
const opened2 = JSON.parse(await sw(`(async () => {
  const tabs = await chrome.tabs.query({ windowId: ${setup.win} });
  const t = tabs.find((t) => (t.url || '').includes('gh-login'));
  return JSON.stringify(t ? { url: t.url, groupId: t.groupId } : null);
})()`));
check('单 URL 书签 Enter 直接打开到来源组', opened2?.url?.includes('gh-login') && opened2?.groupId === setup.g0, opened2);

summary();
close();
