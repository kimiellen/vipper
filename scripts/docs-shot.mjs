/**
 * 手册截图生成：Chromium headless + CDP 驱动真实扩展 UI，播种一套连贯演示数据，
 * 双语（zh/en）截取 docs/guide/assets/ 下的全部手册配图。
 *
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 * 用法：node scripts/docs-shot.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import { connectSW, sleep } from './lib/sw-driver.mjs';

const OUT = 'docs/guide/assets';
const PORT_DEMO = 8381; // 有匹配书签（多账号）→ Alt+P 菜单 / 追加浮卡
const PORT_NEW = 8382;  // 无匹配书签 → 新建浮卡

// ---------- 本地演示登录站（仿淘宝橙色风格，避免商标素材） ----------
const loginPage = (title, brand) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;font:14px system-ui;background:#f5f5f5">
<div style="height:64px;background:#ff5000;color:#fff;display:flex;align-items:center;padding:0 24px;font-size:18px">${brand}</div>
<div style="max-width:420px;margin:80px auto;padding:28px;background:#fff;border-radius:8px;box-shadow:0 2px 10px #0002">
  <h2 style="margin:0 0 20px;font-size:20px">会员登录 · Sign in</h2>
  <input id="u" type="text" autocomplete="username" placeholder="账号 / Account" style="width:100%;padding:10px;margin-bottom:12px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box" />
  <input id="p" type="password" autocomplete="current-password" placeholder="密码 / Password" style="width:100%;padding:10px;margin-bottom:16px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box" />
  <button id="go" type="submit" style="width:100%;padding:10px;background:#ff5000;color:#fff;border:0;border-radius:4px;font-size:15px">登录</button>
</div>
<script>document.querySelector('#go').addEventListener('click', () => { location.href = '/welcome'; });</script>
</body></html>`;
const welcomePage = (brand) => `<!doctype html><html><head><meta charset="utf-8"><title>${brand}</title></head>
<body style="margin:0;font:14px system-ui;background:#f5f5f5">
<div style="height:64px;background:#ff5000;color:#fff;display:flex;align-items:center;padding:0 24px;font-size:18px">${brand}</div>
<div style="max-width:420px;margin:80px auto;padding:28px;background:#fff;border-radius:8px"><h2 style="margin:0">欢迎回来 · Welcome</h2></div>
</body></html>`;

function serve(port, title, brand) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url.startsWith('/welcome') ? welcomePage(brand) : loginPage(title, brand));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
const srvDemo = await serve(PORT_DEMO, 'Acme Cloud - 登录', 'Acme Cloud');
const srvNew = await serve(PORT_NEW, 'Nova Mail - 登录', 'Nova Mail');

// ---------- CDP ----------
const { sw, attachPage, close } = await connectSW();

// headless 窗口尺寸不可控（默认 800x600），截图前用 Emulation 强制目标视口
async function shot(page, name, width = 1600, height = 900) {
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
}
const waitFor = async (page, expr, desc) => {
  for (let i = 0; i < 40; i++) {
    if (await page(expr).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error('timeout: ' + desc);
};
const reloadWui = async (wui) => {
  await wui(`location.reload()`);
  await sleep(600);
  await waitFor(wui, `!!document.querySelector('#search')`, 'wui reload');
};

// tabnav-only 模式：只重生示意图（shotTabnav 声明在文件尾部，函数声明提升可用）
if (process.argv[2] === 'tabnav') {
  await shotTabnav();
  close();
  console.log('DONE (tabnav only)');
  process.exit(0);
}

// ---------- Phase 0：全新状态 → 解锁页（创建 / 解锁两种模式） ----------
// 重入清理：关闭上一轮遗留的 wui / 演示站 / 示意图窗口
await sw(`(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.tabs?.some((t) => t.url?.includes('wui.html') || t.url?.includes(':838') || t.url?.includes('docs-shot-tabnav'))) {
      await chrome.windows.remove(w.id).catch(() => {});
    }
  }
})()`);
await sleep(400);
await sw(`(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); })()`);
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const wui = await attachPage('wui.html');
await waitFor(wui, `(() => { const o = document.querySelector('#unlock-overlay'); return o && !o.hidden && o.dataset.mode === 'setup'; })()`, 'unlock setup mode');
await sleep(400);
await shot(wui, 'unlock-create.zh');
await wui(`document.querySelector('#ov-lang-seg [data-lang=en]').click()`);
await sleep(300);
await shot(wui, 'unlock-create.en');

// 创建主密码后锁定，再回页面 → 解锁模式
await sw(`__vipper.keychain.setupMasterPassword('demo-master-2026')`);
await sw(`__vipper.keychain.lock()`);
await wui(`location.reload()`);
await sleep(600);
await waitFor(wui, `(() => { const o = document.querySelector('#unlock-overlay'); return o && !o.hidden && o.dataset.mode === 'unlock'; })()`, 'unlock mode');
await shot(wui, 'unlock.en');
await wui(`document.querySelector('#ov-lang-seg [data-lang=zh]').click()`);
await sleep(300);
await shot(wui, 'unlock.zh');

// ---------- Phase 1：播种演示数据 ----------
const seed = JSON.parse(await sw(`(async () => {
  const v = __vipper.vault;
  await __vipper.keychain.unlock('demo-master-2026');
  const dev = await v.addTag('dev', 'mauve');
  const shop = await v.addTag('购物', 'peach');
  const bank = await v.addTag('银行', 'green');
  const fun = await v.addTag('娱乐', 'pink');
  const ops = await v.addTag('运维', 'sky');
  const imp = await v.addTag('重要', 'red');
  const mail = await v.addLinkedInfo('邮箱1', 'kimi@example.com');
  const phone = await v.addLinkedInfo('手机1', '138****0000');
  const wx = await v.addLinkedInfo('微信', 'kimi-vipper');
  const now = Date.now();
  const mk = async (over, ageMin) => {
    const b = await v.addBookmark(over);
    const raw = await v.getBookmark(b.id);
    await v.saveBookmark({ ...raw, lastUsedAt: now - ageMin * 60000 });
    return b.id;
  };
  const github = await mk({
    title: 'GitHub', remarks: '绑定了二次验证', tags: [dev.id, imp.id], linkedInfos: [mail.id],
    urls: [{ url: 'https://github.com', match: 'host' }, { url: 'https://gist.github.com', match: 'host' }],
    accounts: [{ username: 'kimiellen', password: 'gh-demo-pw-1' }, { username: 'ci-bot', password: 'gh-demo-pw-2' }],
    records: [
      { template: 'note', name: '常用仓库', content: 'vipper / dsh / dotfiles' },
      { template: 'secret', name: '恢复码', content: 'r8k2-xxxx-xxxx' },
    ],
  }, 5);
  await mk({
    title: '淘宝网', remarks: '大促前记得比价', tags: [shop.id], linkedInfos: [phone.id],
    urls: [{ url: 'https://www.taobao.com', match: 'host' }],
    accounts: [{ username: 'tb_main', password: 'tb-pw-1' }, { username: 'tb_sub', password: 'tb-pw-2' }],
  }, 30);
  await mk({
    title: '招商银行', remarks: '工资卡 · 手机银行', tags: [bank.id, imp.id], linkedInfos: [phone.id],
    urls: [{ url: 'https://www.cmbchina.com', match: 'host' }],
    accounts: [{ username: 'cmb_kimi', password: 'cmb-pw' }],
    records: [{ template: 'secret', name: '查询密码', content: '6 位数字' }],
  }, 120);
  await mk({
    title: '哔哩哔哩', remarks: '追番清单在收藏夹', tags: [fun.id],
    urls: [{ url: 'https://www.bilibili.com', match: 'host' }],
    accounts: [{ username: 'kimi_bili', password: 'bili-pw' }],
  }, 300);
  await mk({
    title: '阿里云控制台', tags: [ops.id],
    urls: [{ url: 'https://home.console.aliyun.com', match: 'host' }],
    accounts: [{ username: 'ops@acme.cn', password: 'ali-pw' }],
    records: [{ template: 'secret', name: 'AccessKey', content: 'LTAI-demo-xxxx' }],
  }, 1560);
  await mk({
    title: 'Cloudflare', remarks: 'DNS 托管', tags: [dev.id, ops.id],
    urls: [{ url: 'https://dash.cloudflare.com', match: 'host' }],
    accounts: [{ username: 'kimi@example.com', password: 'cf-pw' }],
  }, 3000);
  await mk({
    title: 'Gmail', tags: [imp.id], linkedInfos: [mail.id],
    urls: [{ url: 'https://mail.google.com', match: 'host' }],
    accounts: [{ username: 'kimiellen@gmail.com', password: 'g-pw' }],
  }, 4800);
  await mk({
    title: '少数派', remarks: '灵感来源',
    urls: [{ url: 'https://sspai.com', match: 'host' }],
  }, 6000);
  const old = await v.addBookmark({ title: '旧博客', urls: [{ url: 'https://oldblog.example.com', match: 'host' }] });
  await v.archiveBookmark(old.id);
  return JSON.stringify({ github });
})()`));

// ---------- Phase 2：wui 主页面系列 ----------
await reloadWui(wui);
await waitFor(wui, `document.querySelectorAll('#results-body tr').length >= 8`, 'seeded rows');
await sleep(400);

const selectGithub = async () => {
  await wui(`[...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent === 'GitHub').click()`);
  await sleep(350);
};
const doSearch = async (q) => {
  await wui(`(() => { const i = document.querySelector('#search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
};
const openTagFilter = async (names) => {
  await wui(`(() => { const d = document.querySelector('#tag-filter'); d.open = true; })()`);
  await sleep(200);
  for (const n of names) {
    await wui(`[...document.querySelectorAll('#tag-filter-pop label')].find((l) => l.textContent.includes(${JSON.stringify(n)})).querySelector('input').click()`);
    await sleep(150);
  }
};
const closeTagFilter = async () => {
  await wui(`(() => { const d = document.querySelector('#tag-filter'); d.open = false; })()`);
  // 清掉勾选项
  await wui(`[...document.querySelectorAll('#tag-filter-pop input:checked')].forEach((c) => c.click())`);
  await sleep(200);
};
const clickEdit = async () => {
  await wui(`document.querySelector('#contents-view .detail-actions button').click()`);
  await waitFor(wui, `!document.querySelector('#contents-edit').hidden`, 'edit mode');
  await sleep(300);
};
const cancelEdit = async () => {
  await wui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
};
const openSettings = async (label) => {
  await wui(`[...document.querySelectorAll('.set-head')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`);
  await sleep(400);
};

// --- zh / dark ---
await selectGithub();
await shot(wui, 'main.zh');
// 多 URL 二级菜单（回车触发）
await wui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
await sleep(400);
if (await wui(`!document.querySelector('#url-menu').hidden`).catch(() => false)) {
  await shot(wui, 'open-url-menu.zh');
  await wui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
}
await doSearch('yh');
await shot(wui, 'search-pinyin.zh');
await doSearch('');
await openTagFilter(['dev', '重要']);
await shot(wui, 'filter-tags.zh');
await closeTagFilter();
await selectGithub();
await clickEdit();
await shot(wui, 'edit.zh');
await cancelEdit();
await openSettings('标签');
await shot(wui, 'settings-tags.zh');
await openSettings('常规');
await shot(wui, 'settings-general.zh');
await openSettings('备份');
await shot(wui, 'settings-backup.zh');

// --- en / dark ---
await sw(`__vipper.keychain.setSettings({ lang: 'en' })`);
await reloadWui(wui);
await waitFor(wui, `document.querySelectorAll('#results-body tr').length >= 8`, 'rows en');
await sleep(300);
await selectGithub();
await shot(wui, 'main.en');
await wui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
await sleep(400);
if (await wui(`!document.querySelector('#url-menu').hidden`).catch(() => false)) {
  await shot(wui, 'open-url-menu.en');
  await wui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
}
await doSearch('yh');
await shot(wui, 'search-pinyin.en');
await doSearch('');
await openTagFilter(['dev', '重要']);
await shot(wui, 'filter-tags.en');
await closeTagFilter();
await selectGithub();
await clickEdit();
await shot(wui, 'edit.en');
await cancelEdit();
await openSettings('Tags');
await shot(wui, 'settings-tags.en');
await openSettings('General');
await shot(wui, 'settings-general.en');
await openSettings('Backup');
await shot(wui, 'settings-backup.en');

// --- light 主题（双语言各一张主页面） ---
await sw(`__vipper.keychain.setSettings({ theme: 'light' })`);
await reloadWui(wui);
await waitFor(wui, `document.querySelectorAll('#results-body tr').length >= 8`, 'rows light en');
await sleep(300);
await selectGithub();
await shot(wui, 'main-light.en');
await sw(`__vipper.keychain.setSettings({ lang: 'zh' })`);
await reloadWui(wui);
await waitFor(wui, `document.querySelectorAll('#results-body tr').length >= 8`, 'rows light zh');
await sleep(300);
await selectGithub();
await shot(wui, 'main-light.zh');
await sw(`__vipper.keychain.setSettings({ theme: 'dark' })`);

// ---------- Phase 3：content script UI（Alt+P 菜单 / 保存浮卡） ----------
await sw(`(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.tabs?.some((t) => t.url?.includes('wui.html'))) await chrome.windows.remove(w.id).catch(() => {});
  }
})()`);
await sleep(400);
// 追加演示站书签（双账号），此前的主页面截图不受其影响
await sw(`(async () => {
  const v = __vipper.vault;
  const dev = (await v.listTags()).find((t) => t.name === 'dev');
  await v.addBookmark({
    title: 'Acme Cloud', tags: [dev.id],
    urls: [{ url: 'http://127.0.0.1:${PORT_DEMO}', match: 'host' }],
    accounts: [{ username: 'alice@example.com', password: 'acme-pw-1' }, { username: 'alice-ops', password: 'acme-pw-2' }],
  });
})()`);

const openLoginTab = async (host) => {
  await sw(`(async () => {
    const win = await chrome.windows.getCurrent();
    const t = await chrome.tabs.create({ windowId: win.id, url: 'http://${host}/login', active: true });
    await chrome.windows.update(win.id, { focused: true }).catch(() => {});
  })()`);
  await sleep(1200);
  return attachPage(`:${host.split(':')[1]}/login`);
};
const closeTabsOf = async (port) => {
  await sw(`(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.url?.includes(':${port}')) await chrome.tabs.remove(t.id).catch(() => {});
  })()`);
  await sleep(300);
};
const escPage = async (page) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
};

// Alt+P 二级菜单（en / zh）
for (const lang of ['en', 'zh']) {
  await sw(`__vipper.keychain.setSettings({ lang: '${lang}' })`);
  const login = await openLoginTab('127.0.0.1:' + PORT_DEMO);
  await sw(`__vipper.dispatch('autofill')`);
  await sleep(1200);
  await shot(login, `autofill-menu.${lang}`, 1440, 900);
  await escPage(login);
  await closeTabsOf(PORT_DEMO);
}

// 新建浮卡（无匹配条目）：Nova Mail
for (const lang of ['zh', 'en']) {
  await sw(`__vipper.keychain.setSettings({ lang: '${lang}' })`);
  const login = await openLoginTab('localhost:' + PORT_NEW);
  await login(`document.querySelector('#u').value = 'kimi@nova.mail'; document.querySelector('#p').value = 'nova-pw-2026'; document.querySelector('#go').click(); true`);
  await sleep(2500);
  const welcome = await attachPage(`:${PORT_NEW}/welcome`);
  await shot(welcome, `save-card-new.${lang}`, 1440, 900);
  await closeTabsOf(PORT_NEW);
}

// 追加浮卡（Acme Cloud 已有条目、新 username）
for (const lang of ['zh', 'en']) {
  await sw(`__vipper.keychain.setSettings({ lang: '${lang}' })`);
  const login = await openLoginTab('127.0.0.1:' + PORT_DEMO);
  await login(`document.querySelector('#u').value = 'alice-new'; document.querySelector('#p').value = 'acme-pw-3'; document.querySelector('#go').click(); true`);
  await sleep(2500);
  const welcome = await attachPage(`:${PORT_DEMO}/welcome`);
  await shot(welcome, `save-card-append.${lang}`, 1440, 900);
  await closeTabsOf(PORT_DEMO);
}

// ---------- Phase 4：标签导航示意图（产品 UI 为 Chrome 标签栏，headless 截不到 → HTML 示意图） ----------
// 用法：node scripts/docs-shot.mjs        全量
//       node scripts/docs-shot.mjs tabnav 只重生示意图（快捷键/文案改版时）
async function shotTabnav() {
  for (const lang of ['zh', 'en']) {
    await sw(`chrome.windows.create({ url: 'file://' + ${JSON.stringify(process.cwd())} + '/scripts/docs-shot-tabnav.html?lang=${lang}', type: 'popup', width: 1280, height: 560 })`);
    const dia = await attachPage('docs-shot-tabnav.html');
    await sleep(600);
    await shot(dia, `tabnav.${lang}`, 1280, 560);
    await sw(`(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url?.includes('docs-shot-tabnav')) {
        const win = await chrome.windows.get(t.windowId);
        await chrome.windows.remove(win.id).catch(() => {});
      }
    })()`);
    await sleep(300);
  }
}

srvDemo.close();
srvNew.close();
await shotTabnav();
close();
console.log('DONE');
