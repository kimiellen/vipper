/**
 * M11 自动化验收：备注字段 remark → remarks（数据迁移 + v1 导入兼容 + UI 标签）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 首次访问自动迁移旧 idx / bm: / arc: 字段，写入 meta:migrations 标记
 * - 迁移后 idx 备注字段与归档条目读取正常
 * - 导出为 version 2 + remarks；旧 version 1 导出文件的 remark 可导入
 * - contents 展示态 / 编辑态字段名为 remarks
 */

import { writeFileSync } from 'node:fs';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 1. 播种旧格式数据（首次 vault 调用前，确保迁移尚未执行）----
await sw(`__vipper.keychain.setupMasterPassword('m11-test')`);
await sw(`(async () => {
  const now = Date.now();
  const mk = (id, title, remark, status, lastUsedAt) => ({
    id, title, remark, tags: [], linkedInfos: [],
    urls: [{ url: 'https://legacy.example.com/' + id, match: 'host' }],
    accounts: [], records: [], status, createdAt: now, updatedAt: now, lastUsedAt,
  });
  const a = mk('legacy-active', 'Legacy Active', '旧备注A', 'active', now);
  const r = mk('legacy-arc', 'Legacy Arc', '旧备注B', 'archived', now - 1000);
  const toIdx = (b) => ({
    id: b.id, title: b.title, remark: b.remark, tags: b.tags, linkedInfos: b.linkedInfos,
    urls: b.urls, accountCount: 0, lastUsedAt: b.lastUsedAt, status: b.status,
  });
  await chrome.storage.local.set({ idx: [toIdx(a), toIdx(r)], ['bm:' + a.id]: a, ['arc:' + r.id]: r });
})()`);

// ---- 2. 首次读取触发迁移 ----
const migrated = JSON.parse(await sw(`(async () => {
  const idx = await __vipper.vault.listIndex();
  const raw = await chrome.storage.local.get(['idx', 'bm:legacy-active', 'arc:legacy-arc', 'meta:migrations']);
  const arc = await __vipper.vault.getBookmark('legacy-arc');
  return JSON.stringify({
    idx: raw.idx.map((e) => ({ remarks: e.remarks, hasOld: Object.prototype.hasOwnProperty.call(e, 'remark') })),
    bm: { remarks: raw['bm:legacy-active'].remarks, hasOld: Object.prototype.hasOwnProperty.call(raw['bm:legacy-active'], 'remark') },
    arcRaw: { remarks: raw['arc:legacy-arc'].remarks, hasOld: Object.prototype.hasOwnProperty.call(raw['arc:legacy-arc'], 'remark') },
    arcRead: arc?.remarks,
    activeRemarks: idx.find((e) => e.id === 'legacy-active')?.remarks,
    flag: raw['meta:migrations']?.remarksRenamed,
  });
})()`));
check('迁移 idx / bm: / arc: 的 remark 为 remarks（旧字段移除）',
  migrated.idx.every((e) => e.remarks && !e.hasOld) && migrated.bm.remarks === '旧备注A' && !migrated.bm.hasOld
  && migrated.arcRaw.remarks === '旧备注B' && !migrated.arcRaw.hasOld, migrated);
check('迁移后 idx 备注字段、归档条目读取正常',
  migrated.activeRemarks === '旧备注A' && migrated.arcRead === '旧备注B', migrated);
check('迁移标记写入 meta:migrations', migrated.flag === true, migrated.flag);

// ---- 3. 新写入 + 导出格式 ----
const newBm = JSON.parse(await sw(`(async () => {
  const b = await __vipper.vault.addBookmark({
    title: 'New Format', remarks: '新备注',
    urls: [{ url: 'https://new.example.com', match: 'host' }],
  });
  const raw = (await chrome.storage.local.get('bm:' + b.id))['bm:' + b.id];
  const exported = await __vipper.vault.exportAll();
  const expBm = exported.bookmarks.find((x) => x.id === b.id);
  return JSON.stringify({
    id: b.id,
    rawRemarks: raw.remarks,
    rawHasOld: Object.prototype.hasOwnProperty.call(raw, 'remark'),
    version: exported.version,
    expRemarks: expBm.remarks,
    expHasOld: Object.prototype.hasOwnProperty.call(expBm, 'remark'),
  });
})()`));
check('新写入落盘/导出均为 remarks 且无旧字段',
  newBm.rawRemarks === '新备注' && !newBm.rawHasOld && newBm.expRemarks === '新备注' && !newBm.expHasOld, newBm);
check('导出格式 version 升到 2', newBm.version === 2, newBm.version);

// ---- 4. 旧 version 1 导出文件导入兼容 ----
const imported = JSON.parse(await sw(`(async () => {
  const now = Date.now();
  const legacy = {
    app: 'vipper', version: 1, exportedAt: now, tags: [], linkedInfos: [],
    bookmarks: [{
      id: 'legacy-import', title: 'Imported Legacy', remark: '旧格式备注',
      tags: [], linkedInfos: [], urls: [{ url: 'https://legacy-import.example.com', match: 'host' }],
      accounts: [], records: [], status: 'active', createdAt: now, updatedAt: now, lastUsedAt: now,
    }],
  };
  await __vipper.vault.importAll(legacy);
  const b = await __vipper.vault.getBookmarkDecrypted('legacy-import');
  const raw = (await chrome.storage.local.get('bm:legacy-import'))['bm:legacy-import'];
  const exported = await __vipper.vault.exportAll();
  return JSON.stringify({
    remarks: b.remarks,
    rawRemarks: raw.remarks,
    rawHasOld: Object.prototype.hasOwnProperty.call(raw, 'remark'),
    exportRemarks: exported.bookmarks[0].remarks,
    exportHasOld: Object.prototype.hasOwnProperty.call(exported.bookmarks[0], 'remark'),
  });
})()`));
check('v1 导出文件的 remark 导入为 remarks（落盘/再导出均无旧字段）',
  imported.remarks === '旧格式备注' && imported.rawRemarks === '旧格式备注' && !imported.rawHasOld
  && imported.exportRemarks === '旧格式备注' && !imported.exportHasOld, imported);

// ---- 5. UI：contents 展示态 / 编辑态字段名 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const page = await attachPage('wui.html');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(300);
for (let i = 0; i < 40; i++) {
  if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
  await sleep(250);
}
await sleep(300);
await page(`document.querySelector('#results-body tr').click()`);
await sleep(400);
const ui = JSON.parse(await page(`JSON.stringify({
  labels: [...document.querySelectorAll('#contents-view .kv-block .k')].map((x) => x.textContent),
  remarksText: document.querySelector('#contents-view').textContent.includes('旧格式备注'),
})`));
await page(`document.querySelector('#contents-view .detail-actions .btn').click()`);
await sleep(300);
const edit = JSON.parse(await page(`JSON.stringify({
  hasRemarks: !!document.querySelector('#edit-remarks'),
  value: document.querySelector('#edit-remarks')?.value,
  hasOld: !!document.querySelector('#edit-remark'),
})`));
check('contents 展示态字段名为 remarks 且内容可见',
  ui.labels.includes('remarks') && ui.remarksText, ui);
check('contents 编辑态使用 #edit-remarks（旧 id 不存在）',
  edit.hasRemarks && edit.value === '旧格式备注' && !edit.hasOld, edit);

await page.send('Page.enable');
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('tmp/shot-m11-remarks.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图: tmp/shot-m11-remarks.png');

summary();
close();
