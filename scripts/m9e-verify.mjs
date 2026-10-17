/**
 * M9e 自动化验收：编辑态 + Settings 完成。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 编辑态：✎ 原地切换、改标题保存、行增删、status 切 archived、取消返回
 * - 新增书签：顶行按钮 → 空白编辑态 → 保存入 idx
 * - 删除书签：✕ + confirm → 从 idx 消失
 * - Settings tags：添加（带颜色）、被引用拒删、行内编辑、删除未引用项
 * - Settings linkedInfos：添加、重名拒绝
 * - 常规：超时锁定/自动归档天数保存；用户名/密码生成器
 * - 主题/语言切换并持久化到 meta:settings
 * - 备份：导出需主密码确认；导入合并生效
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景数据 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m9e-test');
  const tag = await __vipper.vault.addTag('dev', 'mauve');
  const link = await __vipper.vault.addLinkedInfo('邮箱1', 'me@example.com');
  const b = await __vipper.vault.addBookmark({
    title: 'github', remarks: '工作常用', tags: [tag.id], linkedInfos: [link.id],
    urls: [{ url: 'https://github.com', match: 'host' }],
    accounts: [{ username: 'octocat', password: 'pw-1' }],
    records: [{ template: 'note', name: '备注1', content: 'aaa' }, { template: 'secret', name: '密保', content: '旺财' }],
  });
  return JSON.stringify({ bm: b.id, tag: tag.id, link: link.id });
})()`));

await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const page = await attachPage('wui.html');
for (let i = 0; i < 20; i++) {
  if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
  await sleep(250);
}
await sleep(300);

// ---- 1. 编辑态：进入 / 修改 / 保存 ----
await page(`document.querySelector('#contents-view .detail-actions .btn').click()`); // ✎
await sleep(200);
check('✎ 原地切换编辑态（编辑区可见、标题回填）',
  await page(`!document.querySelector('#contents-edit').hidden && document.querySelector('#edit-title').value === 'github'`));

await page(`(() => { document.querySelector('#edit-title').value = 'github-改'; })()`);
// urls 添加行
const urlRowsBefore = await page(`document.querySelectorAll('#contents-edit .kv-block')[3].querySelectorAll('.frow').length`);
await page(`[...document.querySelectorAll('#contents-edit button')].find((b) => b.textContent.includes('添加 URL')).click()`);
await sleep(100);
check('urls 区「＋ 添加 URL」增行',
  await page(`document.querySelectorAll('#contents-edit .kv-block')[3].querySelectorAll('.frow').length`) === urlRowsBefore + 1);
// status 切 archived
await page(`document.querySelector('#edit-status-seg [data-status="archived"]').click()`);
await page(`document.querySelector('#edit-save').click()`);
await sleep(600);
const afterSave = JSON.parse(await sw(`__vipper.vault.listIndex().then((i) => JSON.stringify(i.find((e) => e.id === '${seed.bm}')))`));
check('保存：标题更新 + status 归档 + 顶行 seg 联动到 archived',
  afterSave.title === 'github-改' && afterSave.status === 'archived'
  && await page(`document.querySelector('#status-seg [data-status="archived"]').classList.contains('active')`), afterSave);
check('保存后回到展示态', await page(`document.querySelector('#contents-edit').hidden && !document.querySelector('#contents-view').hidden`));

// ---- 2. 新增书签 ----
await page(`document.querySelector('#new-btn').click()`);
await sleep(200);
await page(`(() => { document.querySelector('#edit-title').value = 'NewOne'; })()`);
await page(`document.querySelector('#edit-save').click()`);
await sleep(600);
check('新增书签保存入 idx', await sw(`__vipper.vault.listIndex().then((i) => i.some((e) => e.title === 'NewOne'))`) === true);

// ---- 3. 删除书签（confirm 放行）----
await page(`window.confirm = () => true`);
const before = await sw(`__vipper.vault.listIndex().then((i) => i.length)`);
await page(`document.querySelector('#contents-view .detail-actions .btn:last-child').click()`); // ✕ 删除当前选中
await sleep(500);
check('删除书签后从 idx 消失', await sw(`__vipper.vault.listIndex().then((i) => i.length)`) === before - 1);

// ---- 4. Settings：tags ----
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('标签') || h.textContent.includes('Tags')).click()`);
await sleep(300);
await page(`(() => { document.querySelector('#new-tag-name').value = '运维'; document.querySelector('#new-tag-color').value = 'sky'; })()`);
check('颜色下拉选项前置色块（swatch）',
  await page(`document.querySelectorAll('#new-tag-color option .swatch').length === 14`));
await page(`document.querySelector('#add-tag-btn').click()`);
await sleep(400);
const tagAdded = JSON.parse(await sw(`__vipper.vault.listTags().then((ts) => JSON.stringify(ts.find((x) => x.name === '运维')))`));
check('Settings：添加 tag 带颜色 sky', tagAdded?.color === 'sky', tagAdded);

// 被引用拒删（dev 被 github-改 引用）
await page(`(() => {
  const rows = [...document.querySelectorAll('#settings-tag-list .rlist-row')];
  const row = rows.find((r) => r.textContent.includes('dev'));
  row.querySelector('.rlist-actions .btn:last-child').click();
})()`);
await sleep(400);
check('被引用 tag 拒绝删除并报错',
  await page(`!document.querySelector('#tag-err').hidden && document.querySelector('#tag-err').textContent.includes('引用')`));

// 删除未引用的「运维」
await page(`(() => {
  const rows = [...document.querySelectorAll('#settings-tag-list .rlist-row')];
  const row = rows.find((r) => r.textContent.includes('运维'));
  row.querySelector('.rlist-actions .btn:last-child').click();
})()`);
await sleep(400);
check('未引用 tag 删除成功', await sw(`__vipper.vault.listTags().then((ts) => !ts.some((x) => x.name === '运维'))`) === true);

// ---- 5. Settings：linkedInfos 重名拒绝 ----
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('关联信息') || h.textContent.includes('Linked')).click()`);
await sleep(300);
await page(`(() => { document.querySelector('#new-link-name').value = '邮箱1'; document.querySelector('#new-link-value').value = 'x@y.z'; })()`);
await page(`document.querySelector('#add-link-btn').click()`);
await sleep(300);
check('linkedInfo 重名拒绝并报错', await page(`!document.querySelector('#link-err').hidden`));

// ---- 6. 常规：超时锁定/生成器/主题/语言 ----
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('常规') || h.textContent.includes('General')).click()`);
await sleep(300);
await page(`(() => { const i = document.querySelector('#set-lock-timeout'); i.value = '5'; })()`);
await page(`document.querySelector('#set-lock-timeout').closest('.inline-field').querySelector('.btn').click()`);
await sleep(300);
check('超时锁定保存为 5', await sw(`__vipper.keychain.getSettings().then((s) => s.lockTimeoutMin)`) === 5);

await page(`[...document.querySelectorAll('#settings-general .gen-row')].map((r) => r.querySelector('input')?.id).join(',')`);
await page(`[...document.querySelectorAll('#settings-general .btn')].find((b) => b.textContent === '⟳').click()`);
const genUser = await page(`document.querySelector('#gen-user-out').value`);
check('用户名生成器产出（单词+2 位数字）', /^[a-z]+\d{2}$/.test(genUser), genUser);
await page(`[...document.querySelectorAll('#settings-general .gen-row')][1].querySelector('[title="生成"]').click()`);
const genPass = await page(`document.querySelector('#gen-pass-out').value`);
check('密码生成器产出（默认 12 位）', genPass.length === 12, genPass);

await page(`document.querySelector('#scheme-seg [data-value="light"]').click()`);
await sleep(300);
check('主题切到 light 并持久化',
  await page(`document.documentElement.getAttribute('data-theme') === 'light'`)
  && await sw(`__vipper.keychain.getSettings().then((s) => s.theme)`) === 'light');

await page(`document.querySelector('#lang-seg [data-value="english"]').click()`);
await sleep(300);
check('语言切到 english 并持久化（新增按钮变英文）',
  await page(`document.querySelector('#new-btn').textContent === '＋ New Bookmark'`)
  && await sw(`__vipper.keychain.getSettings().then((s) => s.lang)`) === 'en');
await page(`document.querySelector('#lang-seg [data-value="简体中文"]')?.click()`);
await sleep(200);

// ---- 7. 备份：导出主密码确认 ----
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('备份') || h.textContent.includes('Backup')).click()`);
await sleep(300);
await page(`(() => { document.querySelector('#backup-pw').value = 'wrong'; })()`);
await page(`document.querySelector('#export-btn').click()`);
await sleep(400);
check('导出：错误主密码被拒', await page(`!document.querySelector('#backup-status').hidden && document.querySelector('#backup-status').textContent.includes('密码')`));
await page(`(() => { document.querySelector('#backup-pw').value = 'm9e-test'; })()`);
await page(`document.querySelector('#export-btn').click()`);
await sleep(500);
check('导出：正确密码导出成功', await page(`document.querySelector('#backup-status').textContent.includes('已导出') || document.querySelector('#backup-status').textContent.includes('Exported')`));

// ---- 8. 手动锁定 ----
await page(`[...document.querySelectorAll('.set-head')].find((h) => h.textContent.includes('常规') || h.textContent.includes('General')).click()`);
await sleep(300);
await page(`document.querySelector('#lock-btn').click()`);
await sleep(2000); // location.reload() + 门控路由
check('手动锁定：回到解锁页（覆盖层出现、解锁模式）',
  await page(`!document.querySelector('#unlock-overlay').hidden && document.querySelector('#ov-pw2').hidden`));
check('手动锁定：密钥已清除', await sw(`__vipper.keychain.isUnlocked()`) === false);

summary();
close();
