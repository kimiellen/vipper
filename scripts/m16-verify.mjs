/**
 * M16 自动化验收：旧标签页（无 content script）的 Alt+P 自动补注入。
 *
 * 前置（特例）：Chromium 启动时**不要**加 --load-extension（页面必须先于扩展打开），
 * 但要加 --enable-unsafe-extension-debugging：
 *   HOME=$PWD/.fake-home chromium --headless=new --user-data-dir=$PWD/.chrome-test-profile \
 *     --remote-debugging-port=9333 --no-first-run --no-default-browser-check \
 *     --enable-unsafe-extension-debugging about:blank
 * 脚本会先打开登录页，再通过 CDP Extensions.loadUnpacked 动态加载 .output/chrome-mv3。
 *
 * 断言：
 * - 页面先于扩展打开时没有 content script（直接发消息无接收方）
 * - Alt+P 自动补注入 content script + 动画 CSS，完成账号→密码逐字填充
 * - 补注入后弹跳动画仍为 vipperfill / 200ms（证明 content.css 也补上了）
 */

import http from 'node:http';
import { resolve } from 'node:path';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const PORT = 9333;
const FORM = `<!doctype html><html><body>
<input id="u" name="username" type="text" />
<input id="p" name="password" type="password" />
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(FORM);
});
await new Promise((r) => server.listen(8380, '127.0.0.1', r));

/** 浏览器级 CDP：仅用于 Extensions.loadUnpacked */
async function connectBrowser(port = PORT) {
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const raw = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { raw, close: () => ws.close() };
}

/** 页面内预装记录器：逐字 input 值 + 弹跳动画名/时长 */
const RECORDER = `(() => {
  window.__seen = { u: [], p: [] };
  window.__typed = { u: [], p: [] };
  for (const id of ['u', 'p']) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => window.__typed[id].push(el.value));
    new MutationObserver(() => {
      if (!el.classList.contains('vipper-animated-fill')) return;
      const a = el.getAnimations()[0];
      window.__seen[id].push({
        animName: getComputedStyle(el).animationName,
        duration: a?.effect.getTiming().duration ?? null,
      });
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  return true;
})()`;

// ---- 1. 先打开登录页（此时扩展尚未加载，页面不会有 content script） ----
const pageTarget = await fetch(
  `http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8380/stale`,
  { method: 'PUT' },
).then((r) => r.json());
await sleep(800);
const { check, summary } = createChecker();
check('登录页先于扩展打开', pageTarget.type === 'page' && pageTarget.url.includes('/stale'), pageTarget.url);

// ---- 2. 动态加载扩展（等价于用户安装/重载扩展，旧页面不会补 content script） ----
const browser = await connectBrowser();
const loaded = await browser.raw('Extensions.loadUnpacked', { path: resolve('.output/chrome-mv3') });
check('扩展通过 CDP 动态加载成功', !loaded.error && !!loaded.result?.id, loaded);
await sleep(1500);

// ---- 3. 接上新扩展的 service worker ----
const { sw, attachPage, close } = await connectSW();
await sw(`__vipper.keychain.setupMasterPassword('m16-test')`);
await sw(`__vipper.vault.addBookmark({
  title: 'StaleTab',
  urls: [{ url: 'http://127.0.0.1:8380/stale', match: 'exact' }],
  accounts: [{ username: 'alice', password: 'p1' }],
})`);
const tabId = await sw(`(async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url?.includes('/stale'))?.id;
})()`);
check('找到先于扩展打开的标签页', typeof tabId === 'number', tabId);

const ping = await sw(`chrome.tabs.sendMessage(${tabId}, { type: 'vipper:ping' })
  .then(() => 'ok').catch((e) => 'no-receiver: ' + e.message)`);
check('旧标签页没有 content script（消息无接收方）', String(ping).startsWith('no-receiver'), ping);

let page = await attachPage('/stale');
await page(RECORDER);

// ---- 4. Alt+P：safeSend 补注入 + 填充 ----
await sw(`__vipper.dispatch('autofill')`);
await sleep(1200);

page = await attachPage('/stale');
const form = JSON.parse(await page(`JSON.stringify({ u: document.querySelector('#u').value, p: document.querySelector('#p').value })`));
const seen = JSON.parse(await page(`JSON.stringify(window.__seen)`));
const typed = JSON.parse(await page(`JSON.stringify(window.__typed)`));

check('旧标签页补注入后完成账号密码填充', form.u === 'alice' && form.p === 'p1', form);
check('补注入后账号逐字输入生效', typed.u.length >= 2 && typed.u.at(-1) === 'alice', typed.u);
check('补注入后密码逐字输入生效', typed.p.length >= 2 && typed.p.at(-1) === 'p1', typed.p);
for (const id of ['u', 'p']) {
  check(`#${id} 补注入的动画 CSS 生效（vipperfill / 200ms）`,
    seen[id].some((a) => a.animName === 'vipperfill' && a.duration === 200), seen[id]);
}

summary();
server.close();
browser.close();
close();
