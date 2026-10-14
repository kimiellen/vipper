/**
 * M7 自动化验收：归档。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言：
 * - 手动归档：bm: → arc: 数据迁移 + idx 状态更新
 * - launcher 正常模式不显示归档条目；归档页（?archive=1）显示
 * - 归档页 Ctrl+R 恢复条目
 * - 编辑页归档按钮
 * - 自动归档：lastUsedAt 超阈值归档，未超不动
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景：3 条书签 ----
const ids = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m7-test');
  const mk = (t) => __vipper.vault.addBookmark({ title: t, urls: [{ url: 'about:blank#' + t, match: 'host' }] }).then((b) => b.id);
  return JSON.stringify({ A: await mk('AAA'), B: await mk('BBB'), C: await mk('CCC') });
})()`));

// ---- 1. 手动归档（vault 层）----
await sw(`__vipper.vault.archiveBookmark('${ids.A}')`);
const rawAfterArchive = JSON.parse(await sw(`(async () => {
  const all = await chrome.storage.local.get(null);
  const idx = await __vipper.vault.listIndex();
  return JSON.stringify({
    bmGone: all['bm:${ids.A}'] === undefined,
    arcExists: all['arc:${ids.A}'] !== undefined,
    idxStatus: idx.find((e) => e.id === '${ids.A}')?.status,
  });
})()`));
check('手动归档：bm: 删除、arc: 存在、idx 状态 archived',
  rawAfterArchive.bmGone && rawAfterArchive.arcExists && rawAfterArchive.idxStatus === 'archived', rawAfterArchive);

// ---- 2. launcher 正常/归档模式列表隔离 ----
await sw(`__vipper.dispatch('open-launcher')`);
const normal = await attachPage('launcher.html');
for (let i = 0; i < 20; i++) { if (await normal(`!!document.querySelector('#list li')`).catch(() => false)) break; await sleep(250); }
check('正常模式：不显示归档条目（BBB/CCC 可见，AAA 不可见）', await normal(`(() => {
  const text = document.querySelector('#list').textContent;
  return text.includes('BBB') && text.includes('CCC') && !text.includes('AAA');
})()`));

await sw(`chrome.windows.create({ url: chrome.runtime.getURL('launcher.html?archive=1'), type: 'popup', width: 640, height: 480 })`);
const arch = await attachPage('archive=1');
for (let i = 0; i < 20; i++) { if (await arch(`!!document.querySelector('#list li')`).catch(() => false)) break; await sleep(250); }
check('归档页：显示归档条目（AAA 可见，BBB 不可见）', await arch(`(() => {
  const text = document.querySelector('#list').textContent;
  return text.includes('AAA') && !text.includes('BBB');
})()`));

// ---- 3. 归档页 Ctrl+R 恢复 ----
await arch(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await arch(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }))`);
await sleep(500);
const afterRestore = JSON.parse(await sw(`(async () => {
  const all = await chrome.storage.local.get(null);
  return JSON.stringify({ bmBack: all['bm:${ids.A}'] !== undefined, status: (await __vipper.vault.listIndex()).find((e) => e.id === '${ids.A}')?.status });
})()`));
check('Ctrl+R 恢复：条目回到 bm:、idx 状态 active', afterRestore.bmBack && afterRestore.status === 'active', afterRestore);

// ---- 4. 编辑页归档按钮 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('editor.html?id=${ids.B}'), type: 'popup', width: 720, height: 640 })`);
const editor = await attachPage('editor.html');
for (let i = 0; i < 20; i++) { if (await editor(`!document.querySelector('#form').hidden`).catch(() => false)) break; await sleep(250); }
check('编辑页：归档按钮文案', await editor(`document.querySelector('#archive-btn').textContent === '归档'`));
await editor(`document.querySelector('#archive-btn').click()`);
await sleep(400);
check('编辑页归档后 idx 状态 archived',
  JSON.parse(await sw(`__vipper.vault.listIndex().then(i=>JSON.stringify(i.find(e=>e.id==='${ids.B}').status))`)) === 'archived');

// ---- 5. 自动归档（B 已归档；C 设为 200 天前活跃；A 刚恢复不动）----
// M9b 起默认阈值 0 = 关闭，此处显式设置 180 天阈值再测
await sw(`__vipper.keychain.setSettings({ autoArchiveDays: 180 })`);
await sw(`(async () => {
  const c = await __vipper.vault.getBookmark('${ids.C}');
  c.lastUsedAt = Date.now() - 200 * 86400000;
  await __vipper.vault.saveBookmark(c);
})()`);
const archived = JSON.parse(await sw(`__vipper.vault.autoArchive().then(JSON.stringify)`));
check('自动归档：仅超阈值条目被归档', archived.length === 1 && archived[0] === ids.C, archived);

summary();
close();
