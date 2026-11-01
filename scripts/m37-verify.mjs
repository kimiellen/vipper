/**
 * M37 自动化验收：浏览器原生书签导入（spec 2026-11-01）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 主密码错误拒绝导入，且不产生任何数据
 * - 追加导入：已有书签 / tags / linkedInfos 原样保留，浏览器书签展平新增
 * - 自动关联 tag「浏览器书签导入」（不存在则创建，sapphire 色）
 * - 文件夹路径写入 remarks；空标题回落 URL
 * - URL 规范化去重：已存在的跳过，结果报告新增/跳过数
 * - 二次导入幂等（全部跳过，条目数不变）
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景数据：已有 vault 数据 + 浏览器原生书签 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m37-test');
  const tag = await __vipper.vault.addTag('dev', 'mauve');
  const link = await __vipper.vault.addLinkedInfo('邮箱1', 'me@example.com');
  const b = await __vipper.vault.addBookmark({
    title: 'github', remarks: '手动录入', tags: [tag.id], linkedInfos: [link.id],
    urls: [{ url: 'https://github.com', match: 'host' }],
    accounts: [{ username: 'octocat', password: 'pw-1' }],
  });
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0].children.find((c) => c.id === '1') ?? tree[0].children[0];
  const other = tree[0].children.find((c) => c.id === '2') ?? tree[0].children[1];
  const folder = await chrome.bookmarks.create({ parentId: bar.id, title: '开发' });
  const created = [];
  created.push(await chrome.bookmarks.create({ parentId: bar.id, title: 'MDN', url: 'https://developer.mozilla.org' }));
  created.push(await chrome.bookmarks.create({ parentId: folder.id, title: 'Vue', url: 'https://vuejs.org' }));
  created.push(await chrome.bookmarks.create({ parentId: bar.id, title: 'GitHub dup', url: 'https://github.com' }));
  created.push(await chrome.bookmarks.create({ parentId: bar.id, title: '', url: 'https://example.com/x' }));
  created.push(await chrome.bookmarks.create({ parentId: other.id, title: 'Other', url: 'https://other.example' }));
  return JSON.stringify({ bm: b.id, tag: tag.id, link: link.id, barTitle: bar.title, otherTitle: other.title, count: created.length });
})()`));
check('准备：浏览器书签 5 条（1 条重复 URL、1 条空标题、1 条在文件夹内）', seed.count === 5, seed);

// ---- 打开 wui 并展开备份手风琴 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const page = await attachPage('wui.html');
for (let i = 0; i < 20; i++) {
  if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
  await sleep(250);
}
await sleep(300);
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('备份') || h.textContent.includes('Backup')).click()`);
await sleep(300);

const statusText = () => page(`document.querySelector('#backup-status')?.textContent ?? ''`);
const waitStatus = async (needle) => {
  for (let i = 0; i < 60; i++) {
    const txt = await statusText();
    if (txt.includes(needle)) return txt;
    await sleep(250);
  }
  return statusText();
};

// ---- 1. 错误主密码拒绝 ----
await page(`(() => { document.querySelector('#backup-pw').value = 'wrong'; })()`);
await page(`document.querySelector('#import-browser-btn').click()`);
await sleep(1200); // PBKDF2 派生需要时间
check('错误主密码：提示主密码错误', (await statusText()).includes('密码'), await statusText());
check('错误主密码：不产生任何条目', await sw(`__vipper.vault.listIndex().then((i) => i.length)`) === 1);
check('错误主密码：不创建导入 tag', await sw(`__vipper.vault.listTags().then((ts) => !ts.some((t) => t.name === '浏览器书签导入'))`) === true);

// ---- 2. 正确主密码：追加导入 ----
await page(`(() => { document.querySelector('#backup-pw').value = 'm37-test'; })()`);
await page(`document.querySelector('#import-browser-btn').click()`);
await waitStatus('导入完成');
const doneText = await statusText();
check('结果报告：新增 4 / 跳过 1', doneText.includes('新增 4') && doneText.includes('跳过 1'), doneText);

const after = JSON.parse(await sw(`(async () => {
  const idx = await __vipper.vault.listIndex();
  const tags = await __vipper.vault.listTags();
  const links = await __vipper.vault.listLinkedInfos();
  const importTag = tags.find((t) => t.name === '浏览器书签导入');
  const dev = tags.find((t) => t.name === 'dev');
  const oldBm = await __vipper.vault.getBookmarkDecrypted('${seed.bm}');
  const find = (title) => idx.find((e) => e.title === title);
  const dec = async (title) => { const e = find(title); return e ? await __vipper.vault.getBookmarkDecrypted(e.id) : null; };
  const mdn = await dec('MDN');
  const vue = await dec('Vue');
  const empty = idx.find((e) => e.urls.some((u) => u.url === 'https://example.com/x'));
  const emptyBm = empty ? await __vipper.vault.getBookmarkDecrypted(empty.id) : null;
  const other = await dec('Other');
  return JSON.stringify({
    total: idx.length,
    importTag, devTag: dev, links,
    old: { remarks: oldBm.remarks, tags: oldBm.tags, username: oldBm.accounts[0]?.username, password: oldBm.accounts[0]?.password },
    mdn: mdn && { tags: mdn.tags, remarks: mdn.remarks, status: mdn.status },
    vue: vue && { tags: vue.tags, remarks: vue.remarks },
    empty: emptyBm && { title: emptyBm.title, tags: emptyBm.tags },
    other: other && { remarks: other.remarks },
    linkedCount: links.length,
  });
})()`));

check('追加导入：总条目 5（1 已有 + 4 新增）', after.total === 5, after.total);
check('自动创建 tag「浏览器书签导入」（sapphire）',
  after.importTag?.name === '浏览器书签导入' && after.importTag?.color === 'sapphire', after.importTag);
check('新增条目均关联导入 tag', [after.mdn, after.vue, after.empty].every((x) => x && x.tags.length === 1 && x.tags[0] === after.importTag?.id), after);
check('文件夹路径写入 remarks（书签栏 / 开发）',
  after.mdn?.remarks === seed.barTitle && after.vue?.remarks === `${seed.barTitle} / 开发` && after.other?.remarks === seed.otherTitle,
  { mdn: after.mdn?.remarks, vue: after.vue?.remarks, other: after.other?.remarks, barTitle: seed.barTitle });
check('空标题回落 URL', after.empty?.title === 'https://example.com/x', after.empty?.title);
check('已有书签未被覆盖（remarks/tags/账号密码原样）',
  after.old.remarks === '手动录入' && JSON.stringify(after.old.tags) === JSON.stringify([seed.tag])
  && after.old.username === 'octocat' && after.old.password === 'pw-1', after.old);
check('管理表未被改动（dev tag 与 linkedInfo 仍在）',
  after.devTag?.id === seed.tag && after.linkedCount === 1 && after.links[0]?.value === 'me@example.com', after);
check('导入条目为 active', after.mdn?.status === 'active', after.mdn?.status);

// ---- 3. 二次导入幂等 ----
await page(`(() => { document.querySelector('#backup-pw').value = 'm37-test'; })()`);
await page(`document.querySelector('#import-browser-btn').click()`);
await waitStatus('新增 0');
const secondText = await statusText();
check('二次导入：新增 0 / 跳过 5', secondText.includes('新增 0') && secondText.includes('跳过 5'), secondText);
check('二次导入后条目数不变', await sw(`__vipper.vault.listIndex().then((i) => i.length)`) === 5);

summary();
close();
