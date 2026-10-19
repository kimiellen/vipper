/**
 * M17 自动化验收：登录表单位于跨域 iframe 时的 Alt+P 填充。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 拓扑：顶层页面 127.0.0.1:8378，登录表单在 127.0.0.2:8379 的 iframe 内
 * （hostname 不同 => 跨域，顶层 document 查不到字段，等价于 163 邮箱的 dl.reg.163.com iframe）。
 *
 * 断言：
 * - content script 注入 iframe（all_frames 生效）
 * - 顶层无输入框，Alt+P 仍能把账号密码填进 iframe
 * - 多账号菜单只在顶层 frame 展示，↓+Enter 后填充进 iframe
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const TOP_PORT = 8378;
const FRAME_PORT = 8379;

const TOP_PAGE = (offset) => `<!doctype html><html><body>
<div style="height:${offset}px">spacer</div>
<iframe src="http://127.0.0.2:${FRAME_PORT}/login" style="width:420px;height:320px"></iframe>
</body></html>`;

const FORM = `<!doctype html><html><body>
<input id="u" name="username" type="text" autocomplete="username" />
<input id="p-decoy" type="password" style="display:none" />
<input id="p" name="password" type="password" />
</body></html>`;

const topServer = http.createServer((req, res) => {
  const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset') ?? 0);
  res.setHeader('content-type', 'text/html');
  res.end(TOP_PAGE(offset));
});
const frameServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(FORM);
});
await new Promise((r) => topServer.listen(TOP_PORT, '127.0.0.1', r));
await new Promise((r) => frameServer.listen(FRAME_PORT, '0.0.0.0', r));

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// 清掉同一浏览器里上一次运行留下的测试标签，避免 attachPage 命中旧页面
await sw(`(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id !== undefined && t.url?.startsWith('http://127.0.0.1:${TOP_PORT}')) {
      await chrome.tabs.remove(t.id).catch(() => {});
    }
  }
})()`);

const key = (k, code, vk) => ({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
const DOWN = key('ArrowDown', 'ArrowDown', 40);
const ENTER = key('Enter', 'Enter', 13);

async function openTab(url) {
  const tabId = await sw(`(async () => {
    const win = await chrome.windows.getCurrent();
    const t = await chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(url)}, active: true });
    return t.id;
  })()`);
  return tabId;
}

/** 读所有 frame 的探针：URL、content script 是否注入、顶层 html 下挂载的浮层数、表单值 */
async function probe(tabId) {
  const results = await sw(`chrome.scripting.executeScript({
    target: { tabId: ${tabId}, allFrames: true },
    func: () => ({
      href: location.href,
      loaded: !!globalThis.__vipperContentLoaded,
      inputs: document.querySelectorAll('input').length,
      overlays: [...document.documentElement.children].filter((e) => e.tagName === 'DIV').length,
      u: document.querySelector('#u')?.value ?? null,
      p: document.querySelector('#p')?.value ?? null,
      decoy: document.querySelector('#p-decoy')?.value ?? null,
    }),
  })`);
  return results.map((r) => r.result).filter(Boolean);
}

async function waitFrameReady(tabId) {
  for (let i = 0; i < 40; i++) {
    const frames = await probe(tabId);
    const inFrame = frames.find((f) => f.href.includes('127.0.0.2:8379'));
    if (inFrame?.loaded && inFrame.inputs === 3) return frames;
    await sleep(250);
  }
  throw new Error('iframe 登录表单未就绪');
}

const formIn = (frames) => frames.find((f) => f.href.includes('127.0.0.2:8379'));
const topFrame = (frames) => frames.find((f) => f.href.includes('127.0.0.1:8378'));

// ---- 场景准备 ----
await sw(`__vipper.keychain.setupMasterPassword('m17-test')`);
await sw(`__vipper.vault.addBookmark({
  title: 'CrossFrameSingle',
  urls: [{ url: 'http://127.0.0.1:${TOP_PORT}/single', match: 'exact' }],
  accounts: [{ username: 'alice', password: 'p1' }],
})`);
await sw(`__vipper.vault.addBookmark({
  title: 'CrossFrameMulti',
  urls: [{ url: 'http://127.0.0.1:${TOP_PORT}/multi', match: 'exact' }],
  accounts: [
    { username: 'alice', password: 'p1' },
    { username: 'bob', password: 'p2' },
  ],
})`);

// ---- 1. 跨域 iframe：单账号直接填充 ----
let tabId = await openTab(`http://127.0.0.1:${TOP_PORT}/single`);
let frames = await waitFrameReady(tabId);
let top = topFrame(frames);
check('顶层 frame 没有登录字段（模拟 163：表单在 iframe 内）', top?.inputs === 0, top);
check('content script 注入跨域 iframe（all_frames 生效）', formIn(frames)?.loaded === true, formIn(frames));
check('填充前 iframe 字段为空', formIn(frames)?.u === '' && formIn(frames)?.p === '', formIn(frames));

