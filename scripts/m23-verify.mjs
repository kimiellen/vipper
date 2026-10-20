/**
 * M23 自动化验收：登录提交自动保存——追加账号 + 多匹配 + 跨 frame / SPA。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，建议全新 profile）。
 *
 * 页面拓扑（同一 HTTP 服务监听 0.0.0.0:8390，用不同 loopback 地址区分站点，
 * 因为 matchUrl 的 host 规则只比较 hostname、不比较端口）：
 *   127.0.0.1 /login       → 跳转式追加
 *   127.0.0.2 /multi       → 两个匹配条目（lastUsedAt 不同）→ 下拉选择后追加
 *   127.0.0.3 /same        → 同 username                 → 静默、不改密码
 *   127.0.0.4 /frame       → 顶层页 + 127.0.0.5 iframe 表单 → 捕获在 frame、弹窗/URL 取顶层
 *   127.0.0.6 /spa         → SPA preventDefault + en 设置 → 追加文案跟随语言
 *   127.0.0.7 /click       → click 与 submit 双触发       → 只捕获一次
 *
 * 断言：追加弹窗条目/账号、默认最近条目、切换条目后追加正确、同 username 静默、
 *       跨域 iframe 顶层 URL 匹配、SPA 1s 推送、en appendTitle、双触发去重。
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { createLoginDriver } from './lib/login-capture.mjs';

const PORT = 8390;
const APPEND_HOST = '127.0.0.1';
const MULTI_HOST = '127.0.0.2';
const SAME_HOST = '127.0.0.3';
const FRAME_TOP_HOST = '127.0.0.4';
const FRAME_FORM_HOST = '127.0.0.5';
const SPA_HOST = '127.0.0.6';
const CLICK_HOST = '127.0.0.7';

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const loginForm = (action) => `<form id="f" action="${action}" method="get">
  <input id="u" name="username" type="text" autocomplete="username" />
  <input id="p" name="password" type="password" autocomplete="current-password" />
  <button id="go" type="submit">登录</button>
</form>`;

const spaForm = (path) => `${loginForm('')}
<script>
  document.querySelector('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    history.pushState({}, '', ${JSON.stringify(path)});
  });
</script>`;

const stayForm = `${loginForm('')}
<script>document.querySelector('#f').addEventListener('submit', (e) => e.preventDefault());</script>`;

const framePage = `<!doctype html><html><head><meta charset="utf-8"><title>M23 iframe 顶层</title></head><body>
<iframe src="http://${FRAME_FORM_HOST}:${PORT}/frame-form" style="width:420px;height:320px"></iframe>
</body></html>`;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const bodies = {
    '/login': html('M23 追加页', loginForm('/welcome')),
    '/welcome': html('M23 欢迎', '<h1>welcome</h1>'),
    '/multi': html('M23 多条目', spaForm('/multi-app')),
    '/same': html('M23 同账号', spaForm('/same-app')),
    '/frame': framePage,
    '/frame-form': html('M23 iframe 表单', stayForm),
    '/spa': html('M23 SPA', spaForm('/spa-app')),
    '/click': html('M23 双触发', stayForm),
  };
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(bodies[path] ?? html('M23', '<h1>ok</h1>'));
});
await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));

const { sw, close } = await connectSW();
const { check, summary } = createChecker();
const {
  openTab, waitCard, fill, submit, patchCard, clickSave, clickCancel,
  readCard, readStats, listIndex, pending,
} = createLoginDriver(sw);

async function accountsOf(id) {
  const b = JSON.parse(
    await sw(`(async () => JSON.stringify(await __vipper.vault.getBookmarkDecrypted(${JSON.stringify(id)})))()`),
  );
  return b?.accounts ?? [];
}

async function waitFrameReady(tabId, host) {
  for (let i = 0; i < 40; i++) {
    const results = await sw(`chrome.scripting.executeScript({
      target: { tabId: ${tabId}, allFrames: true },
      func: (h) => location.hostname === h && !!globalThis.__vipperContentLoaded,
      args: ${JSON.stringify([host])},
    })`);
    if (results?.some((r) => r.result === true)) return;
    await sleep(150);
  }
  throw new Error(`frame content script 未就绪: ${host}`);
}

async function frameFill(tabId, host, user, pass) {
  await sw(`chrome.scripting.executeScript({
    target: { tabId: ${tabId}, allFrames: true },
    func: (h, u, p) => {
      if (location.hostname !== h) return;
      const a = document.querySelector('#u');
      const b = document.querySelector('#p');
      if (a) a.value = u;
      if (b) b.value = p;
    },
    args: ${JSON.stringify([host, user, pass])},
  })`);
}

async function frameSubmit(tabId, host) {
  await sw(`chrome.scripting.executeScript({
    target: { tabId: ${tabId}, allFrames: true },
    func: (h) => {
      if (location.hostname !== h) return;
      const f = document.querySelector('#f');
      if (f instanceof HTMLFormElement) f.requestSubmit();
    },
    args: ${JSON.stringify([host])},
  })`);
}

// ---- 场景准备：全新存储 + 主密码 + 分站点种子条目 ----
await sw(`(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id !== undefined && t.url?.includes(':${PORT}')) await chrome.tabs.remove(t.id).catch(() => {});
  }
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await __vipper.keychain.setupMasterPassword('m23-test');
})()`);

const seed = JSON.parse(await sw(`(async () => {
  const mk = (title, host, path, accounts) => __vipper.vault.addBookmark({
    title,
    urls: [{ url: 'http://' + host + ':${PORT}' + path, match: 'host' }],
    accounts,
  });
  const nav = await mk('NavAppend', '${APPEND_HOST}', '/login', [{ username: 'alice', password: 'p-alice' }]);
  const old = await mk('MultiOld', '${MULTI_HOST}', '/multi', [{ username: 'alice', password: 'p-old' }]);
  await new Promise((r) => setTimeout(r, 20));
  const fresh = await mk('MultiNew', '${MULTI_HOST}', '/multi', [{ username: 'carol', password: 'p-new' }]);
  const same = await mk('SameUser', '${SAME_HOST}', '/same', [{ username: 'alice', password: 'p-same' }]);
  const frame = await mk('FrameAppend', '${FRAME_TOP_HOST}', '/frame', [{ username: 'alice', password: 'p-frame' }]);
  const spa = await mk('SpaAppend', '${SPA_HOST}', '/spa', [{ username: 'alice', password: 'p-spa' }]);
  const click = await mk('ClickAppend', '${CLICK_HOST}', '/click', [{ username: 'alice', password: 'p-click' }]);
  return JSON.stringify({
    nav: nav.id, old: old.id, fresh: fresh.id, same: same.id,
    frame: frame.id, spa: spa.id, click: click.id,
  });
})()`));

// ---- 1. 跳转式登录：追加到唯一匹配条目 ----
let tabId = await openTab(`http://${APPEND_HOST}:${PORT}/login`);
await fill(tabId, 'bob', 'p-bob');
await submit(tabId);

let card = await waitCard(tabId);
check('跳转后弹出追加浮卡', card?.visible === true && card?.kind === 'append', card);
check('追加浮卡列出唯一匹配条目', card?.entries?.length === 1 && card.entries[0]?.id === seed.nav, card?.entries);
check('追加浮卡账号为捕获值', card?.username === 'bob', card?.username);
check('追加浮卡头部显示条目标题', card?.headTitle === '追加账号到「NavAppend」', card?.headTitle);
check('追加浮卡默认选中该条目', card?.entryId === seed.nav, card?.entryId);

await clickSave(tabId);
const navAccounts = await (async () => {
  for (let i = 0; i < 40; i++) {
    const acc = await accountsOf(seed.nav);
    if (acc.length === 2) return acc;
    await sleep(120);
  }
  return accountsOf(seed.nav);
})();
check('追加后条目有两个账号', navAccounts.length === 2, navAccounts);
check('追加后旧账号密码保持可解密', navAccounts.find((a) => a.username === 'alice')?.password === 'p-alice', navAccounts);
check('追加后新账号密码可解密', navAccounts.find((a) => a.username === 'bob')?.password === 'p-bob', navAccounts);
const navIdx = (await listIndex()).find((e) => e.id === seed.nav);
check('追加后 accountCount 与 lastUsedAt 更新', navIdx?.accountCount === 2 && Date.now() - navIdx.lastUsedAt < 60_000, navIdx);
check('追加保存后 pending 清空', (await pending())?.length === 0, await pending());
check('追加保存后浮卡关闭', (await readCard(tabId))?.visible === false, await readCard(tabId));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 2. 多匹配条目：默认最近使用，切换后追加到所选 ----
tabId = await openTab(`http://${MULTI_HOST}:${PORT}/multi`);
await fill(tabId, 'bob', 'p-bob-multi');
await submit(tabId);

card = await waitCard(tabId);
check('多匹配时列出两个条目', card?.entries?.length === 2, card?.entries);
check('多匹配默认选最近使用的条目', card?.entryId === seed.fresh, card?.entryId);
check('多匹配默认头部显示最近条目', card?.headTitle === '追加账号到「MultiNew」', card?.headTitle);
check('多匹配条目带账号数', card?.entries?.find((e) => e.id === seed.fresh)?.accountCount === 1, card?.entries);

await patchCard(tabId, { entryId: seed.old });
card = await readCard(tabId);
check('切换下拉后选中旧条目', card?.entryId === seed.old && card.entries.find((e) => e.id === seed.old)?.selected === true, card);
check('切换下拉后头部同步更新', card?.headTitle === '追加账号到「MultiOld」', card?.headTitle);

await clickSave(tabId);
const oldAccounts = await (async () => {
  for (let i = 0; i < 40; i++) {
    const acc = await accountsOf(seed.old);
    if (acc.length === 2) return acc;
    await sleep(120);
  }
  return accountsOf(seed.old);
})();
check('追加到所选旧条目', oldAccounts.length === 2 && oldAccounts.some((a) => a.username === 'bob'), oldAccounts);
check('未选中的新条目保持原样', (await accountsOf(seed.fresh)).length === 1, await accountsOf(seed.fresh));
check('多匹配新增账号密码可解密', oldAccounts.find((a) => a.username === 'bob')?.password === 'p-bob-multi', oldAccounts);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 3. 同 username：静默，不做密码更新 ----
tabId = await openTab(`http://${SAME_HOST}:${PORT}/same`);
await fill(tabId, 'alice', 'p-changed');
await submit(tabId);
await sleep(2500);
check('同 username 不弹追加浮卡', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('同 username 不产生 pending', (await pending())?.length === 0, await pending());
const sameAccounts = await accountsOf(seed.same);
check('同 username 不改动已有密码', sameAccounts.length === 1 && sameAccounts[0]?.password === 'p-same', sameAccounts);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 4. 跨域 iframe：捕获在 frame、匹配/弹窗用顶层 URL ----
tabId = await openTab(`http://${FRAME_TOP_HOST}:${PORT}/frame`);
await waitFrameReady(tabId, FRAME_FORM_HOST);
await frameFill(tabId, FRAME_FORM_HOST, 'bob', 'p-bob-frame');
await frameSubmit(tabId, FRAME_FORM_HOST);

card = await waitCard(tabId);
check('iframe 内提交在顶层弹出追加浮卡', card?.visible === true && card?.kind === 'append', card);
check('iframe 场景按顶层 URL 匹配到条目', card?.entries?.length === 1 && card.entries[0]?.id === seed.frame, card?.entries);
await clickSave(tabId);
const frameAccounts = await (async () => {
  for (let i = 0; i < 40; i++) {
    const acc = await accountsOf(seed.frame);
    if (acc.length === 2) return acc;
    await sleep(120);
  }
  return accountsOf(seed.frame);
})();
check('iframe 场景追加成功', frameAccounts.length === 2 && frameAccounts.some((a) => a.username === 'bob'), frameAccounts);
check('iframe 场景新账号密码可解密', frameAccounts.find((a) => a.username === 'bob')?.password === 'p-bob-frame', frameAccounts);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 5. SPA 追加 + en 设置 ----
await sw(`__vipper.keychain.setSettings({ lang: 'en' })`);
tabId = await openTab(`http://${SPA_HOST}:${PORT}/spa`);
await fill(tabId, 'bob', 'p-bob-spa');
await submit(tabId);

card = await waitCard(tabId);
check('SPA 登录弹出追加浮卡', card?.visible === true && card?.kind === 'append', card);
check('SPA 浮卡跟随 en 语言', card?.lang === 'en', card?.lang);
check('en appendTitle 包含条目标题', typeof card?.headTitle === 'string' && card.headTitle.startsWith('Append account to') && card.headTitle.includes('SpaAppend'), card?.headTitle);
await clickSave(tabId);
const spaAccounts = await (async () => {
  for (let i = 0; i < 40; i++) {
    const acc = await accountsOf(seed.spa);
    if (acc.length === 2) return acc;
    await sleep(120);
  }
  return accountsOf(seed.spa);
})();
check('SPA 场景追加成功', spaAccounts.length === 2 && spaAccounts.some((a) => a.username === 'bob'), spaAccounts);
await sw(`__vipper.keychain.setSettings({ lang: 'zh' })`);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 6. click + submit 双触发：只捕获一次 ----
tabId = await openTab(`http://${CLICK_HOST}:${PORT}/click`);
await fill(tabId, 'bob', 'p-bob-click');
await sw(`chrome.scripting.executeScript({
  target: { tabId: ${tabId}, frameIds: [0] },
  func: () => document.querySelector('#go')?.click(),
})`);
card = await waitCard(tabId);
check('click + submit 双触发仍弹出追加浮卡', card?.visible === true && card?.kind === 'append', card);
const clickStats = await readStats(tabId);
check('click + submit 只捕获一次', clickStats?.captures === 1, clickStats);
check('click + submit 第二次被去重', clickStats?.duplicates >= 1, clickStats);
await clickCancel(tabId);
await sleep(300);
check('双触发取消后 pending 清空', (await pending())?.length === 0, await pending());
check('双触发取消后未新增账号', (await accountsOf(seed.click)).length === 1, await accountsOf(seed.click));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

summary();
server.close();
close();
