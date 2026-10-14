/**
 * M6 自动化验收：书签编辑与管理 UI。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言：
 * - 管理表页：添加/查重 tag 与关联信息
 * - 编辑页：加载既有条目（含解密后的密码）、chip 选择 tag、修改保存
 * - 编辑页：新建条目（默认空行过滤）
 * - 编辑页：锁定门控（锁定→解锁→进入表单）
 * - launcher：favicon 显示、lastUsedAt 降序、打开后 lastUsedAt 更新
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

async function openExtPage(url, urlPart) {
  await sw(`chrome.windows.create({ url: chrome.runtime.getURL(${JSON.stringify(url)}), type: 'popup', width: 720, height: 640 })`);
  const page = await attachPage(urlPart);
  for (let i = 0; i < 20; i++) {
    if (await page(`document.readyState === 'complete'`).catch(() => false)) break;
    await sleep(250);
  }
  await sleep(300);
  return page;
}

// ---- 场景数据 ----
const bmId = await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m6-test');
  const b = await __vipper.vault.addBookmark({
    title: 'GitHub',
    urls: [{ url: 'https://github.com/login', match: 'host' }],
    accounts: [{ username: 'alice', password: 'p1' }],
    remark: '初始备注',
  });
  return b.id;
})()`);

// ---- 1. 管理表页 ----
const mgr = await openExtPage('manager.html', 'manager.html');
await mgr(`(() => { const i = document.querySelector('#new-tag'); i.value = 'dev'; })()`);
await mgr(`document.querySelector('#add-tag').click()`);
await sleep(300);
check('管理表：添加 tag', JSON.parse(await sw(`__vipper.keychain.isUnlocked().then(()=>__vipper.vault.listTags()).then(ts=>JSON.stringify(ts.map(t=>t.name)))`)).includes('dev'));

await mgr(`(() => { const i = document.querySelector('#new-tag'); i.value = 'dev'; })()`);
await mgr(`document.querySelector('#add-tag').click()`);
await sleep(300);
check('管理表：重复 tag 被拒绝并报错', await mgr(`!document.querySelector('#tag-err').hidden`));

await mgr(`(() => {
  document.querySelector('#new-link-type').value = '邮箱';
  document.querySelector('#new-link-value').value = 'a@b.c';
})()`);
await mgr(`document.querySelector('#add-link').click()`);
await sleep(300);
const links = JSON.parse(await sw(`__vipper.vault.listLinkedInfos().then(ls=>JSON.stringify(ls))`));
check('管理表：添加关联信息', links[0]?.name === '邮箱' && links[0]?.value === 'a@b.c', links);

// ---- 2. 编辑既有条目 ----
const editor = await openExtPage(`editor.html?id=${bmId}`, 'editor.html');
check('编辑页：标题回填', await editor(`document.querySelector('#title-input').value === 'GitHub'`));
check('编辑页：密码解密回填', await editor(`document.querySelector('#account-rows input:nth-of-type(2)')?.value === 'p1'`)
  || await editor(`[...document.querySelectorAll('#account-rows .row input')][1]?.value === 'p1'`));
await editor(`[...document.querySelectorAll('#tag-chips .chip')].find((c) => c.textContent === 'dev').click()`);
await editor(`[...document.querySelectorAll('#link-chips .chip')].find((c) => c.textContent.includes('a@b.c')).click()`);
await editor(`(() => { document.querySelector('#remark-input').value = '改过的备注'; })()`);
await editor(`document.querySelector('#save-btn').click()`);
await sleep(500);
const after = JSON.parse(await sw(`__vipper.vault.getBookmark('${bmId}').then(b=>JSON.stringify({tags:b.tags,links:b.linkedInfos,remark:b.remark}))`));
const [tagsMeta] = JSON.parse(await sw(`__vipper.vault.listTags().then(t=>JSON.stringify(t))`));
check('编辑页：保存后 tag/关联信息/备注已更新',
  after.tags.includes(tagsMeta.id) && after.links.includes(links[0].id) && after.remark === '改过的备注', after);

// ---- 3. 新建条目 ----
const editor2 = await openExtPage('editor.html', 'editor.html');
await editor2(`(() => { document.querySelector('#title-input').value = 'NewOne'; })()`);
await editor2(`document.querySelector('#save-btn').click()`);
await sleep(500);
const idxAfterNew = JSON.parse(await sw(`__vipper.vault.listIndex().then(i=>JSON.stringify(i.map(e=>({title:e.title,urls:e.urls}))))`));
const newOne = idxAfterNew.find((e) => e.title === 'NewOne');
check('编辑页：新建条目成功（默认空 URL 行兜底 about:blank）', !!newOne && newOne.urls[0]?.url === 'about:blank', idxAfterNew);

// ---- 4. 锁定门控 ----
await sw(`__vipper.keychain.lock()`);
const editor3 = await openExtPage(`editor.html?id=${bmId}`, 'editor.html');
check('锁定状态打开编辑页：显示解锁门、表单隐藏',
  await editor3(`!document.querySelector('#unlock').hidden && document.querySelector('#form').hidden`));
await editor3(`(() => { document.querySelector('#unlock-pw').value = 'm6-test'; })()`);
await editor3(`document.querySelector('#unlock-btn').click()`);
await sleep(500);
check('门内解锁后进入表单', await editor3(`!document.querySelector('#form').hidden`));

// ---- 5. launcher：favicon 与 lastUsedAt 排序/更新 ----
await sw(`__vipper.dispatch('open-launcher')`);
const launcher = await attachPage('launcher.html');
for (let i = 0; i < 20; i++) {
  if (await launcher(`!!document.querySelector('#list li')`).catch(() => false)) break;
  await sleep(250);
}
check('launcher：favicon 注入', await launcher(`document.querySelector('#list li img.favicon')?.src.includes('/_favicon/')`));
check('launcher：lastUsedAt 降序（新建的 NewOne 在最前）',
  await launcher(`document.querySelector('#list li span')?.textContent === 'NewOne'`));

// 打开 GitHub（第 2 项，按两次 ↓）后 lastUsedAt 应更新，重开弹窗应排第一
await launcher(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await launcher(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await launcher(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(600);
await sw(`__vipper.dispatch('open-launcher')`);
const launcher2 = await attachPage('launcher.html');
for (let i = 0; i < 20; i++) {
  if (await launcher2(`!!document.querySelector('#list li')`).catch(() => false)) break;
  await sleep(250);
}
check('打开后 lastUsedAt 更新，GitHub 排到最前',
  await launcher2(`document.querySelector('#list li span')?.textContent === 'GitHub'`));

summary();
close();
