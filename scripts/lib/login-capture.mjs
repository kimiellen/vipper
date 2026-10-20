/**
 * 登录自动保存验收共享驱动（m22 / m23）。
 *
 * 页面探针经 chrome.scripting.executeScript 运行在 content script 的 isolated world，
 * 因此能读取 closed shadow DOM 暴露的调试状态；填充/提交走页面 DOM，不依赖真实鼠标。
 * 测试页约定：#u 账号、#p 密码、#f 表单、#go 登录/注册按钮。
 */

import { sleep } from './sw-driver.mjs';

const READY = '() => !!globalThis.__vipperContentLoaded';
const READ_CARD = '() => globalThis.__vipperContent?.saveCard() ?? { visible: false }';
const READ_STATS = '() => globalThis.__vipperContent?.stats() ?? null';
const READ_VALUES = `() => ({
  u: document.querySelector('#u')?.value ?? null,
  p: document.querySelector('#p')?.value ?? null,
})`;

export function createLoginDriver(sw) {
  async function evalInPage(tabId, func, args = []) {
    const results = await sw(
      `chrome.scripting.executeScript({ target: { tabId: ${tabId}, frameIds: [0] }, func: ${func}, args: ${JSON.stringify(args)} })`,
    );
    return results?.[0]?.result;
  }

  async function waitReady(tabId) {
    for (let i = 0; i < 40; i++) {
      if (await evalInPage(tabId, READY)) return;
      await sleep(150);
    }
    throw new Error('content script 未就绪');
  }

  async function openTab(url) {
    const tabId = await sw(`(async () => {
      const win = await chrome.windows.getCurrent();
      const t = await chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(url)}, active: true });
      return t.id;
    })()`);
    await waitReady(tabId);
    return tabId;
  }

  async function waitCard(tabId, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const card = await evalInPage(tabId, READ_CARD);
      if (card?.visible) return card;
      await sleep(150);
    }
    return null;
  }

  async function waitUntil(fn, timeout = 4000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      last = await fn();
      if (last) return last;
      await sleep(120);
    }
    return last;
  }

  async function fill(tabId, user, pass) {
    await evalInPage(
      tabId,
      `(u, p) => {
        const a = document.querySelector('#u');
        const b = document.querySelector('#p');
        if (a) a.value = u;
        if (b) b.value = p;
      }`,
      [user, pass],
    );
  }

  async function submit(tabId) {
    await evalInPage(tabId, `() => {
      const f = document.querySelector('#f');
      if (f instanceof HTMLFormElement) f.requestSubmit();
    }`);
  }

  async function patchCard(tabId, patch) {
    return evalInPage(tabId, `(patch) => globalThis.__vipperContent?.setSaveCard(patch) ?? false`, [patch]);
  }

  async function clickSave(tabId) {
    return evalInPage(tabId, `() => globalThis.__vipperContent?.save() ?? false`);
  }

  async function clickCancel(tabId) {
    return evalInPage(tabId, `() => globalThis.__vipperContent?.cancel() ?? false`);
  }

  const readCard = (tabId) => evalInPage(tabId, READ_CARD);
  const readStats = (tabId) => evalInPage(tabId, READ_STATS);
  const readValues = (tabId) => evalInPage(tabId, READ_VALUES);

  const listIndex = async () =>
    JSON.parse(await sw(`(async () => JSON.stringify(await __vipper.vault.listIndex()))()`));
  const pending = async () => sw(`__vipper.login.pending()`);

  return {
    evalInPage, waitReady, openTab, waitCard, waitUntil,
    fill, submit, patchCard, clickSave, clickCancel,
    readCard, readStats, readValues, listIndex, pending,
  };
}
