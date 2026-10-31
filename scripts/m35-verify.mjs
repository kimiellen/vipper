/**
 * M35 自动化验收：groups 视图 chips 排序 + 组编辑 + 打开时浏览器组排序。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - chips 长按 400ms 拖动：被拖 chip 浮起（position:fixed）、其余 chips 让位、连接线临时隐藏；
 *   松手后 DOM 顺序与 storage 索引按新顺序落盘，选中组不因拖动改变
 * - 管理栏 ✎ 编辑：内联表单回填组名/颜色；空名拒绝；保存后快照、chips 与已打开 chrome 组同步；
 *   Esc 收起
 * - 回车打开组：目标窗口内已打开的 vipper 组按 chips 顺序重排（新开与重激活两种路径），
 *   且重排前后各组的 collapsed 状态保持
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m35-test')`);

const U = (n) => `data:text/html,<title>P${n}</title>`;

const ids = JSON.parse(await sw(`(async () => {
  const mk = async (title, color, entries) => {
    const g = await __vipper.groups.addGroup({ title, color });
    const def = await __vipper.groups.getGroup(g.id);
    def.entries.push(...entries);
    await __vipper.groups.saveGroup(def);
    return g.id;
  };
  return JSON.stringify({
    a: await mk('alpha', 'blue', [
      { id: 'a1', url: '${U('A1')}', title: 'A1', locked: false },
      { id: 'a2', url: '${U('A2')}', title: 'A2', locked: false },
    ]),
    b: await mk('beta-long', 'green', [
      { id: 'b1', url: '${U('B1')}', title: 'B1', locked: false },
      { id: 'b2', url: '${U('B2')}', title: 'B2', locked: false },
    ]),
    c: await mk('gamma', 'red', [
      { id: 'c1', url: '${U('C1')}', title: 'C1', locked: false },
    ]),
  });
})()`));

const srcWin = await sw(`chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws[0].id)`);

const openWui = async () => {
  await sw(`__vipper.dispatch('open-groups')`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(400);
  // 按实际使用宽度跑布局断言（弹窗最小 900、常见 1162）：避免 800 视口下的极端挤压
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1162, height: 700, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(200);
  return page;
};

/** 打开 wui → 单击 chip 选中 → 回车打开；等待弹窗关闭 */
const openGroup = async (groupId) => {
  const page = await openWui();
  await page(`document.querySelector('.gp-chip[data-id="${groupId}"]')?.click()`);
  await sleep(250);
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(150);
  await sleep(500);
};

/** 目标窗口内所有 chrome 组：按组首页签 index 排序，附折叠态与组内 url */
const browserGroups = () =>
  sw(`(async () => {
    const tabs = (await chrome.tabs.query({ windowId: ${srcWin} })).sort((x, y) => x.index - y.index);
    const groups = await chrome.tabGroups.query({ windowId: ${srcWin} });
    const blocks = groups
      .map((g) => ({
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
        tabs: tabs.filter((t) => t.groupId === g.id),
      }))
      .filter((b) => b.tabs.length > 0)
      .sort((x, y) => x.tabs[0].index - y.tabs[0].index)
      .map((b) => ({ title: b.title, color: b.color, collapsed: b.collapsed, urls: b.tabs.map((t) => t.url) }));
    return JSON.stringify(blocks);
  })()`).then(JSON.parse);

const chipOrder = (page) =>
  page(`JSON.stringify([...document.querySelectorAll('.gp-chip')].map((c) => c.dataset.id))`).then(JSON.parse);

const storedOrder = () =>
  sw(`__vipper.groups.listGroups().then((gs) => JSON.stringify(gs.map((g) => g.id)))`).then(JSON.parse);

const A = ids.a;
const B = ids.b;
const C = ids.c;

const titles = (blocks) => blocks.map((b) => b.title).join(',');

// ---- 打开时按 chips 排序：故意按 C → A → B 的顺序打开 ----
await openGroup(C);
let blocks = await browserGroups();
check('打开 C：窗口内仅有 gamma', titles(blocks) === 'gamma', blocks);

await openGroup(A);
blocks = await browserGroups();
check('打开 A（chips 顺序在 C 前）：浏览器组重排为 alpha,gamma',
  titles(blocks) === 'alpha,gamma', blocks);
check('打开 A：仍各占连续标签块',
  blocks.length === 2 && blocks[0].urls.length === 2 && blocks[1].urls.length === 1, blocks);

await openGroup(B);
blocks = await browserGroups();
check('打开 B：浏览器组按 chips 顺序 alpha,beta-long,gamma',
  titles(blocks) === 'alpha,beta-long,gamma', blocks);
