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

async function openGroupsAndEnter(targetGroupId) {
  await sw(`__vipper.dispatch('open-groups')`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(300);
  if (targetGroupId) {
    // 选中目标 chip（视图默认选中上次打开过的组）
    await page(`document.querySelector('#gp-chips [data-id="${targetGroupId}"]')?.click()`);
    await sleep(300);
  }
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

// ---- M34：打开即聚焦（新建组时折叠目标窗口内其余组） ----
const extra = JSON.parse(await sw(`(async () => {
  const winId = ${srcWin};
  const mk = () => chrome.tabs.create({ windowId: winId, url: 'about:blank', active: false }).then((t) => t.id);
  const a = await mk(), b = await mk(), c = await mk();
  const gA = await chrome.tabs.group({ tabIds: [a, b] });
  const gB = await chrome.tabs.group({ tabIds: [c] });
  await chrome.tabGroups.update(gA, { title: 'A', collapsed: false });
  await chrome.tabGroups.update(gB, { title: 'B', collapsed: false });
  await chrome.tabs.update(a, { active: true }); // 活动标签落在 A 组内
  return JSON.stringify({ gA, gB });
})()`));

const group2 = await sw(`(async () => {
  const g = await __vipper.groups.addGroup({ title: 'night', color: 'blue' });
  const def = await __vipper.groups.getGroup(g.id);
  def.entries.push(
    { id: 'n1', url: 'data:text/html,<title>N1</title>', title: 'N1', locked: false },
    { id: 'n2', url: 'data:text/html,<title>N2</title>', title: 'N2', locked: false },
  );
  await __vipper.groups.saveGroup(def);
  return g.id;
})()`);

await openGroupsAndEnter(group2);

const focusState = JSON.parse(await sw(`(async () => {
  const gA = await chrome.tabGroups.get(${extra.gA});
  const gB = await chrome.tabGroups.get(${extra.gB});
  const s = await chrome.storage.session.get(['opengrp:${group2}', 'opengrp:${groupId}']);
  const nightMapping = s['opengrp:${group2}'];
  const workMapping = s['opengrp:${groupId}'];
  const night = await chrome.tabGroups.get(nightMapping.chromeGroupId);
  const work = await chrome.tabGroups.get(workMapping.chromeGroupId);
  const [act] = await chrome.tabs.query({ active: true, windowId: ${srcWin} });
  return JSON.stringify({
    a: gA.collapsed, b: gB.collapsed, work: work.collapsed, night: night.collapsed,
    nightTitle: night.title, nightColor: night.color,
    active: act.id, firstTab: Number(Object.keys(nightMapping.tabs)[0]),
  });
})()`));

check('打开即聚焦：预先展开的两个组被折叠', focusState.a === true && focusState.b === true, focusState);
check('打开即聚焦：此前打开过的组也被折叠', focusState.work === true, focusState);
check('打开即聚焦：新组保持展开', focusState.night === false, focusState);
check('打开即聚焦：活动标签 = 新组首条目', focusState.active === focusState.firstTab, focusState);
check('打开即聚焦：新组属性正确', focusState.nightTitle === 'night' && focusState.nightColor === 'blue', focusState);

// 已打开组的路径不折叠其他组（仍由 Alt+H/L 切组负责）
await sw(`chrome.tabGroups.update(${extra.gA}, { collapsed: false })`);
await sleep(200);
await openGroupsAndEnter(group2);
const again = JSON.parse(await sw(`(async () => {
  const gA = await chrome.tabGroups.get(${extra.gA});
  return JSON.stringify({ a: gA.collapsed });
})()`));
check('重复回车（激活已打开组）：不折叠其他组', again.a === false, again);

summary();
close();
