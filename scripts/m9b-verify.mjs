/**
 * M9b 自动化验收：数据层 spec-change 落地。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言（对应 spec 2026-10-14 修订）：
 * - settings 默认值 0/0（超时锁定/自动归档默认关闭）
 * - autoArchiveDays=0 时 autoArchive 短路不归档；设为正数后正常归档
 * - idx 索引含 remark 且 filterIndex 可按 remark 检索
 * - tag：color 字段（默认 mauve / 指定 sky / 非法颜色拒绝）
 * - linkedInfo：{id,name,value} 结构，重名/重值拒绝
 * - 管理表删除查引用：被引用拒绝（报引用数），删除引用条目后可删
 * - 导入合并：linkedInfo 按 name 或 value 去重并重映射引用 id
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m9b-test')`);

// ---- 1. settings 默认值 0/0 ----
const defaults = JSON.parse(await sw(`__vipper.keychain.getSettings().then((s) => JSON.stringify(s))`));
check('settings 默认 lockTimeoutMin=0 / autoArchiveDays=0',
  defaults.lockTimeoutMin === 0 && defaults.autoArchiveDays === 0, defaults);

// ---- 2. 自动归档：0 短路；正数生效 ----
const oldId = await sw(`(async () => {
  const b = await __vipper.vault.addBookmark({ title: 'Old', urls: [{ url: 'https://old.example.com', match: 'host' }] });
  await __vipper.vault.saveBookmark({ ...b, lastUsedAt: Date.now() - 400 * 86400000 });
  return b.id;
})()`);
check('autoArchiveDays=0 时不归档（400 天未用也保留）',
  await sw(`__vipper.vault.autoArchive().then((r) => JSON.stringify(r))`) === '[]'
  && await sw(`__vipper.vault.getBookmark('${oldId}').then((b) => b.status)`) === 'active');
await sw(`__vipper.keychain.setSettings({ autoArchiveDays: 30 })`);
const archived = JSON.parse(await sw(`__vipper.vault.autoArchive().then((r) => JSON.stringify(r))`));
check('设置 30 天后 autoArchive 归档过期条目',
  archived.length === 1 && archived[0] === oldId
  && await sw(`__vipper.vault.getBookmark('${oldId}').then((b) => b.status)`) === 'archived', archived);
await sw(`__vipper.keychain.setSettings({ autoArchiveDays: 0 })`); // 还原默认，防影响后续

// ---- 3. idx 含 remark + filterIndex 按 remark 检索 ----
const remarkCheck = JSON.parse(await sw(`(async () => {
  const b = await __vipper.vault.addBookmark({
    title: 'RemarkHost', remark: '绑定了二次验证',
    urls: [{ url: 'https://remark.example.com', match: 'host' }],
  });
  const idx = await __vipper.vault.listIndex();
  const entry = idx.find((e) => e.id === b.id);
  return JSON.stringify({
    inIdx: entry?.remark === '绑定了二次验证',
    hit: __vipper.vault.filterIndex(idx, '二次验证').some((e) => e.id === b.id),
    miss: __vipper.vault.filterIndex(idx, '不存在的词').length === 0,
  });
})()`));
check('idx 索引含 remark 且可按 remark 检索', remarkCheck.inIdx && remarkCheck.hit && remarkCheck.miss, remarkCheck);

// ---- 4. tag color ----
const tagCheck = JSON.parse(await sw(`(async () => {
  const t1 = await __vipper.vault.addTag('dev');              // 默认色
  const t2 = await __vipper.vault.addTag('ops', 'sky');       // 指定色
  const bad = await __vipper.vault.addTag('bad', 'neon').then(() => 'resolved', (e) => String(e));
  return JSON.stringify({ dft: t1.color, named: t2.color, bad });
})()`));
check('tag color：默认 mauve / 指定 sky / 非法颜色拒绝',
  tagCheck.dft === 'mauve' && tagCheck.named === 'sky' && tagCheck.bad.includes('非法'), tagCheck);

// ---- 5. linkedInfo：结构 + 重名/重值拒绝 ----
const linkCheck = JSON.parse(await sw(`(async () => {
  const l1 = await __vipper.vault.addLinkedInfo('手机1', '138****0001');
  const dupName = await __vipper.vault.addLinkedInfo('手机1', '999').then(() => 'resolved', (e) => String(e));
  const dupValue = await __vipper.vault.addLinkedInfo('手机2', '138****0001').then(() => 'resolved', (e) => String(e));
  return JSON.stringify({ shape: l1.name === '手机1' && l1.value === '138****0001' && !('type' in l1), dupName, dupValue });
})()`));
check('linkedInfo 为 {id,name,value}，重名与重值均被拒绝',
  linkCheck.shape && linkCheck.dupName.includes('已存在') && linkCheck.dupValue.includes('已存在'), linkCheck);

// ---- 6. 删除查引用 ----
const refCheck = JSON.parse(await sw(`(async () => {
  const tag = (await __vipper.vault.listTags()).find((t) => t.name === 'dev');
  const link = (await __vipper.vault.listLinkedInfos()).find((l) => l.name === '手机1');
  const b = await __vipper.vault.addBookmark({
    title: 'RefHolder', tags: [tag.id], linkedInfos: [link.id],
    urls: [{ url: 'https://ref.example.com', match: 'host' }],
  });
  const delTag = await __vipper.vault.deleteTag(tag.id).then(() => 'resolved', (e) => String(e));
  const delLink = await __vipper.vault.deleteLinkedInfo(link.id).then(() => 'resolved', (e) => String(e));
  await __vipper.vault.deleteBookmark(b.id);
  await __vipper.vault.deleteTag(tag.id);          // 解除引用后应成功
  const tagGone = !(await __vipper.vault.listTags()).some((t) => t.id === tag.id);
  return JSON.stringify({ delTag, delLink, tagGone });
})()`));
check('被引用的 tag/linkedInfo 拒绝删除（报引用数），解除引用后可删',
  refCheck.delTag.includes('被 1 条书签引用') && refCheck.delTag.includes('RefHolder')
  && refCheck.delLink.includes('被 1 条书签引用') && refCheck.tagGone, refCheck);

// ---- 7. 导入 = 全量恢复（2026-10-15 spec-change）：管理表整表替换、引用 id 原样保留 ----
const importCheck = JSON.parse(await sw(`(async () => {
  const data = {
    app: 'vipper', version: 1, exportedAt: Date.now(), tags: [],
    linkedInfos: [{ id: 'ext-link-1', name: '手机1', value: '000-不同值' }],
    bookmarks: [{
      id: 'ext-bm-1', title: 'Imp', remark: '', tags: [], linkedInfos: ['ext-link-1'],
      urls: [{ url: 'https://imp.example.com', match: 'host' }],
      accounts: [], records: [], status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now(),
    }],
  };
  const res = await __vipper.vault.importAll(data);
  const b = await __vipper.vault.getBookmark('ext-bm-1');
  const links = await __vipper.vault.listLinkedInfos();
  const idx = await __vipper.vault.listIndex();
  return JSON.stringify({
    added: res.added,
    refKept: b.linkedInfos[0] === 'ext-link-1',           // 引用 id 原样保留（无重映射）
    tableReplaced: links.length === 1 && links[0].id === 'ext-link-1' && links[0].value === '000-不同值',
    localWiped: idx.every((e) => e.id === 'ext-bm-1'),     // 本地旧条目全部清除
  });
})()`));
check('导入全量恢复：管理表替换、引用 id 保留、本地旧数据清除',
  importCheck.added === 1 && importCheck.refKept && importCheck.tableReplaced && importCheck.localWiped, importCheck);

summary();
close();
