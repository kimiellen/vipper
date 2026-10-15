/**
 * M8 自动化验收：导入导出。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言（2026-10-15 spec-change：导入 = 全量恢复，不再增量合并）：
 * - 导出：全量明文（密码/私密内容可读）、含管理表
 * - 锁定状态导出/导入均被拒
 * - 清空后导入：数据完整还原（新主密码下可解密——重新加密落盘）；tag 引用 id 保留
 * - 全量替换：导入后本地独有的旧条目被清除
 * - 非法文件：拒绝导入且现有数据不受影响
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
    accounts: [{ username: 'alice', password: 's3cret!' }],
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
check('导入结果：added=1', importRes === JSON.stringify({ added: 1 }), importRes);

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

// ---- 4. 全量替换语义：本地独有条目被清除 ----
await sw(`__vipper.vault.addBookmark({ title: 'LocalOnly', urls: [{ url: 'https://local.example.com', match: 'host' }] })`);
const replaceRes = await sw(`__vipper.vault.importAll(${JSON.stringify(exported)}).then((r) => JSON.stringify(r))`);
check('恢复结果：added=1（导入文件只有 1 条）', replaceRes === JSON.stringify({ added: 1 }), replaceRes);
const afterReplace = JSON.parse(await sw(`__vipper.vault.listIndex().then((i) => JSON.stringify(i.map((e) => e.title)))`));
check('全量替换：LocalOnly 被清除、导入条目在', !afterReplace.includes('LocalOnly') && afterReplace.includes('Bank'), afterReplace);

// ---- 5. 非法文件：拒绝且不动现有数据 ----
const badRes = await sw(`__vipper.vault.importAll({ app: 'other', data: [] }).then(() => 'resolved', (e) => String(e))`);
check('非法文件被拒绝', badRes.includes('不是有效'), badRes);
check('非法文件未影响现有数据', await sw(`__vipper.vault.listIndex().then((i) => i.length)`) === 1);

// ---- 6. 锁定导入被拒 ----
await sw(`__vipper.keychain.lock()`);
check('锁定状态导入被拒',
  await sw(`__vipper.vault.importAll(${JSON.stringify(exported)}).then(() => 'resolved', (e) => String(e))`).then((s) => s.includes('locked')));

summary();
close();
