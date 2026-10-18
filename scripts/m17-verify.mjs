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

const TOP_PAGE = `<!doctype html><html><body>
<iframe src="http://127.0.0.2:${FRAME_PORT}/login" style="width:420px;height:320px"></iframe>
</body></html>`;

const FORM = `<!doctype html><html><body>
<input id="u" name="username" type="text" autocomplete="username" />
<input id="p-decoy" type="password" style="display:none" />
<input id="p" name="password" type="password" />
</body></html>`;

const topServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(TOP_PAGE);
});
const frameServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(FORM);
});
await new Promise((r) => topServer.listen(TOP_PORT, '127.0.0.1', r));
await new Promise((r) => frameServer.listen(FRAME_PORT, '0.0.0.0', r));

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();
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

summary();
topServer.close();
frameServer.close();
close();
