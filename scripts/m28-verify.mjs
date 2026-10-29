/**
 * M28 自动化验收：回车打开组（冷启动重建）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - chips 上回车 → 来源窗口按 entries 顺序批量建标签 → 合成 chrome 组（标题/颜色一致）→ 关闭 wui 弹窗
 * - storage.session 落 tabId ↔ entryId 映射（chromeGroupId + tabs）
 * - 记录最后打开的组（meta:lastOpenedGroup）
 * - 重复回车不重复开（已有有效映射时激活既有组）
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m28-test')`);

const URLS = [
  'data:text/html,<title>P1</title>',
  'data:text/html,<title>P2</title>',
  'data:text/html,<title>P3</title>',
];

const groupId = await sw(`(async () => {
  const g = await __vipper.groups.addGroup({ title: 'work', color: 'red' });
  const def = await __vipper.groups.getGroup(g.id);
  def.entries.push(
    { id: 'e1', url: ${JSON.stringify(URLS[0])}, title: 'P1', locked: false },
    { id: 'e2', url: ${JSON.stringify(URLS[1])}, title: 'P2', locked: false },
    { id: 'e3', url: ${JSON.stringify(URLS[2])}, title: 'P3', locked: false },
  );
  await __vipper.groups.saveGroup(def);
  return g.id;
})()`);

const srcWin = await sw(`chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws[0].id)`);

async function openGroupsAndEnter() {
  await sw(`__vipper.dispatch('open-groups')`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(300);
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(150);
  await sleep(300);
}

/** 来源窗口里真实 chrome 组的状态 */
const chromeGroupState = () => sw(`(async () => {
  const tabs = (await chrome.tabs.query({ windowId: ${srcWin} }))
    .filter((t) => t.groupId !== -1).sort((a, b) => a.index - b.index);
  if (tabs.length === 0) return null;
  const g = await chrome.tabGroups.get(tabs[0].groupId);
  return JSON.stringify({
    chromeGroupId: tabs[0].groupId, title: g.title, color: g.color,
    urls: tabs.map((t) => t.url), tabIds: tabs.map((t) => t.id),
    totalTabs: (await chrome.tabs.query({ windowId: ${srcWin} })).length,
  });
})()`).then((r) => (r ? JSON.parse(r) : null));

// ---- 回车打开：重建 chrome 组 ----
await openGroupsAndEnter();

check('回车后 wui 弹窗已关闭', !hasPage('wui.html'));

let st = await chromeGroupState();
check('chrome 组重建：3 个标签按 entries 顺序入组',
  !!st && st.urls.join() === URLS.join(), st);
check('chrome 组属性：标题 work + 颜色 red', !!st && st.title === 'work' && st.color === 'red', st);

const mapping = JSON.parse(await sw(`chrome.storage.session.get('opengrp:${groupId}').then((s) => JSON.stringify(s['opengrp:${groupId}'] ?? null))`));
check('映射：chromeGroupId 与真实组一致', mapping?.chromeGroupId === st?.chromeGroupId, mapping);
check('映射：tabId ↔ entryId 一一对应（e1/e2/e3）',
  !!mapping && Object.keys(mapping.tabs).length === 3
  && st.tabIds.every((id, i) => mapping.tabs[id] === ['e1', 'e2', 'e3'][i]),
  { mapping: mapping?.tabs, tabIds: st?.tabIds });
check('映射：windowId = 来源窗口', mapping?.windowId === srcWin, mapping);

check('最后打开的组已记录',
  (await sw(`__vipper.groups.getLastOpenedGroupId()`)) === groupId);

// ---- 重复回车：不重复开 ----
const before = st.totalTabs;
await openGroupsAndEnter();
st = await chromeGroupState();
check('重复回车：标签数不变（激活既有组，不重建）',
  !!st && st.totalTabs === before && st.urls.join() === URLS.join(), st);
const mapping2 = JSON.parse(await sw(`chrome.storage.session.get('opengrp:${groupId}').then((s) => JSON.stringify(s['opengrp:${groupId}'] ?? null))`));
check('重复回车：映射仍指向同一 chrome 组', mapping2?.chromeGroupId === st?.chromeGroupId, mapping2);

summary();
close();
