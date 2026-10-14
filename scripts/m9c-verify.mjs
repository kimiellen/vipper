/**
 * M9c 自动化验收：设计系统入库 + wui 页面骨架。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - results：active/archived seg 切换、lastUsedAt 降序、favicon 首列、tag 彩色渲染、url数/账号数
 * - 搜索含 remark；TAGS/LINS 过滤（AND 语义）
 * - contents：点击行展示详情（密码/secret 遮蔽、时间格式化置底、status 标签）
 * - Settings 骨架：真实设置值与 tag/linkedInfo 只读列表
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景数据 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m9c-test');
  const tagDev = await __vipper.vault.addTag('dev', 'mauve');
  const tagOps = await __vipper.vault.addTag('运维', 'sky');
  const linkMail = await __vipper.vault.addLinkedInfo('邮箱1', 'me@example.com');
  const mk = (over) => __vipper.vault.addBookmark(over);
  const a = await mk({
    title: 'github', remark: '绑定了二次验证', tags: [tagDev.id], linkedInfos: [linkMail.id],
    urls: [{ url: 'https://github.com', match: 'host' }, { url: 'https://gist.github.com', match: 'host' }],
    accounts: [{ username: 'octocat', password: 'pw-1' }],
    records: [{ template: 'secret', name: '密保', content: '旺财' }],
  });
  await new Promise((r) => setTimeout(r, 10));
  const b = await mk({
    title: 'cloudflare', tags: [tagDev.id, tagOps.id],
    urls: [{ url: 'https://dash.cloudflare.com', match: 'host' }],
  });
  const c = await mk({
    title: 'old-archived', urls: [{ url: 'https://old.example.com', match: 'host' }],
  });
  await __vipper.vault.archiveBookmark(c.id);
  // github 设为最久未用（验证降序时它排后）
  const raw = await __vipper.vault.getBookmark(a.id);
  await __vipper.vault.saveBookmark({ ...raw, lastUsedAt: Date.now() - 86400000 });
  return JSON.stringify({ a: a.id, b: b.id, c: c.id, tagDev: tagDev.id, tagOps: tagOps.id });
})()`));

// ---- 打开 wui 页 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1440, height: 900 })`);
const page = await attachPage('wui.html');
for (let i = 0; i < 20; i++) {
  if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
  await sleep(250);
}
await sleep(300);

// ---- results ----
check('results：active 条目 2 条（归档不混入）',
  await page(`document.querySelectorAll('#results-body tr').length`) === 2);
check('results：lastUsedAt 降序（cloudflare 在前）',
  await page(`document.querySelector('#results-body tr td:nth-child(2)')?.textContent`) === 'cloudflare');
check('results：favicon 首列',
  await page(`document.querySelector('#results-body tr td img.favicon')?.src.includes('/_favicon/')`) === true);
check('results：tag 彩色渲染（cat 变量）',
  await page(`document.querySelector('#results-body tr .tag')?.style.color.includes('var(--cat-')`) === true);
check('results：url数/账号数列',
  await page(`[...document.querySelectorAll('#results-body tr')].map((r) => r.cells[4].textContent + '/' + r.cells[5].textContent).join(',')`) === '1/0,2/1');

// ---- 搜索（含 remark）----
await page(`(() => { const i = document.querySelector('#search'); i.value = '二次验证'; i.dispatchEvent(new Event('input')); })()`);
await sleep(200);
check('搜索命中 remark（剩 github 一条）',
  await page(`document.querySelectorAll('#results-body tr').length === 1 && document.querySelector('#results-body tr td:nth-child(2)').textContent === 'github'`));
await page(`(() => { const i = document.querySelector('#search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
await sleep(200);

// ---- TAGS 过滤（AND）----
await page(`[...document.querySelectorAll('#tag-filter-pop label')].find((l) => l.textContent.includes('运维')).querySelector('input').click()`);
await sleep(200);
check('TAGS 过滤：选「运维」后只剩 cloudflare',
  await page(`document.querySelectorAll('#results-body tr').length === 1 && document.querySelector('#results-body tr td:nth-child(2)').textContent === 'cloudflare'`));
await page(`[...document.querySelectorAll('#tag-filter-pop label')].find((l) => l.textContent.includes('运维')).querySelector('input').click()`);
await sleep(200);

// ---- archived seg ----
await page(`document.querySelector('#status-seg [data-status="archived"]').click()`);
await sleep(200);
check('archived seg：只显示归档条目 old-archived',
  await page(`document.querySelectorAll('#results-body tr').length === 1 && document.querySelector('#results-body tr td:nth-child(2)').textContent === 'old-archived'`));
await page(`document.querySelector('#status-seg [data-status="active"]').click()`);
await sleep(200);

// ---- contents 详情 ----
await page(`[...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent === 'github').click()`);
await sleep(400);
const detail = JSON.parse(await page(`JSON.stringify({
  title: document.querySelector('#contents-view .detail-head h3')?.textContent,
  passMasked: document.querySelector('#contents-view').textContent.includes('pass: ••••••••'),
  passPlainLeaked: document.querySelector('#contents-view').textContent.includes('pw-1'),
  secretMasked: document.querySelector('#contents-view').textContent.includes('密保: ********'),
  secretLeaked: document.querySelector('#contents-view').textContent.includes('旺财'),
  remarkShown: document.querySelector('#contents-view').textContent.includes('绑定了二次验证'),
  timeFormatted: /\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/.test(document.querySelector('#contents-view').textContent),
  timesLast: (() => { const ks = [...document.querySelectorAll('#contents-view .kv .k')].map((k) => k.textContent); return ks.slice(-3).join(',') === 'createdAt,updatedAt,lastUsedAt'; })(),
})`));
check('contents：标题 + 密码/secret 遮蔽（无明文泄漏）',
  detail.title === 'github' && detail.passMasked && !detail.passPlainLeaked && detail.secretMasked && !detail.secretLeaked, detail);
check('contents：remark 展示、时间格式化且置底',
  detail.remarkShown && detail.timeFormatted && detail.timesLast, detail);

// ---- Settings 骨架（M9e 起 general 为可编辑表单：默认 0 = 关闭） ----
const settings = JSON.parse(await page(`JSON.stringify({
  general: document.querySelector('#set-lock-timeout')?.value === '0' && document.querySelector('#set-auto-archive')?.value === '0',
  tagChip: !!document.querySelector('#settings-tags .tag, #settings-tag-list .tag'),
  linkRow: document.querySelector('#settings-links').textContent.includes('me@example.com'),
})`));
check('Settings：真实设置值（默认 0=关闭）+ tag/linkedInfo 列表',
  settings.general && settings.tagChip && settings.linkRow, settings);

summary();
close();
