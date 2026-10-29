/**
 * M30 自动化验收：管理页 → 浏览器同步。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言（组打开时实时生效）：
 * - 管理页删条目 → 对应浏览器标签关闭（含锁定条目：管理页删除是显式操作）
 * - 管理页添加条目 → 浏览器新建标签并入 chrome 组（无重复条目回流）
 * - 管理页拖动排序 → 浏览器标签按 entries 顺序重排
 * - 组未打开时：仅快照变更，浏览器不动
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m30-test')`);

const U = (n) => `data:text/html,<title>P${n}</title>`;

const ids = JSON.parse(await sw(`(async () => {
  const a = await __vipper.groups.addGroup({ title: 'work', color: 'blue' });
  const def = await __vipper.groups.getGroup(a.id);
  def.entries.push(
    { id: 'e1', url: '${U(1)}', title: 'P1', locked: false },
    { id: 'e2', url: '${U(2)}', title: 'P2', locked: false },
    { id: 'e3', url: '${U(3)}', title: 'P3', locked: true }, // 锁定条目
  );
  await __vipper.groups.saveGroup(def);
  const b = await __vipper.groups.addGroup({ title: 'closed', color: 'green' });
  return JSON.stringify({ a: a.id, b: b.id });
})()`));

const srcWin = await sw(`chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws[0].id)`);

/** 浏览器侧状态：组内标签（按视觉顺序）+ 映射 */
const browserState = () => sw(`(async () => {
  const m = (await chrome.storage.session.get('opengrp:${ids.a}'))['opengrp:${ids.a}'];
  if (!m) return null;
  const tabs = (await chrome.tabs.query({ groupId: m.chromeGroupId })).sort((x, y) => x.index - y.index);
  return JSON.stringify({
    entryOrder: tabs.map((t) => m.tabs[t.id]),
    urls: tabs.map((t) => t.url),
  });
})()`).then((r) => (r ? JSON.parse(r) : null));

const defEntries = () =>
  sw(`__vipper.groups.getGroup(${JSON.stringify(ids.a)}).then((g) => JSON.stringify(g.entries.map((e) => e.id)))`).then(JSON.parse);

const openWui = async () => {
  await sw(`__vipper.dispatch('open-groups')`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(400);
  return page;
};

// ---- 打开组（M28 链路：回车）----
let page = await openWui();
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(150);
await sleep(500);

let st = await browserState();
check('前置：组已打开，3 个标签按 entries 顺序',
  !!st && st.entryOrder.join() === 'e1,e2,e3', st);

// ---- 删条目 → 关标签 ----
page = await openWui();
await page(`document.querySelector('.gp-entry[data-id="e1"] .gp-entry-del').click()`);
await sleep(800);
st = await browserState();
check('删条目：浏览器标签关闭（剩 e2/e3）', !!st && st.entryOrder.join() === 'e2,e3', st);
check('删条目：快照同步（剩 e2/e3）', (await defEntries()).join() === 'e2,e3');

// ---- 添加条目 → 建标签入组 ----
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(150);
await page(`document.querySelector('#gp-add-manual').click()`);
await sleep(150);
await page(`(() => {
  const [url, title] = document.querySelectorAll('.gp-add-form input');
  url.value = ${JSON.stringify(U(4))};
  title.value = 'P4';
  document.querySelector('.gp-add-form .btn-primary').click();
})()`);
await sleep(1000); // 建标签 + 入组 + 去抖 resync
st = await browserState();
const es4 = await defEntries();
check('添加条目：浏览器新建标签入组（顺序 e2,e3,e4）',
  !!st && st.entryOrder.join() === es4.join() && st.urls[2] === U(4), st);
check('添加条目：无重复回流（快照仍 3 条）', es4.length === 3, es4);

// ---- 拖动排序 → 重排浏览器标签（e2 拖到末尾） ----
await page(`(() => {
  const rows = [...document.querySelectorAll('.gp-entry')];
  const row = rows.find((r) => r.dataset.id === 'e2');
  const last = rows[rows.length - 1].getBoundingClientRect();
  window.__dragY = last.bottom + 10;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
})()`);
await sleep(500);
await page(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.__dragY }))`);
await sleep(150);
await page(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
await sleep(1000); // push-reorder + resync
const afterDrag = await defEntries();
st = await browserState();
check('拖动排序：快照顺序变化（e2 到末尾）', afterDrag.join() === `e3,${afterDrag[1]},e2` && afterDrag.length === 3, afterDrag);
check('拖动排序：浏览器标签顺序与快照一致', !!st && st.entryOrder.join() === afterDrag.join(), st);

// ---- 锁定条目删除（管理页显式操作）→ 标签也关闭 ----
await page(`document.querySelector('.gp-entry[data-id="e3"] .gp-entry-del').click()`);
await sleep(800);
st = await browserState();
check('删锁定条目：标签同样关闭（剩 2 个）', !!st && st.entryOrder.length === 2 && !st.entryOrder.includes('e3'), st);

// ---- 组未打开：仅快照变更，浏览器不动 ----
await page(`document.querySelector('.gp-chip[data-id="${ids.b}"]').click()`);
await sleep(400);
const tabsBefore = await sw(`chrome.tabs.query({}).then((ts) => ts.length)`);
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(150);
await page(`document.querySelector('#gp-add-manual').click()`);
await sleep(150);
await page(`(() => {
  const [url, title] = document.querySelectorAll('.gp-add-form input');
  url.value = ${JSON.stringify(U(5))};
  document.querySelector('.gp-add-form .btn-primary').click();
})()`);
await sleep(800);
const tabsAfter = await sw(`chrome.tabs.query({}).then((ts) => ts.length)`);
const bEntries = await sw(`__vipper.groups.getGroup(${JSON.stringify(ids.b)}).then((g) => g.entries.length)`);
check('组未打开：快照新增（1 条）但浏览器标签数不变',
  bEntries === 1 && tabsAfter === tabsBefore, { bEntries, tabsBefore, tabsAfter });

summary();
close();
