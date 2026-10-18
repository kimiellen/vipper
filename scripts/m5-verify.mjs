/**
 * M5 自动化验收：Alt+P 填充全流程。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 内嵌 HTTP 服务器提供登录测试页（127.0.0.1:8377 /login 与 /other，均含登录表单）。
 * 浮层是 closed shadow DOM，断言走行为路径（填充结果），键盘用 CDP Input 可信事件。
 *
 * 断言：
 * - exact 匹配：/login 命中多账号 → 二级菜单 ↓ 选中第 2 个账号填充
 * - exact 不匹配：/other 提示无匹配、不填充
 * - host 匹配：/other 命中单账号 → 直接填充（无菜单）
 * - 锁定引导：Alt+P 弹 wui 解锁页且不填充；解锁后再按 Alt+P 出现菜单并可填充
 * - 填充后 lastUsedAt 更新
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const FORM = `<!doctype html><html><body>
<input id="u" name="username" type="text" />
<input id="p" name="password" type="password" />
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(FORM);
});
await new Promise((r) => server.listen(8377, '127.0.0.1', r));

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

const key = (k, code, vk) => ({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
const ENTER = key('Enter', 'Enter', 13);
const DOWN = key('ArrowDown', 'ArrowDown', 40);

async function openTab(url) {
  const tabId = await sw(`(async () => {
    const win = await chrome.windows.getCurrent();
    const t = await chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(url)}, active: true });
    return t.id;
  })()`);
  await sleep(900); // 等页面加载 + content script 注入
  return tabId;
}

async function readForm(urlPart) {
  const page = await attachPage(urlPart);
  return page(`JSON.stringify({ u: document.querySelector('#u')?.value, p: document.querySelector('#p')?.value })`)
    .then(JSON.parse);
}

// ---- 场景数据 ----
await sw(`__vipper.keychain.setupMasterPassword('m5-test')`);
const bmA = await sw(`(async () => {
  const b = await __vipper.vault.addBookmark({
    title: 'LocalExact',
    urls: [{ url: 'http://127.0.0.1:8377/login', match: 'exact' }],
    accounts: [
      { username: 'alice', password: 'p1' },
      { username: 'bob', password: 'p2' },
    ],
  });
  return b.id;
})()`);

// ---- 1. exact 匹配 + 多账号二级菜单 ----
await openTab('http://127.0.0.1:8377/login');
await sw(`__vipper.dispatch('autofill')`);
await sleep(400);
let page = await attachPage('/login');
await page.send('Input.dispatchKeyEvent', DOWN);   // 选中第 2 个账号（bob）
await page.send('Input.dispatchKeyEvent', ENTER);
await sleep(500);
let form = await readForm('/login');
check('二级菜单 ↓+Enter 填充第 2 个账号', form.u === 'bob' && form.p === 'p2', form);

// ---- 2. exact 不匹配：/other 无填充 ----
await openTab('http://127.0.0.1:8377/other');
await sw(`__vipper.dispatch('autofill')`);
await sleep(400);
form = await readForm('/other');
check('exact 不匹配的页面不填充', form.u === '' && form.p === '', form);

// ---- 3. host 匹配单账号：直接填充 ----
await sw(`__vipper.vault.addBookmark({
  title: 'LocalHost',
  urls: [{ url: 'http://127.0.0.1:8377/login', match: 'host' }],
  accounts: [{ username: 'carol', password: 'p3' }],
})`);
await openTab('http://127.0.0.1:8377/other#host');
await sw(`__vipper.dispatch('autofill')`);
await sleep(500);
form = await readForm('/other#host');
check('host 匹配单账号直接填充', form.u === 'carol' && form.p === 'p3', form);

// ---- 4. 锁定引导：Alt+P 弹 wui 解锁页 → 解锁 → 再按 Alt+P 填充 ----
await sw(`__vipper.keychain.lock()`);
await openTab('http://127.0.0.1:8377/login#locked');
await sw(`__vipper.dispatch('autofill')`);
await sleep(600);
check('锁定状态 Alt+P 打开 wui 解锁页', hasPage('wui.html'), hasPage('wui.html'));
form = await readForm('/login#locked');
check('锁定状态不填充登录页', form.u === '' && form.p === '', form);

// 关掉 wui（解锁页 UI 流程由 m9d 覆盖），直接解锁后重试 Alt+P
await sw(`(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.tabs?.some((t) => t.url === chrome.runtime.getURL('wui.html')) && w.id !== undefined) {
      await chrome.windows.remove(w.id);
    }
  }
  const tabs = await chrome.tabs.query({});
  const login = tabs.find((t) => t.url?.includes('/login#locked'));
  if (login?.id !== undefined) {
    await chrome.tabs.update(login.id, { active: true });
    if (login.windowId !== undefined) await chrome.windows.update(login.windowId, { focused: true }).catch(() => {});
  }
})()`);
await sw(`__vipper.keychain.unlock('m5-test')`);
await sw(`__vipper.dispatch('autofill')`);
await sleep(400); // 等候选菜单出现
page = await attachPage('/login#locked');
await page.send('Input.dispatchKeyEvent', ENTER); // 选第 1 个账号（alice）
await sleep(800);
form = await readForm('/login#locked');
check('解锁后再次 Alt+P 填充第 1 个账号', form.u === 'alice' && form.p === 'p1', form);

// ---- 5. lastUsedAt 更新 ----
const lastUsed = await sw(`(async () => {
  const idx = await __vipper.vault.listIndex();
  return idx.find((e) => e.id === '${bmA}')?.lastUsedAt ?? 0;
})()`);
check('填充后 lastUsedAt 已更新', typeof lastUsed === 'number' && lastUsed > 0 && Date.now() - lastUsed < 60_000, lastUsed);

summary();
server.close();
close();
