/**
 * M27 自动化验收：groups 视图左栏条目管理。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 条目列表渲染（favicon/标题/url、锁定/删除按钮）
 * - 锁定/取消锁定、删除 → storage 持久化
 * - +add tab 二选一菜单：手动输入（无 scheme 补 https://，追加到组末尾）/ Esc 取消
 * - 抓取当前活动标签（launcherSource 来源窗口）
 * - 长按拖动排序（DOM 顺序与 storage 一致）
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m27-test')`);

// ---- 种子：groupA(red) 3 条条目，groupB(green) 空 ----
const seed = JSON.parse(await sw(`(async () => {
  const a = await __vipper.groups.addGroup({ title: 'work', color: 'red' });
  const def = await __vipper.groups.getGroup(a.id);
  def.entries.push(
    { id: 'e1', url: 'https://a.com', title: '页面A', locked: false },
    { id: 'e2', url: 'https://b.com', title: '页面B', locked: false },
    { id: 'e3', url: 'https://c.com', title: '页面C', locked: false },
  );
  await __vipper.groups.saveGroup(def);
  const b = await __vipper.groups.addGroup({ title: 'empty', color: 'green' });
  return JSON.stringify({ a: a.id, b: b.id });
})()`));

async function openGroups() {
  await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html#groups'), type: 'popup', width: 1280, height: 800 }).then(() => true)`);
  const page = await attachPage('wui.html#groups');
  for (let i = 0; i < 40; i++) {
    const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(300);
  return page;
}

async function closeWui() {
  await sw(`(async () => {
    const ws = (await chrome.windows.getAll({ populate: true }))
      .filter((x) => x.tabs?.some((t) => t.url?.startsWith(chrome.runtime.getURL('wui.html'))));
    for (const w of ws) await chrome.windows.remove(w.id);
  })()`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(100);
  await sleep(200);
}

const key = async (page, k) => {
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  await sleep(120);
};

const domEntries = (page) => page(`JSON.stringify([...document.querySelectorAll('.gp-entry')].map((r) => ({
  id: r.dataset.id,
  title: r.querySelector('.gp-entry-title').textContent,
  url: r.querySelector('.gp-entry-url').textContent,
  locked: r.querySelector('.gp-entry-lock').classList.contains('on'),
  hasSvg: !!r.querySelector('.gp-entry-lock svg') && !!r.querySelector('.gp-entry-del svg'),
  shackle: r.querySelector('.gp-entry-lock svg path:last-child')?.getAttribute('d') ?? '',
  favicon: !!r.querySelector('img.favicon'),
})))`).then(JSON.parse);

const stored = (id) =>
  sw(`__vipper.groups.getGroup(${JSON.stringify(id)}).then((g) => JSON.stringify(g.entries))`).then(JSON.parse);

let page = await openGroups();

// ---- 渲染 ----
let rows = await domEntries(page);
check('渲染：3 条条目（标题/url/favicon/SVG 图标）',
  rows.length === 3 && rows[0].title === '页面A' && rows[0].url === 'https://a.com'
  && rows[0].favicon && rows[0].hasSvg && !rows[0].locked
  && rows[0].shackle.includes('10.5'), rows);

// ---- 锁定 / 取消锁定 ----
await page(`document.querySelector('.gp-entry[data-id="e1"] .gp-entry-lock').click()`);
await sleep(300);
let es = await stored(seed.a);
check('锁定：storage locked=true', es[0].id === 'e1' && es[0].locked === true, es[0]);
rows = await domEntries(page);
check('锁定：SVG 切换为闭合锁 + on',
  rows[0].locked && rows[0].shackle.includes('5.5'), rows[0]);
await page(`document.querySelector('.gp-entry[data-id="e1"] .gp-entry-lock').click()`);
await sleep(300);
es = await stored(seed.a);
check('取消锁定：storage locked=false', es[0].locked === false, es[0]);

// ---- 删除 ----
await page(`document.querySelector('.gp-entry[data-id="e2"] .gp-entry-del').click()`);
await sleep(300);
es = await stored(seed.a);
rows = await domEntries(page);
check('删除：storage 与 DOM 都剩 e1/e3', es.length === 2 && es[1].id === 'e3' && rows.length === 2 && rows[1].id === 'e3', { es, rows });

// ---- +add tab：手动输入 ----
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(120);
check('+add tab：二选一菜单出现', await page(`!document.querySelector('#gp-add-menu').hidden`));
await page(`document.querySelector('#gp-add-manual').click()`);
await sleep(120);
check('手动输入：表单出现且 URL 聚焦', await page(
  `!!document.querySelector('.gp-add-form') && document.activeElement.placeholder === '页面 URL'`,
));
await page(`(() => {
  const [url, title] = document.querySelectorAll('.gp-add-form input');
  url.value = 'example.com';
  title.value = 'Example';
  document.querySelector('.gp-add-form .btn-primary').click();
})()`);
await sleep(300);
es = await stored(seed.a);
check('手动输入：追加到组末尾 + 无 scheme 补 https://',
  es.length === 3 && es[2].url === 'https://example.com' && es[2].title === 'Example' && !es[2].locked, es[2]);
const idxA = JSON.parse(await sw(`__vipper.groups.listGroups().then(JSON.stringify)`))[0];
check('手动输入：索引 entryCount=3', idxA.entryCount === 3, idxA);

// ---- Esc 逐层取消（表单 / 菜单） ----
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(120);
await page(`document.querySelector('#gp-add-manual').click()`);
await sleep(120);
await key(page, 'Escape');
check('Esc：关闭添加表单', await page(`!document.querySelector('.gp-add-form')`));
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(120);
await key(page, 'Escape');
check('Esc：关闭二选一菜单', await page(`document.querySelector('#gp-add-menu').hidden`));

// ---- 长按拖动排序：浮起 / 让位 / 跟随 / 落位（e1 拖到末尾） ----
const dragStart = await page(`(() => {
  const rows = [...document.querySelectorAll('.gp-entry')];
  const a = rows[0].getBoundingClientRect();
  window.__grab = { x: a.left + 20, y: a.top + 10 };
  window.__pitch = rows[1].getBoundingClientRect().top - a.top;
  window.__lastBottom = rows[rows.length - 1].getBoundingClientRect().bottom;
  rows[0].dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: window.__grab.x, clientY: window.__grab.y,
  }));
  return JSON.stringify({ left: a.left, top: a.top, pitch: window.__pitch });
})()`).then(JSON.parse);
await sleep(500); // 超过 400ms 长按阈值

let lift = await page(`(() => {
  const row = document.querySelector('.gp-entry.dragging');
  const cs = row && getComputedStyle(row);
  const r = row?.getBoundingClientRect();
  return JSON.stringify({
    box: document.querySelector('#gp-entries').classList.contains('dragging'),
    position: cs?.position, shadow: cs?.boxShadow, events: cs?.pointerEvents,
    left: r?.left, top: r?.top,
    shifts: [...document.querySelectorAll('.gp-entry:not(.dragging)')]
      .map((x) => { const t = x.style.transform; return t ? parseFloat(t.slice(t.indexOf('(') + 1)) : 0; }),
  });
})()`).then(JSON.parse);
check('拖动效果：长按后条目悬空（fixed + 阴影 + 不吃指针事件）',
  lift.box && lift.position === 'fixed' && lift.shadow !== 'none' && lift.events === 'none', lift);
check('拖动效果：浮起后留在原槽位，下方条目让出一个空档',
  Math.abs(lift.top - dragStart.top) < 2 && Math.abs(lift.left - dragStart.left) < 2
  && lift.shifts.length === 2 && lift.shifts.every((y) => Math.abs(y - dragStart.pitch) < 1),
  { lift, dragStart });

// 跟随：把指针往下推 40px，卡片顶边也下移 40px（抓取点偏移 10px 保持）
await page(`window.dispatchEvent(new PointerEvent('pointermove', {
  bubbles: true, clientX: window.__grab.x, clientY: window.__grab.y + 40,
}))`);
await sleep(80);
lift = await page(`(() => {
  const r = document.querySelector('.gp-entry.dragging').getBoundingClientRect();
  return JSON.stringify({ top: r.top, expect: window.__grab.y + 40 - 10 });
})()`).then(JSON.parse);
check('拖动效果：卡片跟随指针（保持抓取点偏移）', Math.abs(lift.top - lift.expect) < 3, lift);

// 拖到末尾：空档移到末尾，上方条目收回让位（有过渡 → 视觉上是滑动）
await page(`window.dispatchEvent(new PointerEvent('pointermove', {
  bubbles: true, clientX: window.__grab.x, clientY: window.__lastBottom + 10,
}))`);
await sleep(220);
lift = await page(`(() => JSON.stringify({
  shifts: [...document.querySelectorAll('.gp-entry:not(.dragging)')]
    .map((r) => { const t = r.style.transform; return t ? parseFloat(t.slice(t.indexOf('(') + 1)) : 0; }),
}))()`).then(JSON.parse);
check('拖动效果：拖到末尾时空档跟着过来（上方条目收回位移）',
  lift.shifts.length === 2 && lift.shifts.every((y) => y === 0), lift);

await page(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
await sleep(450); // 落位动画 140ms + 写回 storage
rows = await domEntries(page);
es = await stored(seed.a);
check('拖动排序：e1 移到末尾，DOM 与 storage 顺序一致',
  rows.length === 3 && rows[2].id === 'e1' && es.map((x) => x.id).join() === rows.map((x) => x.id).join(),
  { dom: rows.map((x) => x.id), stored: es.map((x) => x.id) });
check('拖动落地：拖动态清零（无 fixed / 无残留位移 / 容器类移除）', await page(`(() => {
  const box = document.querySelector('#gp-entries');
  return !box.classList.contains('dragging')
    && [...document.querySelectorAll('.gp-entry')].every((r) =>
      !r.classList.contains('dragging') && r.style.transform === ''
      && getComputedStyle(r).position === 'static');
})()`));

// ---- 中间槽位落位：松手后卡片要滑到空档里，不能差一格（落点读的是文档流槽位，不是实时 rect） ----
const d2 = await page(`(() => {
  const rows = [...document.querySelectorAll('.gp-entry')];
  const lastRow = rows[rows.length - 1];
  const a = lastRow.getBoundingClientRect();
  const pitch = a.height + parseFloat(getComputedStyle(lastRow).marginBottom);
  window.__d2 = { x: a.left + 30, y: a.top + 12, pitch };
  lastRow.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: window.__d2.x, clientY: window.__d2.y,
  }));
  return JSON.stringify({ id: lastRow.dataset.id, pitch, top: a.top });
})()`).then(JSON.parse);
await sleep(500);
await page(`window.dispatchEvent(new PointerEvent('pointermove', {
  bubbles: true, clientX: window.__d2.x, clientY: window.__d2.y - window.__d2.pitch * 1.5,
}))`);
await sleep(200);
await page(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
await sleep(90);
const landing = await page(`(() => {
  const row = document.querySelector('.gp-entry.dragging');
  return JSON.stringify({ mid: row?.getBoundingClientRect().top ?? null, left: row?.isConnected ?? false });
})()`).then(JSON.parse);
await sleep(400);
const landed = await page(`(() => {
  const row = document.querySelector('.gp-entry[data-id="${d2.id}"]');
  const box = document.querySelector('#gp-entries');
  return JSON.stringify({
    top: row.getBoundingClientRect().top,
    index: [...box.querySelectorAll('.gp-entry')].indexOf(row),
    ids: [...box.querySelectorAll('.gp-entry')].map((r) => r.dataset.id),
    clean: !box.classList.contains('dragging') && row.style.transform === ''
      && getComputedStyle(row).position === 'static',
  });
})()`).then(JSON.parse);
check('拖动落位：中间槽位落点准确（松手后不差一格）',
  landing.mid !== null && Math.abs(landing.mid - landed.top) < d2.pitch * 0.6, { landing, landed, pitch: d2.pitch });
check('拖动落位：中间槽位写回顺序 + 拖动态清零',
  landed.index > 0 && landed.index < landed.ids.length - 1 && landed.clean,
  { landed, dragged: d2.id });
es = await stored(seed.a);
check('拖动落位：storage 顺序与 DOM 一致（中间槽位）',
  es.map((x) => x.id).join() === landed.ids.join(), { stored: es.map((x) => x.id), dom: landed.ids });

// ---- 抓取当前活动标签（launcherSource 路径） ----
await closeWui();
await sw(`(async () => {
  const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
  await chrome.tabs.create({ windowId: win.id, active: true, url: 'data:text/html,<title>Grab Page</title><h1>grab</h1>' });
})()`);
await sleep(600); // 等标题就绪
await sw(`__vipper.dispatch('open-groups')`);
await sleep(500);
page = await attachPage('wui.html#groups');
for (let i = 0; i < 40; i++) {
  const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(300);
await page(`document.querySelector('#gp-add-tab').click()`);
await sleep(120);
await page(`document.querySelector('#gp-add-grab').click()`);
await sleep(400);
es = await stored(seed.a);
const grabbed = es[es.length - 1];
check('抓取当前标签：来源窗口活动标签入组（url + 标题）',
  grabbed?.url.startsWith('data:text/html') && grabbed?.title === 'Grab Page', grabbed);
await closeWui();

// ---- 删除标签组：二次确认 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html#groups'), type: 'popup', width: 1280, height: 800 }).then(() => true)`);
page = await attachPage('wui.html#groups');
for (let i = 0; i < 40; i++) {
  const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(400);
await page(`document.querySelector('.gp-chip[data-id="${seed.b}"]').click()`);
await sleep(250);
await page(`document.querySelector('#gp-del-group').click()`);
await sleep(250);
const stillThere = await sw(`__vipper.groups.getGroup(${JSON.stringify(seed.b)}).then((g) => g !== null)`);
check('删除组：首次点击仅进入确认态（组仍在）',
  stillThere === true && await page(`document.querySelector('#gp-del-group').classList.contains('confirming')`),
  { stillThere });
await page(`document.querySelector('#gp-del-group').click()`);
await sleep(500);
const gone = await sw(`__vipper.groups.getGroup(${JSON.stringify(seed.b)}).then((g) => g === null)`);
const chipCount = await page(`document.querySelectorAll('.gp-chip').length`);
check('删除组：二次点击后删除（storage + chips + 选中回退）',
  gone === true && chipCount === 1
    && await page(`document.querySelector('.gp-chip.selected')?.dataset.id === ${JSON.stringify(seed.a)}`),
  { gone, chipCount });
await closeWui();

summary();
close();