check('打开 B：组内 url 顺序不变',
  blocks[0].urls.join() === `${U('A1')},${U('A2')}`
  && blocks[1].urls.join() === `${U('B1')},${U('B2')}`
  && blocks[2].urls.join() === U('C1'), blocks);

// ---- 重激活路径：手动打乱顺序 + 折叠 B，回车 A 后应恢复 chips 顺序且折叠态不变 ----
await sw(`(async () => {
  const mA = (await chrome.storage.session.get('opengrp:${A}'))['opengrp:${A}'];
  const mB = (await chrome.storage.session.get('opengrp:${B}'))['opengrp:${B}'];
  const tabsB = Object.keys(mB.tabs).map(Number);
  await chrome.tabs.update(Number(Object.keys(mA.tabs)[0]), { active: true });
  await chrome.tabs.move(tabsB, { index: 0 });
  await chrome.tabGroups.update(mB.chromeGroupId, { collapsed: true });
  await chrome.tabGroups.update(mA.chromeGroupId, { collapsed: false });
})()`);
blocks = await browserGroups();
check('前置：手动把 beta-long 移到最前并折叠',
  titles(blocks) === 'beta-long,alpha,gamma' && blocks[0].collapsed === true, blocks);

await openGroup(A);
blocks = await browserGroups();
check('重激活 A：浏览器组恢复 alpha,beta-long,gamma',
  titles(blocks) === 'alpha,beta-long,gamma', blocks);
check('重激活 A：beta-long 仍折叠，alpha 仍展开',
  blocks.find((b) => b.title === 'beta-long')?.collapsed === true
  && blocks.find((b) => b.title === 'alpha')?.collapsed === false, blocks);

// ---- 编辑组：内联表单 + 保存同步快照/chips/已打开 chrome 组 ----
let page = await openWui();
await page(`document.querySelector('.gp-chip[data-id="${A}"]')?.click()`);
await sleep(250);
await page(`document.querySelector('#gp-edit-group').click()`);
await sleep(250);
let editState = JSON.parse(await page(`JSON.stringify((() => {
  const form = document.querySelector('#gp-edit');
  const editBtn = document.querySelector('#gp-edit-group');
  const name = document.querySelector('#gp-edit-name');
  const formRect = form.getBoundingClientRect();
  const editRect = editBtn.getBoundingClientRect();
  const add = document.querySelector('#gp-add-tab');
  const addRect = add.getBoundingClientRect();
  const dotEls = [...document.querySelectorAll('#gp-edit-colors .gp-dot')];
  const onDot = document.querySelector('#gp-edit-colors .gp-dot.on');
  return {
    open: !form.hidden,
    value: name.value,
    dots: dotEls.length,
    onColor: onDot?.title ?? null,
    focused: document.activeElement.id,
    inRow: document.querySelector('#gp-head-row').contains(form),
    beforeEdit: (form.compareDocumentPosition(editBtn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    addVisible: getComputedStyle(add).display !== 'none',
    addRight: Math.round(addRect.right),
    formLeft: Math.round(formRect.left),
    formRight: Math.round(formRect.right),
    editLeft: Math.round(editRect.left),
    editRight: Math.round(editRect.right),
    delLeft: Math.round(document.querySelector('#gp-del-group').getBoundingClientRect().left),
    nameWidth: Math.round(name.getBoundingClientRect().width),
    dotRows: new Set(dotEls.map((d) => Math.round(d.getBoundingClientRect().top))).size,
    checkGlyph: onDot ? getComputedStyle(onDot, '::after').content : null,
  };
})())`));
check('✎ 展开内联表单：回填组名/蓝点/焦点在输入框',
  editState.open && editState.value === 'alpha' && editState.dots === 9
  && editState.onColor === 'blue' && editState.focused === 'gp-edit-name', editState);
check('组名输入框 140px、9 色单行、选中色有 ✓ 标识',
  Math.abs(editState.nameWidth - 140) <= 1 && editState.dotRows === 1
  && editState.checkGlyph?.includes('✓'), editState);
check('表单在 ✎ 左侧且不覆盖 + 添加页面；✎ 与删除紧挨（间隙 ≤12px）',
  editState.inRow && editState.beforeEdit && editState.formLeft >= editState.addRight
  && editState.addVisible && editState.formRight <= editState.editLeft
  && editState.delLeft - editState.editRight <= 12, editState);

await page(`(() => {
  document.querySelector('#gp-edit-name').value = '';
  document.querySelector('#gp-edit-ok').click();
})()`);
await sleep(300);
check('空名拒绝：表单保留且快照标题不变',
  await page(`!document.querySelector('#gp-edit').hidden`)
  && (await sw(`__vipper.groups.getGroup(${JSON.stringify(A)}).then((g) => g.title)`) === 'alpha'));