await sw(`__vipper.dispatch('autofill')`);
await sleep(1600);
frames = await probe(tabId);
check('跨域 iframe 内完成账号填充', formIn(frames)?.u === 'alice', formIn(frames));
check('跨域 iframe 内完成密码填充', formIn(frames)?.p === 'p1', formIn(frames));
check('隐藏的诱饵密码框不被填充（163 同款 DOM）', formIn(frames)?.decoy === '', formIn(frames));
check('顶层无「未找到登录表单」误报（顶层未出现浮层）', topFrame(frames)?.overlays === 0, topFrame(frames));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 2. 多账号：菜单只在顶层出现，选定后填进 iframe ----
tabId = await openTab(`http://127.0.0.1:${TOP_PORT}/multi`);
frames = await waitFrameReady(tabId);
await sw(`__vipper.dispatch('autofill')`);
await sleep(500);
frames = await probe(tabId);
check('多账号菜单只在顶层 frame 展示', topFrame(frames)?.overlays === 1, topFrame(frames));
check('跨域 iframe 内不重复弹菜单', formIn(frames)?.overlays === 0, formIn(frames));

const page = await attachPage(`/multi`);
await page.send('Input.dispatchKeyEvent', DOWN);
await page.send('Input.dispatchKeyEvent', ENTER);
await sleep(1600);
frames = await probe(tabId);
check('菜单 ↓+Enter 选中的账号填入跨域 iframe', formIn(frames)?.u === 'bob', formIn(frames));
check('菜单选中的密码填入跨域 iframe', formIn(frames)?.p === 'p2', formIn(frames));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 3. 焦点在跨域 iframe 内：菜单必须接管焦点，方向键/回车才有效 ----
tabId = await openTab(`http://127.0.0.1:${TOP_PORT}/multi?focus=1`);
frames = await waitFrameReady(tabId);
const focused = await sw(`chrome.scripting.executeScript({
  target: { tabId: ${tabId}, allFrames: true },
  func: () => {
    const el = document.querySelector('#u');
    if (!el) return null;
    el.focus();
    return document.activeElement === el;
  },
})`);
check('焦点已进入跨域 iframe 的账号框', focused.some((f) => f.result === true), focused.map((f) => f.result));

await sw(`__vipper.dispatch('autofill')`);
await sleep(500);
frames = await probe(tabId);
check('焦点在 iframe 时菜单正常展示', topFrame(frames)?.overlays === 1, topFrame(frames));
const overlayFocused = await sw(`chrome.scripting.executeScript({
  target: { tabId: ${tabId} },
  func: () => document.activeElement === document.documentElement.lastElementChild,
})`);
check('菜单接管顶层焦点（否则按键仍留在 iframe）', overlayFocused[0].result === true, overlayFocused[0].result);

const picker = await attachPage('/multi?focus=1');
await picker.send('Input.dispatchKeyEvent', DOWN);
await picker.send('Input.dispatchKeyEvent', ENTER);
await sleep(1600);
frames = await probe(tabId);
check('焦点在 iframe 时 ↓+Enter 仍完成选择', formIn(frames)?.u === 'bob' && formIn(frames)?.p === 'p2', formIn(frames));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 4. iframe 完全滚出视口：Chrome 把 setTimeout 钳到 ~1s，填充仍应快速完成 ----
tabId = await openTab(`http://127.0.0.1:${TOP_PORT}/single?offset=5000`);
frames = await waitFrameReady(tabId);
const overlap = await sw(`chrome.scripting.executeScript({
  target: { tabId: ${tabId} },
  func: () => {
    const r = document.querySelector('iframe').getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  },
})`);
check('测试 iframe 与视口交集为 0（定时器会被节流）', overlap[0].result === 0, overlap[0].result);

const startedAt = Date.now();
await sw(`__vipper.dispatch('autofill')`);
let elapsed = 0;
for (let i = 0; i < 30; i++) {
  await sleep(100);
  frames = await probe(tabId);
  if (formIn(frames)?.p === 'p1') { elapsed = Date.now() - startedAt; break; }
}
check('定时器被节流时仍完成填充（未逐字空等）', formIn(frames)?.u === 'alice' && formIn(frames)?.p === 'p1', formIn(frames));
check('节流场景 2.5s 内完成（逐字等待会超过 20s）', elapsed > 0 && elapsed < 2500, elapsed);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

summary();
topServer.close();
frameServer.close();
close();
