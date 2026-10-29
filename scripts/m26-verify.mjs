/**
 * M26 自动化验收：groups 数据层 + wui 视图路由 + 组 chips。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - storage 层：addGroup/saveGroup/listGroups/getGroup 读写与索引同步；空组名/非法颜色拒绝；lastOpened 持久化
 * - 视图路由：#groups 显示 groups 视图、隐藏书签视图；无 hash 时书签视图不受影响
 * - chips：渲染（组色）、单击选中、新建组（命名 + 9 色）、Esc 取消、溢出渐隐
 * - 布局：三段式（chips 行占满整行；右栏顶部高于左管理栏，连接区 36px）
 * - 组色 accents：连接折线 + 管理栏边框跟随选中组颜色
 * - 连接折线几何：chip 底中 → 空档中线 → 管理栏顶边中点；chips 溢出、选中 chip 在右半区时落点不变
 * - 键盘：`/` 在 chips 与搜索框间切换光标（搜索非空时输入普通字符）；←/→ 移动且不越界
 * - 初始选中 = 最后一次回车打开过的组（storage.local）
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---------- Part 1：storage 层 ----------

await sw(`__vipper.keychain.setupMasterPassword('m26-test')`);

const seed = JSON.parse(await sw(`(async () => {
  const shop = await __vipper.groups.addGroup({ title: 'shop', color: 'red' });
  const work = await __vipper.groups.addGroup({ title: 'work', color: 'green' });
  const luna = await __vipper.groups.addGroup({ title: 'luna', color: 'blue' });
  return JSON.stringify({ shop: shop.id, work: work.id, luna: luna.id });
})()`));

let idx = JSON.parse(await sw(`__vipper.groups.listGroups().then(JSON.stringify)`));
check('addGroup：索引 3 条、顺序 = 创建顺序', idx.length === 3 && idx[0].title === 'shop' && idx[2].title === 'luna', idx);

const shopDef = JSON.parse(await sw(`__vipper.groups.getGroup(${JSON.stringify(seed.shop)}).then(JSON.stringify)`));
check('getGroup：详情回读（title/color/entries 空数组）',
  shopDef.title === 'shop' && shopDef.color === 'red' && Array.isArray(shopDef.entries) && shopDef.entries.length === 0, shopDef);

check('addGroup：空组名拒绝', await sw(`__vipper.groups.addGroup({ title: '  ', color: 'blue' }).then(() => false, () => true)`));
check('addGroup：非法颜色拒绝', await sw(`__vipper.groups.addGroup({ title: 'x', color: 'black' }).then(() => false, () => true)`));

await sw(`(async () => {
  const g = await __vipper.groups.getGroup(${JSON.stringify(seed.shop)});
  g.title = 'shop2';
  g.entries.push({ id: 'e1', url: 'https://a.com', title: 'a', locked: false });
  await __vipper.groups.saveGroup(g);
})()`);
idx = JSON.parse(await sw(`__vipper.groups.listGroups().then(JSON.stringify)`));
check('saveGroup：索引同步（新标题 + entryCount=1）', idx[0].title === 'shop2' && idx[0].entryCount === 1, idx[0]);

await sw(`__vipper.groups.setLastOpenedGroupId(${JSON.stringify(seed.work)})`);
check('lastOpened：持久化回读',
  (await sw(`__vipper.groups.getLastOpenedGroupId()`)) === seed.work);

// ---------- Part 2：UI ----------

async function openGroups() {
  await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html#groups'), type: 'popup', width: 1280, height: 800 }).then(() => true)`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(200);
  return page;
}

async function closeWui() {
  // 前缀匹配：groups 视图的 tab url 带 #groups hash，严格相等会漏关
  await sw(`(async () => {
    const ws = (await chrome.windows.getAll({ populate: true }))
      .filter((x) => x.tabs?.some((t) => t.url?.startsWith(chrome.runtime.getURL('wui.html'))));
    for (const w of ws) await chrome.windows.remove(w.id);
  })()`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(100);
  await sleep(200);
}

/** 页面内键盘事件（我们的监听都在 document 上） */
const key = async (page, k) => {
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  await sleep(120);
};

const chips = (page) => page(`JSON.stringify([...document.querySelectorAll('.gp-chip')].map((c) => ({
  id: c.dataset.id, title: c.textContent, selected: c.classList.contains('selected'),
  color: c.style.color,
})))`).then(JSON.parse);

/** 连接折线几何（points 坐标为相对 groups 页面的 CSS px） */
const linkGeom = (page) => page(`(() => {
  const svg = document.querySelector('#gp-link');
  const path = document.querySelector('#gp-link-path');
  const chip = document.querySelector('.gp-chip.selected');
  const chipBox = chip.getBoundingClientRect();
  const panel = document.querySelector('#gp-panel');
  const panelBox = panel.getBoundingClientRect();
  const pageBox = document.querySelector('#page-groups').getBoundingClientRect();
  return JSON.stringify({
    hidden: svg.hasAttribute('hidden'),
    stroke: path.style.stroke,
    border: panel.style.borderColor,
    points: (path.getAttribute('points') || '').split(' ').filter(Boolean)
      .map((p) => p.split(',').map(Number)),
    chip: { cx: chipBox.left + chipBox.width / 2, bottom: chipBox.bottom },
    chipsRight: document.querySelector('#gp-chips').getBoundingClientRect().right,
    panel: { cx: (panelBox.left + panelBox.right) / 2, top: panelBox.top },
    page: { left: pageBox.left, top: pageBox.top },
  });
})()`).then(JSON.parse);