await page(`(() => {
  const name = document.querySelector('#gp-edit-name');
  name.value = 'alpha-renamed';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#gp-edit-colors .gp-dot[title="orange"]').click();
  document.querySelector('#gp-edit-ok').click();
})()`);
await sleep(800);
const defAfterEdit = JSON.parse(await sw(`__vipper.groups.getGroup(${JSON.stringify(A)}).then((g) => JSON.stringify({ title: g.title, color: g.color }))`));
check('保存：快照标题/颜色更新',
  defAfterEdit.title === 'alpha-renamed' && defAfterEdit.color === 'orange', defAfterEdit);
const chipAfterEdit = JSON.parse(await page(`(() => {
  const c = document.querySelector('.gp-chip[data-id="${A}"]');
  return JSON.stringify({ text: c.textContent, color: c.style.color });
})()`));
check('保存：chip 文案与颜色跟随',
  chipAfterEdit.text === 'alpha-renamed' && chipAfterEdit.color === 'var(--cat-peach)', chipAfterEdit);
blocks = await browserGroups();
check('保存：已打开的 chrome 组标题/颜色同步',
  blocks[0].title === 'alpha-renamed' && blocks[0].color === 'orange', blocks[0]);

await page(`document.querySelector('#gp-edit-group').click()`);
await sleep(150);
await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
await sleep(150);
check('Esc：收起编辑表单并恢复 + 添加页面',
  await page(`document.querySelector('#gp-edit').hidden
    && getComputedStyle(document.querySelector('#gp-add-tab')).display !== 'none'
    && !document.querySelector('#gp-head-row').classList.contains('editing')`));

// ---- chips 拖动排序：选中 gamma，把 alpha chip 拖到行尾 ----
await page(`document.querySelector('.gp-chip[data-id="${C}"]')?.click()`);
await sleep(200);
const rects = JSON.parse(await page(`JSON.stringify([...document.querySelectorAll('.gp-chip')].map((c) => {
  const r = c.getBoundingClientRect();
  return { id: c.dataset.id, left: r.left, right: r.right, top: r.top, width: r.width };
}))`));
const chipA = rects.find((r) => r.id === A);
const chipLast = rects[rects.length - 1];
const startX = chipA.left + 6;
const startY = chipA.top + 6;

await page(`(() => {
  const chip = document.querySelector('.gp-chip[data-id="${A}"]');
  chip.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse',
    clientX: ${startX}, clientY: ${startY},
  }));
})()`);
await sleep(520);
const dragState = JSON.parse(await page(`(() => {
  const chip = document.querySelector('.gp-chip[data-id="${A}"]');
  const others = [...document.querySelectorAll('.gp-chip')].filter((c) => c !== chip);
  return JSON.stringify({
    position: getComputedStyle(chip).position,
    chipDragging: chip.classList.contains('dragging'),
    boxDragging: document.querySelector('#gp-chips').classList.contains('dragging'),
    shifted: others.filter((c) => c.style.transform).length,
    linkHidden: document.querySelector('#gp-link').hasAttribute('hidden'),
  });
})()`));
check('长按 400ms：chip 浮起 + 容器进入拖动态 + 其余 chips 让位 + 连接线隐藏',
  dragState.position === 'fixed' && dragState.chipDragging && dragState.boxDragging
  && dragState.shifted >= 1 && dragState.linkHidden, dragState);

const targetX = chipLast.right + 24;
await page(`window.dispatchEvent(new PointerEvent('pointermove', {
  bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: ${targetX}, clientY: ${startY},
}))`);
await sleep(150);
await page(`window.dispatchEvent(new PointerEvent('pointerup', {
  bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: ${targetX}, clientY: ${startY},
}))`);
await sleep(700); // 吸附落位 140ms + 异步写回

check('拖动落位：DOM 顺序变为 beta-long,gamma,alpha',
  (await chipOrder(page)).join() === `${B},${C},${A}`, await chipOrder(page));
check('拖动落位：storage 索引顺序同步',
  (await storedOrder()).join() === `${B},${C},${A}`, await storedOrder());
check('拖动不改变选中组（仍为 gamma）',
  await page(`document.querySelector('.gp-chip.selected')?.dataset.id === ${JSON.stringify(C)}`));
check('落位后连接线恢复显示', await page(`!document.querySelector('#gp-link').hasAttribute('hidden')`));

// 拖动结束后普通点击仍能正常选中
await page(`document.querySelector('.gp-chip[data-id="${B}"]').click()`);
await sleep(250);
check('拖动后单击正常选中 beta-long',
  await page(`document.querySelector('.gp-chip.selected')?.dataset.id === ${JSON.stringify(B)}`));

summary();
close();
