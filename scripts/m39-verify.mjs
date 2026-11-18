/**
 * M39 自动化验收：唯一性约束（spec 2026-11-18，socket 寻址前置）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言（全部在 vault 层，经 __vipper.vault 驱动）：
 * - title 全局唯一：新增撞名拒绝；改名撞名拒绝；active+archived 跨状态撞名拒绝
 * - 同书签内 secret 记录 name 唯一（note 不受约束）
 * - importAll：文件含重名 title 或重名 secret name → 拒绝恢复，本地数据一个字节不动
 * - importBrowserBookmarks：与既有条目撞名 / 批次内互撞 → 自动追加 " (n)" 后缀并计 renamed
 * - dedupeTitle：跳过已占用的序号
 * - 登录自动保存路径（background saveNewBookmark）撞名加后缀——经 addBookmark 间接受
 *   唯一性约束保护，后缀逻辑与浏览器导入共用 dedupeTitle（此处覆盖纯函数行为）
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m39-test')`);

// ---- 1. title 全局唯一 ----
const r1 = JSON.parse(await sw(`(async () => {
  const out = {};
  const a = await __vipper.vault.addBookmark({ title: 'Alpha', urls: [{ url: 'https://alpha.example', match: 'host' }] });
  out.alphaId = a.id;
  out.dupAdd = await __vipper.vault.addBookmark({ title: 'Alpha', urls: [{ url: 'https://a2.example', match: 'host' }] }).then(() => 'no-throw').catch(String);
  const beta = await __vipper.vault.addBookmark({ title: 'Beta', urls: [{ url: 'https://beta.example', match: 'host' }] });
  out.betaId = beta.id;
  out.dupRename = await __vipper.vault.saveBookmark({ ...beta, title: 'Alpha' }).then(() => 'no-throw').catch(String);
  // 跨状态：归档 Alpha 后仍不能新增同名 active
  await __vipper.vault.archiveBookmark(a.id);
  out.dupArchived = await __vipper.vault.addBookmark({ title: 'Alpha', urls: [{ url: 'https://a3.example', match: 'host' }] }).then(() => 'no-throw').catch(String);
  return JSON.stringify(out);
})()`));
check('新增撞名 title 拒绝', r1.dupAdd.includes('书签名已存在'), r1.dupAdd);
check('改名撞名 title 拒绝', r1.dupRename.includes('书签名已存在'), r1.dupRename);
check('active+archived 跨状态撞名拒绝', r1.dupArchived.includes('书签名已存在'), r1.dupArchived);

// ---- 2. secret 记录 name 书签内唯一（note 不受约束） ----
const r2 = JSON.parse(await sw(`(async () => {
  const mk = (records) => ({ title: 'Rec-' + Math.random(), urls: [{ url: 'https://r.example', match: 'host' }], records });
  const dupSecret = await __vipper.vault.addBookmark(mk([
    { template: 'secret', name: 'api-key', content: 'x' },
    { template: 'secret', name: 'api-key', content: 'y' },
  ])).then(() => 'no-throw').catch(String);
  const noteOk = await __vipper.vault.addBookmark(mk([
    { template: 'note', name: 'n', content: '1' },
    { template: 'note', name: 'n', content: '2' },
  ])).then(() => 'ok').catch(String);
  const mixedOk = await __vipper.vault.addBookmark(mk([
    { template: 'note', name: 'k', content: '1' },
    { template: 'secret', name: 'k', content: '2' },
  ])).then(() => 'ok').catch(String);
  return JSON.stringify({ dupSecret, noteOk, mixedOk });
})()`));
check('同书签内重名 secret 拒绝', r2.dupSecret.includes('secret 记录名重复'), r2.dupSecret);
check('note 不受 name 唯一约束', r2.noteOk === 'ok', r2.noteOk);
check('note 与 secret 同名不冲突', r2.mixedOk === 'ok', r2.mixedOk);

// ---- 3. importAll：带病文件拒绝，本地数据不动 ----
const r3 = JSON.parse(await sw(`(async () => {
  const before = (await __vipper.vault.listIndex()).length;
  const base = { app: 'vipper', version: 2, exportedAt: Date.now(), tags: [], linkedInfos: [] };
  const bm = (title, records = []) => ({
    id: crypto.randomUUID(), title, remarks: '', tags: [], linkedInfos: [],
    urls: [], accounts: [], records, status: 'active', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
  });
  const dupTitle = await __vipper.vault.importAll({ ...base, bookmarks: [bm('X'), bm('X')] })
    .then(() => 'no-throw').catch(String);
  const dupSecret = await __vipper.vault.importAll({ ...base, bookmarks: [bm('Y', [
    { template: 'secret', name: 's', content: '1' },
    { template: 'secret', name: 's', content: '2' },
  ])] }).then(() => 'no-throw').catch(String);
  const after = (await __vipper.vault.listIndex()).length;
  return JSON.stringify({ before, after, dupTitle, dupSecret });
})()`));
check('importAll：含重名 title 拒绝', r3.dupTitle.includes('重名书签'), r3.dupTitle);
check('importAll：含重名 secret name 拒绝', r3.dupSecret.includes('secret 记录名重复'), r3.dupSecret);
check('importAll 拒绝后本地数据不动', r3.before === r3.after, { before: r3.before, after: r3.after });

// ---- 4. 浏览器书签导入：撞名自动加后缀 ----
const r4 = JSON.parse(await sw(`(async () => {
  const result = await __vipper.vault.importBrowserBookmarks([
    { url: 'https://new-beta.example', title: 'Beta', folderPath: '', dateAdded: 1 },   // 撞既有 Beta
    { url: 'https://shop1.example', title: 'Shop', folderPath: '', dateAdded: 2 },       // 批次内互撞
    { url: 'https://shop2.example', title: 'Shop', folderPath: '', dateAdded: 3 },
  ]);
  const idx = await __vipper.vault.listIndex();
  return JSON.stringify({ result, titles: idx.map((e) => e.title).filter((t) => t.startsWith('Beta') || t.startsWith('Shop')) });
})()`));
check('浏览器导入报告 renamed=2', r4.result.renamed === 2 && r4.result.added === 3, r4.result);
check('撞名条目加序号后缀', r4.titles.includes('Beta (2)') && r4.titles.includes('Shop') && r4.titles.includes('Shop (2)'), r4.titles);

// ---- 5. dedupeTitle 纯函数：跳过已占用序号 ----
const r5 = await sw(`__vipper.vault.dedupeTitle('X', new Set(['X', 'X (2)']))`);
check('dedupeTitle 跳过已占用序号', r5 === 'X (3)', r5);

summary();
close();
