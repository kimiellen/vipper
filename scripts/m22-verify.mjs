/**
 * M22 自动化验收：登录提交自动保存——捕获 + 新建条目链路。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，建议全新 profile）。
 *
 * 页面拓扑（同一 HTTP 服务监听 0.0.0.0:8380，用不同 loopback 地址区分站点，
 * 因为 matchUrl 的 host 规则只比较 hostname、不比较端口）：
 *   127.0.0.1 /login    → 跳转式登录（无条目）   → 保存走完整新建链路
 *   127.0.0.4 /spa      → SPA preventDefault      → 1s 自取推送 + 双提交去重
 *   127.0.0.6 /click    → 无 form 的纯 JS 登录按钮 → 点击捕获
 *   127.0.0.7 /spa      → light + en 设置          → 主题/语言跟随
 *   127.0.0.5 /signup   → 两个密码框              → 不捕获
 *   127.0.0.2 /autofill → 有条目 + Alt+P 填充后提交 → 未改动不捕获
 *   127.0.0.3 /locked   → 锁定态提交              → 静默丢弃
 *
 * 断言：弹窗字段、标题可编辑、TAG/LINS 落盘、密码密文落盘、lastUsedAt、锁定/改密/填充未改不弹、
 *       双提交只捕获一次且只弹一次、pending 不落 storage、取消后 pending 清理。
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { createLoginDriver } from './lib/login-capture.mjs';

const PORT = 8380;
const NAV_HOST = '127.0.0.1';
const AUTOFILL_HOST = '127.0.0.2';
const LOCKED_HOST = '127.0.0.3';
const SPA_HOST = '127.0.0.4';
const SIGNUP_HOST = '127.0.0.5';
const CLICK_HOST = '127.0.0.6';
const LIGHT_HOST = '127.0.0.7';

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

const signupForm = `<form id="f">
  <input id="u" name="username" type="text" autocomplete="username" />
  <input id="p1" name="new-password" type="password" autocomplete="new-password" />
  <input id="p2" name="confirm-password" type="password" autocomplete="new-password" />
  <button id="go" type="submit">注册</button>
</form>
<script>document.querySelector('#f').addEventListener('submit', (e) => e.preventDefault());</script>`;

const clickForm = `<div>
  <input id="u" name="username" type="text" autocomplete="username" />
  <input id="p" name="password" type="password" autocomplete="current-password" />
  <button id="go" type="button">登录</button>
</div>
<script>document.querySelector('#go').addEventListener('click', () => {});</script>`;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const bodies = {
    '/login': html('M22 登录页', loginForm('/welcome')),
    '/welcome': html('M22 欢迎', '<h1>welcome</h1>'),
    '/spa': html('M22 SPA 登录', spaForm('/app')),
    '/app': html('M22 应用', '<h1>app</h1>'),
    '/click': html('M22 点击登录', clickForm),
    '/signup': html('M22 注册', signupForm),
    '/autofill': html('M22 自动填充', spaForm('/autofill-app')),
    '/locked': html('M22 锁定', spaForm('/locked-app')),
  };
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(bodies[path] ?? html('M22', '<h1>ok</h1>'));
});
await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

const {
  evalInPage, openTab, waitCard, waitUntil,
  fill, submit, patchCard, clickSave, clickCancel,
  readCard, readStats, readValues, listIndex, pending,
} = createLoginDriver(sw);

// ---- 场景准备：全新存储 + 主密码 + 一张 tag / 一条关联信息 ----
await sw(`(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id !== undefined && t.url?.includes(':${PORT}')) await chrome.tabs.remove(t.id).catch(() => {});
  }
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await __vipper.keychain.setupMasterPassword('m22-test');
})()`);

const seed = JSON.parse(await sw(`(async () => {
  const tag = await __vipper.vault.addTag('work', 'blue');
  const link = await __vipper.vault.addLinkedInfo('邮箱1', 'm22@example.com');
  return JSON.stringify({ tag, link });
})()`));

// ---- 1. 跳转式登录（无条目）→ 保存新建 ----
let tabId = await openTab(`http://${NAV_HOST}:${PORT}/login`);
await fill(tabId, 'alice', 'pw-navigation');
await submit(tabId);

let card = await waitCard(tabId);
check('跳转完成后弹出保存浮卡', card?.visible === true, card);
check('浮卡默认标题取登录页标题', card?.title === 'M22 登录页', card?.title);
check('浮卡网址为提交时顶层 URL', card?.url === `http://${NAV_HOST}:${PORT}/login`, card?.url);
check('浮卡账号为捕获值', card?.username === 'alice', card?.username);
check('浮卡列出全部 tag 且默认未选', card?.tags?.length === 1 && card.tags[0]?.checked === false, card?.tags);
check('浮卡列出全部关联信息且默认未选', card?.links?.length === 1 && card.links[0]?.checked === false, card?.links);
check('pending 已标记为已弹（只弹一次）', (await pending())?.[0]?.prompted === true, await pending());
check('浮卡跟随设置语言（默认 zh）', card?.lang === 'zh', card?.lang);
check('浮卡跟随设置主题（默认 dark）', card?.theme === 'dark', card?.theme);
check('浮卡深色背景生效', card?.bg === 'rgb(30, 30, 46)', card?.bg);
const swLoginStats = await sw(`__vipper.login.stats()`);
check('登录推送无投递失败', swLoginStats?.pushFailures === 0, swLoginStats);
check('SW 已记录一次成功推送', swLoginStats?.prompts >= 1, swLoginStats);

const patched = (await patchCard(tabId, { title: 'SavedSite', tagIds: [seed.tag.id], linkIds: [seed.link.id] }));
check('调试接口可改标题并勾选 TAG/LINS', patched === true, patched);
card = await readCard(tabId);
check('浮卡反映编辑后的标题', card?.title === 'SavedSite', card?.title);
check('浮卡反映勾选后的 tag', card?.tags?.find((t) => t.id === seed.tag.id)?.checked === true, card?.tags);
check('浮卡反映勾选后的关联信息', card?.links?.find((l) => l.id === seed.link.id)?.checked === true, card?.links);

await clickSave(tabId);
const savedIdx = await waitUntil(async () => {
  const idx = await listIndex();
  return idx.find((e) => e.title === 'SavedSite') ?? null;
});
check('保存后 idx 出现新条目', !!savedIdx, savedIdx);
check('新条目 URL 为提交页且 match=host', savedIdx?.urls?.[0]?.url === `http://${NAV_HOST}:${PORT}/login` && savedIdx?.urls?.[0]?.match === 'host', savedIdx?.urls);
check('新条目账号数 1', savedIdx?.accountCount === 1, savedIdx?.accountCount);
check('新条目写入所选 tag', savedIdx?.tags?.length === 1 && savedIdx.tags[0] === seed.tag.id, savedIdx?.tags);
check('新条目写入所选关联信息', savedIdx?.linkedInfos?.length === 1 && savedIdx.linkedInfos[0] === seed.link.id, savedIdx?.linkedInfos);
check('新条目 lastUsedAt 为当前时间', typeof savedIdx?.lastUsedAt === 'number' && Date.now() - savedIdx.lastUsedAt < 60_000, savedIdx?.lastUsedAt);

const decrypted = savedIdx
  ? JSON.parse(await sw(`(async () => JSON.stringify(await __vipper.vault.getBookmarkDecrypted(${JSON.stringify(savedIdx.id)})))()`))
  : null;
check('保存后密码可解密还原', decrypted?.accounts?.[0]?.username === 'alice' && decrypted?.accounts?.[0]?.password === 'pw-navigation', decrypted?.accounts);

const rawLocal = await sw(`(async () => JSON.stringify(await chrome.storage.local.get(null)))()`);
const rawSession = await sw(`(async () => JSON.stringify(await chrome.storage.session.get(null)))()`);
check('storage.local 不含明文密码', !rawLocal.includes('pw-navigation'), '含明文');
check('storage.session 不含明文密码', !rawSession.includes('pw-navigation'), '含明文');
check('保存后浮卡关闭', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('保存后 pending 清空', (await pending())?.length === 0, await pending());
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 2. SPA 无导航 + 双提交：1s 自取推送，只捕获一次、只弹一次 ----
tabId = await openTab(`http://${SPA_HOST}:${PORT}/spa`);
await fill(tabId, 'spa-user', 'pw-spa');
await submit(tabId);
await sleep(120);
await submit(tabId); // 2s 内相同凭据 → 去重

card = await waitCard(tabId);
check('SPA 无导航时 1s 后仍弹出保存浮卡', card?.visible === true, card);
check('SPA 浮卡网址为提交时 URL（pushState 前）', card?.url === `http://${SPA_HOST}:${PORT}/spa`, card?.url);
const spaStats = await readStats(tabId);
check('SPA 双提交只捕获一次', spaStats?.captures === 1, spaStats);
check('SPA 双提交第二次被去重', spaStats?.duplicates >= 1, spaStats);
check('SPA 双提交只弹一次', spaStats?.prompts === 1, spaStats);

const idxBeforeCancel = (await listIndex()).length;
await clickCancel(tabId);
await sleep(300);
check('不保存后浮卡关闭', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('不保存后 pending 清空', (await pending())?.length === 0, await pending());
check('不保存不新增条目', (await listIndex()).length === idxBeforeCancel, (await listIndex()).length);
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 3. 无 form 的纯 JS 登录按钮：点击捕获（不依赖 submit 事件） ----
tabId = await openTab(`http://${CLICK_HOST}:${PORT}/click`);
await fill(tabId, 'click-user', 'pw-click');
await evalInPage(tabId, `() => document.querySelector('#go')?.click()`);
card = await waitCard(tabId);
check('无 form 的纯 JS 登录按钮也能捕获', card?.visible === true, card);
check('点击路径捕获账号正确', card?.username === 'click-user', card?.username);
await clickCancel(tabId);
await sleep(300);
check('点击路径取消后 pending 清空', (await pending())?.length === 0, await pending());
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 4. 主题 / 语言跟随 meta:settings ----
await sw(`__vipper.keychain.setSettings({ theme: 'light', lang: 'en' })`);
tabId = await openTab(`http://${LIGHT_HOST}:${PORT}/spa`);
await fill(tabId, 'light-user', 'pw-light');
await submit(tabId);
card = await waitCard(tabId);
check('浮卡跟随 light 主题', card?.theme === 'light', card?.theme);
check('浮卡浅色背景生效', card?.bg === 'rgb(239, 241, 245)', card?.bg);
check('浮卡跟随 en 语言', card?.lang === 'en', card?.lang);
await clickCancel(tabId);
await sleep(300);
check('主题/语言场景取消后 pending 清空', (await pending())?.length === 0, await pending());
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});
await sw(`__vipper.keychain.setSettings({ theme: 'dark', lang: 'zh' })`);

// ---- 5. 两个可见密码框（注册/改密）→ 不捕获 ----
tabId = await openTab(`http://${SIGNUP_HOST}:${PORT}/signup`);
await evalInPage(tabId, `() => {
  document.querySelector('#u').value = 'signup-user';
  document.querySelector('#p1').value = 'pw-signup-1';
  document.querySelector('#p2').value = 'pw-signup-1';
}`);
await submit(tabId);
await sleep(1800);
const signupStats = await readStats(tabId);
check('两个可见密码框不弹出保存浮卡', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('两个密码框被标记跳过', signupStats?.skippedMultiPassword >= 1, signupStats);
check('注册表单不产生 pending', (await pending())?.length === 0, await pending());
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 6. 已有条目 + Alt+P 填充后原样提交 → 不捕获 ----
await sw(`__vipper.vault.addBookmark({
  title: 'AutofillSite',
  urls: [{ url: ${JSON.stringify(`http://${AUTOFILL_HOST}:${PORT}/autofill`)}, match: 'host' }],
  accounts: [{ username: 'bob', password: 'pw-auto' }],
})`);
tabId = await openTab(`http://${AUTOFILL_HOST}:${PORT}/autofill`);
await sw(`__vipper.dispatch('autofill')`);
await sleep(1500);
const values = await readValues(tabId);
check('Alt+P 已填充自动填充页', values?.u === 'bob' && values?.p === 'pw-auto', values);
await submit(tabId);
await sleep(1800);
const autofillStats = await readStats(tabId);
check('填充后未修改的提交不弹浮卡', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('填充未修改被标记跳过', autofillStats?.skippedAutofill >= 1, autofillStats);
check('填充未修改不产生 pending', (await pending())?.length === 0, await pending());
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

// ---- 7. 锁定态提交 → 静默丢弃 ----
await sw(`__vipper.keychain.lock()`);
tabId = await openTab(`http://${LOCKED_HOST}:${PORT}/locked`);
await fill(tabId, 'locked-user', 'pw-locked');
await submit(tabId);
await sleep(2200);
check('锁定态提交不弹浮卡', (await readCard(tabId))?.visible === false, await readCard(tabId));
check('锁定态不产生 pending（不暂存明文）', (await pending())?.length === 0, await pending());
const lockedIdx = await listIndex();
check('锁定态不新增条目', !lockedIdx.some((e) => e.title === 'M22 锁定'), lockedIdx.map((e) => e.title));
await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});

summary();
server.close();
close();