let page = await openGroups();

check('视图路由：#groups 显示 groups 视图、隐藏书签视图', await page(
  `!document.querySelector('#page-groups').hidden && document.querySelector('#page-bookmarks').hidden`,
));
check('视图路由：不提供页面内切换按钮（只由快捷键区分）', await page(
  `document.querySelector('#view-seg') === null`,
));
check('布局：左右两栏等宽（与内容无关）', await page(`(() => {
  const l = document.querySelector('.gp-left').getBoundingClientRect();
  const r = document.querySelector('.gp-right').getBoundingClientRect();
  return Math.abs(l.width - r.width) <= 1;
})()`));
check('布局：右侧搜索栏整体带边框（含结果区/输入框/TAGS/LINS）', await page(`(() => {
  const r = document.querySelector('.gp-right');
  const cs = getComputedStyle(r);
  return parseFloat(cs.borderTopWidth) >= 1 && r.querySelector('#gp-search')
    && r.querySelector('#gp-tag-filter') && r.querySelector('#gp-link-filter')
    && r.querySelector('#gp-results');
})()`));
check('布局：+标签组 按钮与右侧栏有间距（不贴住）', await page(`(() => {
  const btn = document.querySelector('#gp-add').getBoundingClientRect();
  const right = document.querySelector('.gp-right').getBoundingClientRect();
  return right.top - btn.bottom >= 8;
})()`));

let cs = await chips(page);
check('chips：3 个、标题正确、初始选中 = lastOpened(work)',
  cs.length === 3 && cs[0].title === 'shop2' && cs[1].title === 'work' && cs[1].selected, cs);

check('组色 accents：管理栏边框 + 连接折线 = 选中组颜色（work=green）', await page(`(() => {
  const panel = document.querySelector('#gp-panel');
  const svg = document.querySelector('#gp-link');
  const path = document.querySelector('#gp-link-path');
  return panel.style.borderColor === 'var(--cat-green)'
    && !svg.hasAttribute('hidden') && path.style.stroke === 'var(--cat-green)';
})()`));

let link = await linkGeom(page);
const [start, bend1, bend2, end] = link.points;
check('连接折线几何：chip 底中 → 空档中线 → 管理栏顶边中点', !link.hidden
  && link.points.length === 4
  && Math.abs(start[0] - (link.chip.cx - link.page.left)) < 1
  && Math.abs(start[1] - (link.chip.bottom - link.page.top)) < 1
  && Math.abs(end[0] - (link.panel.cx - link.page.left)) < 1
  && Math.abs(end[1] - (link.panel.top - link.page.top)) < 1
  && Math.abs(bend1[1] - bend2[1]) < 0.5 && bend1[1] > start[1] && bend1[1] < end[1]
  && Math.abs(bend1[0] - start[0]) < 0.5 && Math.abs(bend2[0] - end[0]) < 0.5, link);

check('布局：chips 行占满整行；左管理栏顶部下压（连接区 36px）', await page(`(() => {
  const row = document.querySelector('.gp-chips-row').getBoundingClientRect();
  const right = document.querySelector('.gp-right').getBoundingClientRect();
  const panel = document.querySelector('#gp-panel').getBoundingClientRect();
  return Math.abs(row.width - document.documentElement.clientWidth) < 2
    && panel.top - right.top >= 10;
})()`));

// ---- 单击选中：accents 跟随 ----
await page(`document.querySelector('.gp-chip[data-id="${seed.shop}"]').click()`);
await sleep(150);
check('单击选中：selected 移动 + 边框/连线变色（shop2=red）', await page(`(() => {
  const chip = document.querySelector('.gp-chip[data-id="${seed.shop}"]');
  return chip.classList.contains('selected')
    && document.querySelector('#gp-panel').style.borderColor === 'var(--cat-red)'
    && document.querySelector('#gp-link-path').style.stroke === 'var(--cat-red)';
})()`));

// ---- 新建组：命名 + 9 色 ----
await page(`document.querySelector('#gp-add').click()`);
await sleep(120);
check('新建组：表单出现且组名输入框聚焦', await page(
  `!document.querySelector('#gp-new').hidden && document.activeElement.id === 'gp-new-name'`,
));
await page(`(() => {
  document.querySelector('#gp-new-name').value = 'kimi';
  [...document.querySelectorAll('.gp-dot')].find((d) => d.title === 'purple').click();
  document.querySelector('#gp-new-ok').click();
})()`);
await sleep(300);
cs = await chips(page);
check('新建组：第 4 个 chip 出现且选中', cs.length === 4 && cs[3].title === 'kimi' && cs[3].selected, cs[3]);
const kimiIdx = JSON.parse(await sw(`__vipper.groups.listGroups().then(JSON.stringify)`));
check('新建组：storage 落盘（purple）', kimiIdx[3]?.title === 'kimi' && kimiIdx[3]?.color === 'purple', kimiIdx[3]);
check('新建组：边框/连线 = purple（--cat-mauve）', await page(
  `document.querySelector('#gp-panel').style.borderColor === 'var(--cat-mauve)'`,
));

