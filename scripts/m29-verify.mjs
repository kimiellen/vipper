/**
 * M29 自动化验收：浏览器 → 管理页回流。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 同 tabId 跳转 → 未锁定条目 url/标题改写；锁定条目豁免
 * - 单个标签关闭 → 未锁定条目删除；锁定条目保留（映射摘除）
 * - 浏览器侧标签进组 → 新增条目；拖出组 → 删除条目；顺序对齐浏览器标签顺序
 * - 管理页打开时收到 group-synced 实时刷新
 * - 整窗关闭（isWindowClosing）→ 快照完整保留、映射作废
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// Chrome 禁止顶层导航到 data: URL（跳转回流测不了），起本地 http 服务供真实导航
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<title>${req.url.slice(1)}</title><h1>${req.url}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

await sw(`__vipper.keychain.setupMasterPassword('m29-test')`);

const U = (n) => `http://127.0.0.1:${port}/${n}`;

const groupId = await sw(`(async () => {
  const g = await __vipper.groups.addGroup({ title: 'work', color: 'blue' });
  const def = await __vipper.groups.getGroup(g.id);
  def.entries.push(
    { id: 'e1', url: '${U(1)}', title: 'P1', locked: false },
    { id: 'e2', url: '${U(2)}', title: 'P2', locked: false },
    { id: 'e3', url: '${U(3)}', title: 'P3', locked: true }, // 锁定条目
  );
  await __vipper.groups.saveGroup(def);
  return g.id;
})()`);

const srcWin = await sw(`chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws[0].id)`);

// 打开组（M28 链路）
await sw(`__vipper.dispatch('open-groups')`);
{
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(300);
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(150);
}
await sleep(500);

const mapping = () =>
  sw(`chrome.storage.session.get('opengrp:${groupId}').then((s) => JSON.stringify(s['opengrp:${groupId}'] ?? null))`).then(JSON.parse);
const entries = () => sw(`__vipper.groups.getGroup(${JSON.stringify(groupId)}).then((g) => JSON.stringify(g.entries))`).then(JSON.parse);
/** tabId（映射里 entryId 对应的标签） */
const tabOf = async (entryId) => {
  const m = await mapping();
  return Number(Object.keys(m.tabs).find((k) => m.tabs[k] === entryId));
};

let m = await mapping();
check('前置：组已打开，3 个映射', m && Object.keys(m.tabs).length === 3, m);

// ---- 跳转回流：未锁定改写，锁定豁免 ----
const t1 = await tabOf('e1');
await sw(`chrome.tabs.update(${t1}, { url: ${JSON.stringify(U('1b'))} })`);
await sleep(700);
let es = await entries();
check('跳转：未锁定条目 url 改写', es.find((e) => e.id === 'e1')?.url === U('1b'), es.find((e) => e.id === 'e1'));

const t3 = await tabOf('e3');
await sw(`chrome.tabs.update(${t3}, { url: ${JSON.stringify(U('3b'))} })`);
await sleep(700);
es = await entries();
check('跳转：锁定条目豁免（url 不变）', es.find((e) => e.id === 'e3')?.url === U(3), es.find((e) => e.id === 'e3'));

// ---- 单标签关闭：未锁定删除，锁定保留 ----
await sw(`chrome.tabs.remove(${t1})`);
await sleep(700);
es = await entries();
check('关闭：未锁定条目删除', !es.some((e) => e.id === 'e1'), es.map((e) => e.id));

await sw(`chrome.tabs.remove(${t3})`);
await sleep(700);
es = await entries();
m = await mapping();
check('关闭：锁定条目保留（快照中）', es.some((e) => e.id === 'e3'), es.map((e) => e.id));
check('关闭：锁定条目的 tabId 已从映射摘除', !Object.values(m.tabs).includes('e3'), m.tabs);

// ---- 进组：浏览器侧新标签加入 chrome 组 → 新增条目并顺序对齐 ----
const newTab = await sw(`(async () => {
  const t = await chrome.tabs.create({ windowId: ${srcWin}, url: ${JSON.stringify(U(9))}, active: false });
  await chrome.tabs.group({ groupId: ${m.chromeGroupId}, tabIds: [t.id] });
  return t.id;
})()`);
await sleep(900); // onCreated/onActivated 去抖 200ms + 写盘
es = await entries();
const joined = es.find((e) => e.url === U(9));
check('进组：浏览器侧新标签成为新条目', !!joined, es.map((e) => [e.id, e.url]));
check('进组：顺序对齐浏览器标签顺序（e2 → 新条目），锁定 e3 附后',
  es.map((e) => e.id).join() === ['e2', joined?.id, 'e3'].join(), es.map((e) => e.id));

// ---- 出组：拖出 chrome 组 → 删除条目 ----
await sw(`chrome.tabs.ungroup([${newTab}])`);
await sleep(900);
es = await entries();
check('出组：未锁定条目删除', !es.some((e) => e.url === U(9)), es.map((e) => e.id));

// ---- 管理页实时刷新（group-synced 消息） ----
await sw(`__vipper.dispatch('open-groups')`);
const page = await attachPage('wui.html#groups');
for (let i = 0; i < 40; i++) {
  const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(400);
const t2 = await tabOf('e2');
await sw(`chrome.tabs.update(${t2}, { url: ${JSON.stringify(U('2b'))} })`);
await sleep(900);
const domUrls = JSON.parse(await page(
  `JSON.stringify([...document.querySelectorAll('.gp-entry-url')].map((x) => x.textContent))`,
));
check('管理页：浏览器侧跳转后实时刷新', domUrls.includes(U('2b')), domUrls);

// ---- 整窗关闭：快照保留、映射作废 ----
await sw(`chrome.windows.remove(${srcWin})`);
await sleep(1000);
es = await entries();
m = await mapping();
check('整窗关闭：快照完整保留（e2/e3 都在）',
  es.length === 2 && es.some((e) => e.id === 'e2') && es.some((e) => e.id === 'e3'), es.map((e) => e.id));
check('整窗关闭：映射作废', m === null, m);

summary();
server.close();
close();
