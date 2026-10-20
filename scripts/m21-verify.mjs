/**
 * M21 自动化验收：wui TAGS/LINS 过滤选择会话内记忆。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 选中 tag/linkedInfo 后关闭窗口再经 Alt+.（open-launcher）重开，勾选与过滤结果都保持
 * - 取消选择后重开仍为空，结果恢复全量
 * - 选择期间被删除的 tag 在重开时自动剔除，不会把结果全部隐藏
 * - 状态只落 chrome.storage.session，不落 chrome.storage.local
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 场景数据：github 挂 dev+邮箱1，cloudflare 挂 dev+运维+手机1，plain 无标签 ----
const seed = JSON.parse(await sw(`(async () => {
  await __vipper.keychain.setupMasterPassword('m21-test');
  const tagDev = await __vipper.vault.addTag('dev', 'mauve');
  const tagOps = await __vipper.vault.addTag('运维', 'sky');
  const tagOrphan = await __vipper.vault.addTag('orphan', 'green');
  const linkMail = await __vipper.vault.addLinkedInfo('邮箱1', 'me@example.com');
  const linkPhone = await __vipper.vault.addLinkedInfo('手机1', '13800000000');
  await __vipper.vault.addBookmark({
    title: 'github', tags: [tagDev.id], linkedInfos: [linkMail.id],
    urls: [{ url: 'https://github.com', match: 'host' }],
  });
  await __vipper.vault.addBookmark({
    title: 'cloudflare', tags: [tagDev.id, tagOps.id], linkedInfos: [linkPhone.id],
    urls: [{ url: 'https://dash.cloudflare.com', match: 'host' }],
  });
  await __vipper.vault.addBookmark({
    title: 'plain', urls: [{ url: 'https://plain.example.com', match: 'host' }],
  });
  return JSON.stringify({
    tagDev: tagDev.id, tagOps: tagOps.id, tagOrphan: tagOrphan.id,
    linkMail: linkMail.id, linkPhone: linkPhone.id,
  });
})()`));

async function openWui() {
  await sw(`__vipper.dispatch('open-launcher')`);
  const page = await attachPage('wui.html');
  for (let i = 0; i < 40; i++) {
    const n = await page(`document.querySelectorAll('#results-body tr').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(250);
  }
  await sleep(200);
  return page;
}

/** 模拟 Alt+. 关闭：经 background 同一逻辑移除 wui 窗口 */
async function closeWui() {
  await sw(`(async () => {
    const w = (await chrome.windows.getAll({ populate: true }))
      .find((x) => x.tabs?.some((t) => t.url === chrome.runtime.getURL('wui.html')));
    if (w) await chrome.windows.remove(w.id);
  })()`);
  for (let i = 0; i < 40 && hasPage('wui.html'); i++) await sleep(100);
  await sleep(200);
}

async function toggle(page, kind, name) {
  const pop = kind === 'tag' ? '#tag-filter-pop' : '#link-filter-pop';
  await page(`[...document.querySelectorAll('${pop} label')]
    .find((l) => l.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
  await sleep(250);
}

/** 读取当前勾选（显示名）与结果行（书签名） */
async function view(page) {
  return JSON.parse(await page(`JSON.stringify({
    tags: [...document.querySelectorAll('#tag-filter-pop input:checked')]
      .map((i) => i.closest('label').textContent.trim()),
    links: [...document.querySelectorAll('#link-filter-pop input:checked')]
      .map((i) => i.closest('label').textContent.trim()),
    rows: [...document.querySelectorAll('#results-body tr td:nth-child(2)')].map((td) => td.textContent),
    emptyShown: document.querySelector('#results-empty').hidden === false,
  })`));
}

const sessionState = () => sw(`chrome.storage.session.get('ui:wuiFilters')
  .then((s) => JSON.stringify(s['ui:wuiFilters'] ?? null))`).then(JSON.parse);

// ---- 场景 A：选中 → 关窗重开仍保持 ----
let page = await openWui();
check('初始：3 条 active 条目、无过滤', (await view(page)).rows.length === 3);

await toggle(page, 'tag', 'dev');
await toggle(page, 'link', '邮箱1');
let v = await view(page);
check('选中 dev + 邮箱1：只剩 github', v.rows.length === 1 && v.rows[0] === 'github', v);
let saved = await sessionState();
check('选择写入 storage.session（tag/link id）',
  saved?.tags?.length === 1 && saved.tags[0] === seed.tagDev
  && saved?.links?.length === 1 && saved.links[0] === seed.linkMail, saved);

await closeWui();
page = await openWui();
v = await view(page);
check('关窗重开：勾选保持 dev + 邮箱1', v.tags.includes('dev') && v.links.includes('邮箱1'), v);
check('关窗重开：过滤结果保持只剩 github', v.rows.length === 1 && v.rows[0] === 'github', v);

// ---- 场景 B：取消 → 关窗重开仍为空 ----
await toggle(page, 'tag', 'dev');
await toggle(page, 'link', '邮箱1');
await closeWui();
page = await openWui();
v = await view(page);
check('取消后重开：无勾选、结果恢复全量', v.tags.length === 0 && v.links.length === 0 && v.rows.length === 3, v);
saved = await sessionState();
check('取消后 storage.session 为空集合', saved?.tags?.length === 0 && saved?.links?.length === 0, saved);

// ---- 场景 C：失效 id 剔除，不残留隐藏全部结果 ----
await toggle(page, 'tag', 'orphan'); // 无书签引用 → 结果为空
v = await view(page);
check('选中 orphan：结果为空并显示空状态', v.rows.length === 0 && v.emptyShown, v);
await closeWui();
await sw(`__vipper.vault.deleteTag(${JSON.stringify(seed.tagOrphan)})`); // 未被引用，允许删除
page = await openWui();
v = await view(page);
check('重开：已删除的 orphan 被剔除，结果恢复全量', v.tags.length === 0 && v.rows.length === 3, v);
saved = await sessionState();
check('重开：失效 id 已从会话状态剔除', saved?.tags?.length === 0, saved);

// ---- 场景 D：只落 session，不落 local ----
check('状态只落 storage.session，不落 storage.local',
  await sw(`chrome.storage.local.get('ui:wuiFilters')
    .then((s) => s['ui:wuiFilters'] === undefined)`) === true);

summary();
close();