// ---- 空组名拒绝 + Esc 取消 ----
await page(`document.querySelector('#gp-add').click()`);
await sleep(120);
await page(`document.querySelector('#gp-new-ok').click()`);
await sleep(150);
check('新建组：空组名拒绝（表单保留）', await page(`!document.querySelector('#gp-new').hidden`));
await key(page, 'Escape');
check('新建组：Esc 取消（表单关闭、组数不变）', await page(
  `document.querySelector('#gp-new').hidden && document.querySelectorAll('.gp-chip').length === 4`,
));

// ---- `/` 光标切换 ----
await key(page, '/');
check('`/`：光标从 chips 切到搜索框', await page(`document.activeElement.id === 'gp-search'`));
await page(`document.querySelector('#gp-search').value = 'x'`);
await key(page, '/');
check('`/`：搜索非空时按普通输入（不切光标）', await page(`document.activeElement.id === 'gp-search'`));
await page(`document.querySelector('#gp-search').value = ''`);
await key(page, '/');
check('`/`：搜索为空时切回 chips', await page(`document.activeElement === document.body`));

// ---- ←/→ 移动选中（不越界）----
await page(`document.querySelector('.gp-chip[data-id="${seed.shop}"]').click()`);
await key(page, 'ArrowRight');
cs = await chips(page);
check('→：选中移到 work', cs[1].selected, cs.map((c) => c.selected));
await key(page, 'ArrowLeft');
await key(page, 'ArrowLeft');
cs = await chips(page);
check('←：回到 shop2 且不越界', cs[0].selected, cs.map((c) => c.selected));

// ---- 初始选中 = 最后打开的组（重开验证）----
await closeWui();
page = await openGroups();
cs = await chips(page);
check('重开：初始选中 = lastOpened（work）', cs[1].selected, cs.map((c) => [c.title, c.selected]));
await closeWui();

// ---- chips 溢出：横向滚动 + 渐隐 ----
await sw(`(async () => {
  for (let i = 0; i < 30; i++) await __vipper.groups.addGroup({ title: 'overflow-group-' + i, color: 'cyan' });
})()`);
page = await openGroups();
check('溢出：chips 横向滚动 + 边缘渐隐类', await page(`(() => {
  const box = document.querySelector('#gp-chips');
  return box.scrollWidth > box.clientWidth && box.classList.contains('overflowing');
})()`));

// ---- 回归：chips 溢出、选中 chip 在右半区时，折线落点仍是管理栏顶边中点（曾整条线跑进右栏）----
await page(`([...document.querySelectorAll('.gp-chip')].at(-1).click())`);
await sleep(250);
link = await linkGeom(page);
const [wStart, , , wEnd] = link.points;
check('溢出回归：选中 chip 位于右半区', link.chip.cx > link.panel.cx + 100,
  { chipCx: link.chip.cx, panelCx: link.panel.cx });
check('溢出回归：折线起点 = chip 底中、终点 = 管理栏顶边中点', !link.hidden
  && Math.abs(wStart[0] - (link.chip.cx - link.page.left)) < 1
  && Math.abs(wStart[1] - (link.chip.bottom - link.page.top)) < 1
  && Math.abs(wEnd[0] - (link.panel.cx - link.page.left)) < 1
  && Math.abs(wEnd[1] - (link.panel.top - link.page.top)) < 1
  && wStart[0] <= link.chipsRight - link.page.left, link);
check('溢出回归：折线颜色 = 选中组颜色', link.stroke === link.border,
  { stroke: link.stroke, border: link.border });

// ---- 选中 chip 滚出 chips 视口：折线隐藏 ----
await page(`document.querySelectorAll('.gp-chip')[0].click()`);
await sleep(200);
await page(`document.querySelector('#gp-chips').scrollLeft = document.querySelector('#gp-chips').scrollWidth`);
await sleep(200);
check('滚动：选中 chip 滚出视口后折线隐藏', await page(
  `document.querySelector('#gp-link').hasAttribute('hidden')`,
));
await closeWui();

// ---- 书签视图回归：无 hash 不受影响 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1280, height: 800 }).then(() => true)`);
page = await attachPage('wui.html');
for (let i = 0; i < 40; i++) {
  const ready = await page(`!!document.querySelector('#page-bookmarks') && !document.querySelector('#page-bookmarks').hidden`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(200);
check('书签视图：无 hash 时正常显示、groups 隐藏', await page(
  `!document.querySelector('#page-bookmarks').hidden && document.querySelector('#page-groups').hidden`,
));
await closeWui();

summary();
close();
