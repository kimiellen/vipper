/**
 * M31 自动化验收：groups 视图右栏书签搜索接入。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 只列 urls 非空的 active 条目（纯记录型、归档条目不出现）
 * - 输入过滤 + 拼音（filterIndex 复用）
 * - ↑/↓ 移动选中；回车追加到当前组末尾（左栏 DOM 同步出现）
 * - 多 URL 书签回车进二级菜单选 URL；点击行同样添加
 * - TAGS 过滤生效（共享 selTags）
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m31-test')`);

const ids = JSON.parse(await sw(`(async () => {
  const tagDev = await __vipper.vault.addTag('dev', 'mauve');
  await __vipper.vault.addBookmark({ title: 'github', tags: [tagDev.id], urls: [{ url: 'https://github.com', match: 'host' }] });
  await __vipper.vault.addBookmark({ title: 'multi', urls: [{ url: 'https://a.com', match: 'host' }, { url: 'https://b.com', match: 'host' }] });
  await __vipper.vault.addBookmark({ title: '纯记录', urls: [] });
  await __vipper.vault.addBookmark({ title: '淘宝', urls: [{ url: 'https://taobao.com', match: 'host' }] });
  const arch = await __vipper.vault.addBookmark({ title: 'archived', urls: [{ url: 'https://arch.com', match: 'host' }] });
  await __vipper.vault.archiveBookmark(arch.id);
  const g = await __vipper.groups.addGroup({ title: 'work', color: 'blue' });
  return JSON.stringify({ g: g.id });
})()`));

await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html#groups'), type: 'popup', width: 1280, height: 800 }).then(() => true)`);
const page = await attachPage('wui.html#groups');
for (let i = 0; i < 40; i++) {
  const ready = await page(`!!document.querySelector('#page-groups') && !document.querySelector('#page-groups').hidden`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(400);

const resultTitles = () => page(
  `JSON.stringify([...document.querySelectorAll('.gp-result-title')].map((x) => x.textContent))`,
).then(JSON.parse);
const selectedTitle = () => page(`document.querySelector('.gp-result.selected .gp-result-title')?.textContent ?? null`);
const setQuery = async (q) => {
  await page(`(() => {
    const s = document.querySelector('#gp-search');
    s.focus();
    s.value = ${JSON.stringify(q)};
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
};
const key = async (k) => {
  await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  await sleep(250);
};
const groupUrls = () =>
  sw(`__vipper.groups.getGroup(${JSON.stringify(ids.g)}).then((g) => JSON.stringify(g.entries.map((e) => e.url)))`).then(JSON.parse);

// ---- 列表：urls 非空 + active（lastUsedAt 降序，与书签视图一致） ----
let titles = await resultTitles();
check('列表：只含 urls 非空的 active 条目（lastUsedAt 降序：淘宝/multi/github）',
  titles.join() === '淘宝,multi,github', titles);

// ---- 输入过滤 + 拼音 ----
await setQuery('git');
titles = await resultTitles();
check('过滤：git → 只剩 github', titles.join() === 'github', titles);
await setQuery('tb');
titles = await resultTitles();
check('过滤：拼音 tb → 淘宝', titles.join() === '淘宝', titles);
await setQuery('');

// ---- ↑/↓ 移动选中 ----
check('初始选中第一个（淘宝）', (await selectedTitle()) === '淘宝', await selectedTitle());
await key('ArrowDown');
check('↓：选中移到 multi', (await selectedTitle()) === 'multi', await selectedTitle());
await key('ArrowUp');
check('↑：选中回到 淘宝', (await selectedTitle()) === '淘宝', await selectedTitle());

// ---- 回车追加单 URL 书签到组末尾 ----
await key('Enter');
await sleep(400);
let urls = await groupUrls();
check('回车：taobao.com 追加到组', urls.join() === 'https://taobao.com', urls);
check('左栏：条目行同步出现', (await page(`document.querySelectorAll('.gp-entry').length`)) === 1);

// ---- 多 URL 书签：二级菜单选 URL ----
await key('ArrowDown'); // multi
await key('Enter');
await sleep(250);
check('多 URL：二级菜单出现（2 项）', await page(
  `!document.querySelector('#url-menu').hidden && document.querySelectorAll('#url-menu-card .menu-item').length === 2`,
));
await key('ArrowDown'); // 选 b.com
await key('Enter');
await sleep(400);
urls = await groupUrls();
check('多 URL：选定 b.com 追加（菜单已关）',
  urls.join() === 'https://taobao.com,https://b.com'
    && await page(`document.querySelector('#url-menu').hidden`), urls);

// ---- 点击行添加 ----
await page(`[...document.querySelectorAll('.gp-result')].find((r) => r.textContent.includes('github')).click()`);
await sleep(400);
urls = await groupUrls();
check('点击行：github.com 追加到组末尾', urls.join() === 'https://taobao.com,https://b.com,https://github.com', urls);

// ---- TAGS 过滤（共享 selTags） ----
await page(`[...document.querySelectorAll('#gp-tag-filter-pop label')].find((l) => l.textContent.includes('dev')).querySelector('input').click()`);
await sleep(300);
titles = await resultTitles();
check('TAGS：勾选 dev 后只剩 github', titles.join() === 'github', titles);

summary();
close();
