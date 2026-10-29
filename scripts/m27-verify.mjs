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

// ---- 长按拖动排序：e1 拖到末尾 ----
await page(`(() => {
  const rows = [...document.querySelectorAll('.gp-entry')];
  const row = rows[0];
  const last = rows[rows.length - 1].getBoundingClientRect();
  window.__dragY = last.bottom + 10;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
})()`);
await sleep(500); // 长按阈值 400ms
await page(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: window.__dragY }))`);
await sleep(120);
await page(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
await sleep(300);
rows = await domEntries(page);
es = await stored(seed.a);
check('拖动排序：e1 移到末尾，DOM 与 storage 顺序一致',
  rows.length === 3 && rows[2].id === 'e1' && es.map((x) => x.id).join() === rows.map((x) => x.id).join(),
  { dom: rows.map((x) => x.id), stored: es.map((x) => x.id) });

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
