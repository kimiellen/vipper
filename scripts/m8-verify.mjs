/**
 * M8 自动化验收：导入导出。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言：
 * - 导出：全量明文（密码/私密内容可读）、含管理表
 * - 锁定状态导出被拒
 * - 清空后导入：数据完整还原（新主密码下可解密——重新加密落盘）；tag 引用 id 保留
 * - 合并语义：同 id updatedAt 新者胜；本地较新时导入被跳过
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景：含敏感字段的书签 + tag + 关联信息 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m8-old');
  const tag = await __vipper.vault.addTag('dev');
  const link = await __vipper.vault.addLinkedInfo('邮箱', 'a@b.c');
  const b = await __vipper.vault.addBookmark({
    title: 'Bank', remark: '主用',
    tags: [tag.id], linkedInfos: [link.id],
    urls: [{ url: 'https://bank.example.com/login', match: 'host' }],
    accounts: [{ username: 'alice', password: 's3cret!', label: '主号' }],
    records: [{ template: 'secret', name: '密保', content: '旺财' }],
  });
  return JSON.stringify({ bm: b.id, tag: tag.id, link: link.id });
})()`));

// ---- 1. 导出全量明文 ----
const exported = JSON.parse(await sw(`__vipper.vault.exportAll().then((d) => JSON.stringify(d))`));
const expBm = exported.bookmarks[0];
check('导出结构完整（app/version/管理表）',
  exported.app === 'vipper' && exported.version === 1 && exported.tags.length === 1 && exported.linkedInfos.length === 1);
check('导出为明文（password/secret.content 可读）',
  expBm.accounts[0].password === 's3cret!' && expBm.records[0].content === '旺财', expBm.accounts[0]);

// ---- 2. 锁定导出被拒 ----
await sw(`__vipper.keychain.lock()`);
check('锁定状态导出被拒',
  await sw(`__vipper.vault.exportAll().then(() => 'resolved', (e) => String(e))`).then((s) => s.includes('locked')));
await sw(`__vipper.keychain.unlock('m8-old')`);

// ---- 3. 清空 → 换主密码 → 导入还原 ----
await sw(`chrome.storage.local.clear()`);
await sw(`__vipper.keychain.setupMasterPassword('m8-new')`);
const importRes = await sw(`__vipper.vault.importAll(${JSON.stringify(exported)}).then((r) => JSON.stringify(r), (e) => 'ERR:' + e)`);
check('导入结果：added=1', importRes === JSON.stringify({ added: 1, updated: 0, skipped: 0 }), importRes);

const restored = JSON.parse(await sw(`(async () => {
  const b = await __vipper.vault.getBookmarkDecrypted('${seed.bm}');
  const tags = await __vipper.vault.listTags();
  return JSON.stringify({
    pw: b.accounts[0].password, secret: b.records[0].content, remark: b.remark,
    tagRefWorks: b.tags.length === 1 && tags[0].name === 'dev' && b.tags[0] === tags[0].id,
  });
})()`));
check('还原后可解密（新主密码下重新加密落盘）', restored.pw === 's3cret!' && restored.secret === '旺财', restored);
check('还原后 tag 引用一致（id 保留）', restored.tagRefWorks, restored);

// ---- 4. 合并语义：本地较新则导入跳过 ----
await sw(`(async () => {
  const b = await __vipper.vault.getBookmark('${seed.bm}');
  await new Promise((r) => setTimeout(r, 10));
  await __vipper.vault.saveBookmark({ ...b, title: 'Bank-本地改' });  // updatedAt 变新
})()`);
const mergeRes = await sw(`__vipper.vault.importAll(${JSON.stringify(exported)}).then((r) => JSON.stringify(r))`);
check('合并：本地较新条目被跳过', mergeRes === JSON.stringify({ added: 0, updated: 0, skipped: 1 }), mergeRes);
const titleNow = await sw(`__vipper.vault.getBookmark('${seed.bm}').then((b) => b.title)`);
check('合并：本地标题未被旧导出覆盖', titleNow === 'Bank-本地改', titleNow);

// 反向：导出文件更新（模拟 updatedAt 更新）→ 导入应覆盖
const newerExport = JSON.parse(JSON.stringify(exported));
newerExport.bookmarks[0].title = 'Bank-备份较新';
newerExport.bookmarks[0].updatedAt = Date.now() + 10_000;
const mergeRes2 = await sw(`__vipper.vault.importAll(${JSON.stringify(newerExport)}).then((r) => JSON.stringify(r))`);
check('合并：导出较新则覆盖本地', mergeRes2 === JSON.stringify({ added: 0, updated: 1, skipped: 0 }), mergeRes2);
const title2 = await sw(`__vipper.vault.getBookmark('${seed.bm}').then((b) => b.title)`);
check('合并：标题被较新导出覆盖', title2 === 'Bank-备份较新', title2);

summary();
close();
