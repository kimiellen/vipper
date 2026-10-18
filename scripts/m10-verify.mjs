/**
 * M10 自动化验收：wui 主页面固定高度 + 加宽 + 单行裁切。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 页面锁定视口高度、整页不滚动；三块同高且适配视口
 * - results / Settings / contents 各自内部滚动，results 表头吸顶
 * - results 主列变宽；基础信息列单行、超宽时两侧渐隐裁切且悬停有完整内容
 * - results 键盘 ↑ 回到首行时，选中行完整显示在吸顶表头下方（不被遮挡）
 */

import { writeFileSync } from 'node:fs';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景数据：长书名 / 多 tag / 多 linkedInfo / 长详情 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m10-test');
  const colors = ['mauve','sky','green','peach','yellow','pink','teal','blue'];
  const tags = [];
  for (let i = 0; i < 18; i++) tags.push(await __vipper.vault.addTag('long-tag-name-' + i, colors[i % colors.length]));
  const links = [];
  for (let i = 0; i < 18; i++) links.push(await __vipper.vault.addLinkedInfo('linkedinfo-name-' + i, 'value-' + i));
  const longTitle = '这是一个非常长的书签名称用于验证单行两侧渐隐裁切不会换行也不会撑开表格';
  await __vipper.vault.addBookmark({
    title: longTitle,
    remarks: '超长详情验证：'.repeat(30),
    tags: tags.map((t) => t.id),
    linkedInfos: links.map((l) => l.id),
    urls: Array.from({ length: 16 }, (_, i) => ({ url: 'https://example.com/path/' + i, match: 'host' })),
    accounts: Array.from({ length: 16 }, (_, i) => ({ username: 'user-' + i, password: 'pw-' + i })),
    records: Array.from({ length: 16 }, (_, i) => ({ template: 'note', name: 'note-' + i, content: 'content-' + i })),
  });
  for (let i = 0; i < 30; i++) {
    await __vipper.vault.addBookmark({
      title: 'bookmark-' + i,
      urls: [{ url: 'https://site-' + i + '.example.com', match: 'host' }],
    });
  }
  return JSON.stringify({ longTitle });
})()`));

// ---- 打开 wui 页（与 background 默认尺寸一致）----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const page = await attachPage('wui.html');
// headless 下 chrome.windows.create 的宽高不可靠（默认 800×600），用 DevTools 视口模拟真实 1600×900 窗口做布局验收
await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(300);
for (let i = 0; i < 40; i++) {
  const n = await page(`document.querySelectorAll('#results-body tr').length`).catch(() => 0);
  if (n > 0) break;
  await sleep(250);
}
await sleep(400);

// ---- 页面与三块：固定高度、无整页滚动 ----
const layout = JSON.parse(await page(`JSON.stringify({
  innerW: innerWidth,
  innerH: innerHeight,
  bodyOverflow: getComputedStyle(document.body).overflow,
  docScrollH: document.scrollingElement.scrollHeight,
  docClientH: document.scrollingElement.clientHeight,
  pageH: document.querySelector('.page').getBoundingClientRect().height,
  blockHeights: [...document.querySelectorAll('.blk')].map((b) => b.getBoundingClientRect().height),
  blockTops: [...document.querySelectorAll('.blk')].map((b) => b.getBoundingClientRect().top),
  resultsW: document.querySelector('.blocks-grid .blk:nth-child(2)').getBoundingClientRect().width,
  settingsW: document.querySelector('.blocks-grid .blk:nth-child(1)').getBoundingClientRect().width,
  contentsW: document.querySelector('.blocks-grid .blk:nth-child(3)').getBoundingClientRect().width,
  rowHeights: [...document.querySelectorAll('#results-body tr')].slice(0, 5).map((r) => r.getBoundingClientRect().height),
  favW: document.querySelector('#results-body td:nth-child(1)').getBoundingClientRect().width,
  favImgW: document.querySelector('#results-body td:nth-child(1) img')?.getBoundingClientRect().width,
  titleClip: (() => {
    const td = [...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent.includes('非常长'));
    const clip = td.cells[1].querySelector('.cell-clip');
    return { clipped: clip.scrollWidth > clip.clientWidth, overflow: getComputedStyle(clip).overflow,
      whiteSpace: getComputedStyle(clip).whiteSpace, mask: getComputedStyle(clip).maskImage,
      hover: td.cells[1].title };
  })(),
  tagsClip: (() => {
    const td = [...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent.includes('非常长'));
    const clip = td.cells[2].querySelector('.cell-clip');
    return { clipped: clip.scrollWidth > clip.clientWidth, hover: td.cells[2].title, count: clip.children.length };
  })(),
  colWidths: [3, 4].map((n) => document.querySelector('#results-body tr td:nth-child(' + n + ')').getBoundingClientRect().width),
})`));

check('页面宽度加至 1600 档（innerWidth ≥ 1500）', layout.innerW >= 1500, layout.innerW);
check('页面高度锁定视口（.page 高 = innerHeight）', Math.abs(layout.pageH - layout.innerH) <= 1, {
  pageH: layout.pageH, innerH: layout.innerH,
});
check('整页不滚动（body overflow:hidden 且文档无溢出）',
  layout.bodyOverflow === 'hidden' && layout.docScrollH <= layout.docClientH + 1,
  { overflow: layout.bodyOverflow, scrollH: layout.docScrollH, clientH: layout.docClientH });
check('三块同高且从同一顶边开始',
  Math.max(...layout.blockHeights) - Math.min(...layout.blockHeights) <= 1 &&
  Math.max(...layout.blockTops) - Math.min(...layout.blockTops) <= 1, layout.blockHeights);
check('results 是加宽主区域（宽于左右侧栏，≥ 700px）',
  layout.resultsW >= 700 && layout.resultsW > layout.settingsW && layout.resultsW > layout.contentsW,
  { results: layout.resultsW, settings: layout.settingsW, contents: layout.contentsW });
check('tags / linkedInfos 列有足够宽度（各 ≥ 150px）',
  layout.colWidths.every((w) => w >= 150), layout.colWidths);
check('results 行保持单行高度（≤ 40px 且一致）',
  layout.rowHeights.every((h) => h <= 40) && Math.max(...layout.rowHeights) - Math.min(...layout.rowHeights) <= 1,
  layout.rowHeights);
check('favicon 列完整展示 16px 图标（未被内边距裁切）',
  layout.favW >= 32 && layout.favImgW === 16, { cell: layout.favW, img: layout.favImgW });
check('书签名超宽：单行裁切 + 两端渐隐 + 悬停完整标题',
  layout.titleClip.clipped && layout.titleClip.overflow === 'hidden' &&
  layout.titleClip.whiteSpace === 'nowrap' && layout.titleClip.mask.includes('linear-gradient') &&
  layout.titleClip.hover === seed.longTitle, layout.titleClip);
check('tags 超宽：单行裁切 + 悬停列出全部 tag',
  layout.tagsClip.clipped && layout.tagsClip.count === 18 && layout.tagsClip.hover.split(', ').length === 18,
  layout.tagsClip);

// ---- results 内部滚动 + 表头吸顶 ----
const scrollState = JSON.parse(await page(`(() => {
  const body = document.querySelector('.results-body');
  const head = body.querySelector('thead th:nth-child(2)');
  window.scrollTo(0, 500);
  const pageScroll = window.scrollY;
  const before = { scrollH: body.scrollHeight, clientH: body.clientHeight, headTop: head.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top };
  body.scrollTop = 300;
  const after = { scrollTop: body.scrollTop, headTop: head.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top };
  return JSON.stringify({ pageScroll, before, after });
})()`));
check('results 内容超出时内部出现滚动（不滚整页）',
  scrollState.before.scrollH > scrollState.before.clientH && scrollState.pageScroll === 0,
  scrollState);
check('results 表头滚动时吸顶',
  scrollState.after.scrollTop > 0 &&
  Math.abs(scrollState.after.headTop - scrollState.after.bodyTop) <= 2, scrollState.after);

// ---- 键盘导航：↑ 回到首行时选中行不被吸顶表头遮挡 ----
// 回归：scrollIntoView({block:'nearest'}) 把行顶对齐到视口顶边、忽略吸顶表头，首行会被盖住。
const navState = JSON.parse(await page(`(async () => {
  const body = document.querySelector('.results-body');
  const press = async (key, n) => {
    for (let i = 0; i < n; i++) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await press('ArrowDown', 25); // 滚到列表下部
  const down = body.scrollTop;
  await press('ArrowUp', 40);   // 回到首行
  const head = body.querySelector('thead th').getBoundingClientRect();
  const row = document.querySelector('#results-body tr.row-selected');
  const r = row.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  return JSON.stringify({
    scrolledDown: down > 0,
    scrollTop: body.scrollTop,
    headBottom: head.bottom, rowTop: r.top, rowBottom: r.bottom, viewBottom: b.bottom,
    text: row.cells[1].textContent,
  });
})()`));
check('↑ 回到首行：选中行完整显示在吸顶表头下方（不被遮挡）',
  navState.scrolledDown && navState.scrollTop <= 2 &&
  navState.rowTop >= navState.headBottom - 1 && navState.rowBottom <= navState.viewBottom + 1,
  navState);

// ---- Settings 内部滚动 ----
await page(`document.querySelector('.set-group-tags .set-head').click()`);
await sleep(300);
const settingsScroll = JSON.parse(await page(`(() => {
  const body = document.querySelector('.settings-body');
  window.scrollTo(0, 500);
  return JSON.stringify({
    pageScroll: window.scrollY,
    scrollH: body.scrollHeight, clientH: body.clientHeight,
    blockH: body.closest('.blk').getBoundingClientRect().height,
  });
})()`));
check('Settings 内容超出时只在自身内部滚动（页面仍不动）',
  settingsScroll.scrollH > settingsScroll.clientH && settingsScroll.pageScroll === 0, settingsScroll);

// ---- contents 内部滚动 ----
await page(`[...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent.includes('非常长')).click()`);
for (let i = 0; i < 20; i++) {
  if (await page(`document.querySelectorAll('#contents-view .kv-block').length`) > 3) break;
  await sleep(150);
}
await sleep(300);
const contentsScroll = JSON.parse(await page(`(() => {
  const body = document.querySelector('#contents-view');
  const blk = body.closest('.blk');
  return JSON.stringify({
    scrollH: body.scrollHeight, clientH: body.clientHeight,
    blockH: blk.getBoundingClientRect().height,
    pageScroll: window.scrollY,
    pageH: document.querySelector('.page').getBoundingClientRect().height,
    innerH: innerHeight,
  });
})()`));
check('contents 内容超出时只在自身内部滚动（三块高度仍固定）',
  contentsScroll.scrollH > contentsScroll.clientH && contentsScroll.pageScroll === 0 &&
  Math.abs(contentsScroll.blockH - layout.blockHeights[2]) <= 1 &&
  Math.abs(contentsScroll.pageH - contentsScroll.innerH) <= 1, contentsScroll);

// ---- 截图证据 ----
await page(`document.querySelector('.results-body').scrollTop = 0`);
await page.send('Page.enable');
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('tmp/shot-m10-layout.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图: tmp/shot-m10-layout.png');

summary();
close();
