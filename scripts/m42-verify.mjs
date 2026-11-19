/**
 * M42 自动化验收：授权层（socket-access.md §6/§13）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3）；
 * 环境约定同 m41-verify（XDG_RUNTIME_DIR 由 verify-all 注入，host socket 落在其中）。
 *
 * 断言：
 * - 寻址（§6.2）：vault 锁定 → locked；0 匹配 not_found；多匹配 ambiguous（绕过唯一性约束
 *   直写 storage 构造的旧数据防御分支）；⛔ disabled 与不存在统一 not_found（不泄露存在性）
 * - 三态（§6.1）：✅ 白名单直接放行（不弹窗）；✅ 非白名单 → not_found；🔔 弹确认窗
 *   （仅此一次 / 记住此客户端 / 拒绝三按钮 + 60s 倒计时文案）
 * - 令牌（§6.4）：放行后签发、存 chrome.storage.session（SW 回收不丢的载体）、TTL ≈ 8h；
 *   TTL 内同客户端同条目免弹窗；过期后同身份静默续期；锁库即清空全部令牌
 * - 「记住此客户端」：条目转 ✅ 且白名单写入该指纹，清令牌后仍免弹窗
 * - wui 编辑表单：secret 记录出现三态选择器 + 白名单勾选，保存后落盘
 *
 * 60s 超时默认拒绝的实际等待不在此跑（会撑爆单脚本 60s 硬超时）；倒计时文案与
 * SW 侧 at 兜底与 M41 同构，验收以文案断言为准。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { socketPath } from '../packages/vipper-protocol/paths.js';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const CLI = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-cli/bin/vipper-cli.js`;
const CLIENT_KEY = `${FAKE_HOME}/.config/vipper/client-key`;
const CLIENT_URL = pathToFileURL(resolve(ROOT, 'packages/vipper-cli/src/client.js')).href;

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// SW 30s 空闲会被回收（native 端口随之中断）：验收期间每 10s 一次 eval 保活
const keepAlive = setInterval(() => { sw('__vipper.socket.status().connected').catch(() => {}); }, 10_000);

/** 跑安装后的 cli（仅 pair 用），HOME 指进沙箱 */
function runCli(args) {
  const child = spawn('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return { child, done: new Promise((r) => child.on('close', (code) => r({ code, out, err }))) };
}

/**
 * 加密通道内发 get 请求的最小驱动（M43 才提供 vipper-cli get 命令，验收先行）。
 * 内联模块经 secureRequest 走完整配对 + 加密信封链路，与真实 cli 完全同码。
 */
function sget(path) {
  const code = `
    import { secureRequest } from ${JSON.stringify(CLIENT_URL)};
    try {
      const res = await secureRequest({ type: 'get', payload: { path: process.argv[1] } });
      console.log(JSON.stringify(res));
    } catch (e) {
      console.error(JSON.stringify({ code: e.code ?? 'error', message: e.message }));
      process.exitCode = 1;
    }
  `;
  const child = spawn('node', ['--input-type=module', '-e', code, path], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((r) => child.on('close', (code) => {
    let body = null;
    try { body = JSON.parse(code === 0 ? out : err); } catch { /* 保留原文 */ }
    r({ code, out, err, body });
  }));
  return { child, done };
}

/** 同步发 get 并解析结果：{ code, body }（body 为解密响应或错误 {code,message}） */
async function getResult(path) {
  return sget(path).done;
}

/** 当前 storage.session 里的令牌键（socket.token. 前缀） */
async function tokenKeys() {
  return JSON.parse(await sw(
    `(async () => JSON.stringify(Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('socket.token.'))))()`,
  ));
}

async function clearTokens() {
  await sw(`(async () => {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('socket.token.')));
  })()`);
}

// ---- 0. 安装最新 host/cli + host 链路就绪 + vault 解锁 ----
{
  const inst = spawnSync('bash', ['scripts/install-host.sh'], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
    encoding: 'utf8',
  });
  check('install-host.sh 安装成功', inst.status === 0, inst.stderr || inst.stdout);

  await sw(`chrome.storage.local.remove('socket.clients')`); // 从未配对状态开始
  rmSync(CLIENT_KEY, { force: true });
  await sw('__vipper.socket.connect()');
  const sock = socketPath();
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = existsSync(sock) && JSON.parse(await sw('JSON.stringify(__vipper.socket.status())')).connected;
    if (!ready) await sleep(200);
  }
  check('host 监听 socket 就位且扩展已连接', ready, sock);

  if (!(await sw('__vipper.keychain.isInitialized()'))) {
    await sw(`__vipper.keychain.setupMasterPassword('m42-test')`);
  }
  check('vault 解锁', await sw(`__vipper.keychain.unlock('m42-test')`) === true);
}

// ---- 1. 配对一个客户端（复用 M41 链路），拿到身份指纹 ----
let fp = '';
{
  const cli = runCli(['pair']);
  const page = await attachPage('confirm.html');
  await page(`document.getElementById('btn-allow').click()`);
  const res = await cli.done;
  check('配对成功', res.code === 0, res);
  const clients = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pairedClients()))()'));
  fp = Object.keys(clients)[0] ?? '';
  check('拿到客户端指纹', /^[0-9a-f]{64}$/.test(fp), clients);
}

// ---- 2. 准备条目：⛔ 缺省 / ✅ 白名单含本客户端 / ✅ 白名单不含 / 🔔 ----
let ids = {};
{
  ids = JSON.parse(await sw(`(async () => {
    const mk = (title, records) => __vipper.vault.addBookmark({
      title, urls: [{ url: 'https://m42.example', match: 'host' }], records,
    });
    const off = await mk('m42-off', [{ template: 'secret', name: 'api', content: 'OFF-SECRET' }]);
    const allow = await mk('m42-allow', [{ template: 'secret', name: 'api', content: 'ALLOWED-SECRET',
      socketExposure: { mode: 'allowed', clients: ['${fp}'] } }]);
    const other = await mk('m42-allow-other', [{ template: 'secret', name: 'api', content: 'OTHER-SECRET',
      socketExposure: { mode: 'allowed', clients: ['${'f'.repeat(64)}'] } }]);
    const ask = await mk('m42-ask', [{ template: 'secret', name: 'api', content: 'ASK-SECRET',
      socketExposure: { mode: 'ask', clients: [] } }]);
    return JSON.stringify({ off: off.id, allow: allow.id, other: other.id, ask: ask.id });
  })()`));
  check('条目准备完成', Object.keys(ids).length === 4, ids);
}

// ---- 3. vault 锁定：一切 get → locked ----
{
  await sw('__vipper.keychain.lock()');
  const res = await getResult('m42-allow/api');
  check('锁库时 get → locked', res.code !== 0 && res.body?.code === 'locked', res.body ?? res.err);
  await sw(`__vipper.keychain.unlock('m42-test')`);
}

// ---- 4. not_found：不存在与 ⛔ 不可区分（§6.1/§11） ----
{
  const none = await getResult('no/such');
  const off = await getResult('m42-off/api');
  check('不存在的路径 → not_found', none.body?.code === 'not_found', none.body);
  check('⛔ 缺省条目 → not_found（不泄露存在性）', off.body?.code === 'not_found', off.body);
  const bad = await getResult('noslash');
  check('无斜杠路径 → bad_request', bad.body?.code === 'bad_request', bad.body);
}

// ---- 5. ✅ 白名单直接放行 + 签发令牌（不弹窗） ----
{
  const res = await getResult('m42-allow/api');
  check('✅ 白名单 get 返回明文内容',
    res.code === 0 && res.body?.type === 'result' && res.body?.payload?.content === 'ALLOWED-SECRET', res.body ?? res.err);
  await sleep(500);
  check('✅ 放行不弹确认窗', !hasPage('confirm.html'), '出现了 confirm.html');
  const keys = await tokenKeys();
  const expiresAt = keys.length === 1
    ? await sw(`(async () => (await chrome.storage.session.get(${JSON.stringify(keys[0] ?? '')}))[${JSON.stringify(keys[0] ?? '')}])()`)
    : 0;
  const ttlOk = keys.length === 1 && keys[0].includes('m42-allow/api') && expiresAt > Date.now() + 7 * 3_600_000;
  check('令牌落 chrome.storage.session（TTL ≈ 8h，SW 回收不丢的载体）', ttlOk, { keys, expiresAt });
}

// ---- 6. ✅ 非白名单 → not_found ----
{
  const res = await getResult('m42-allow-other/api');
  check('✅ 非白名单客户端 → not_found', res.body?.code === 'not_found', res.body);
}

// ---- 7. 🔔 ask：确认窗三按钮 + 仅此一次放行 ----
{
  await clearTokens();
  const req = sget('m42-ask/api');
  let page = null;
  try {
    page = await attachPage('confirm.html');
  } catch { /* 统一断言 */ }
  check('🔔 请求触发授权确认窗', page !== null, 'confirm.html target 未出现');
  if (page) {
    await sleep(1200); // 倒计时由 1s interval 首次触发后渲染
    const shown = await page(`JSON.stringify({
      path: document.getElementById('a-path').textContent,
      name: document.getElementById('a-name').textContent,
      once: document.getElementById('a-btn-once')?.textContent,
      remember: document.getElementById('a-btn-remember')?.textContent,
      deny: document.getElementById('a-btn-deny')?.textContent,
      countdown: document.getElementById('a-countdown').textContent,
    })`).then(JSON.parse);
    check('确认窗展示条目路径/客户端名/三按钮/倒计时',
      shown.path === 'm42-ask/api' && shown.name.startsWith('vipper-cli@')
      && shown.once === '仅此一次' && shown.remember === '记住此客户端' && shown.deny === '拒绝'
      && /自动拒绝/.test(shown.countdown),
      shown);
    await page(`document.getElementById('a-btn-once').click()`);
  }
  const res = await req.done;
  check('仅此一次 → 返回明文内容', res.code === 0 && res.body?.payload?.content === 'ASK-SECRET', res.body ?? res.err);
  const keys = await tokenKeys();
  check('🔔 批准后签发令牌', keys.some((k) => k.includes('m42-ask/api')), keys);
}

// ---- 8. TTL 内同客户端同条目免弹窗 ----
{
  const res = await getResult('m42-ask/api');
  check('令牌命中免弹窗直接放行', res.code === 0 && res.body?.payload?.content === 'ASK-SECRET', res.body ?? res.err);
  await sleep(500);
  check('令牌命中未再弹确认窗', !hasPage('confirm.html'), '出现了 confirm.html');
}

// ---- 9. 🔔 拒绝 ----
{
  await clearTokens();
  const req = sget('m42-ask/api');
  const page = await attachPage('confirm.html');
  await page(`document.getElementById('a-btn-deny').click()`);
  const res = await req.done;
  check('拒绝 → denied 且退出非 0', res.code !== 0 && res.body?.code === 'denied', res.body ?? res.err);
  check('拒绝不签发令牌', (await tokenKeys()).length === 0, await tokenKeys());
}

// ---- 10. 记住此客户端：条目转 ✅ 且写入白名单 ----
{
  const req = sget('m42-ask/api');
  const page = await attachPage('confirm.html');
  await page(`document.getElementById('a-btn-remember').click()`);
  const res = await req.done;
  check('记住此客户端 → 返回明文内容', res.code === 0 && res.body?.payload?.content === 'ASK-SECRET', res.body ?? res.err);
  const rec = JSON.parse(await sw(`(async () => {
    const b = await __vipper.vault.getBookmark('${ids.ask}');
    return JSON.stringify(b.records[0].socketExposure ?? null);
  })()`));
  check('条目转为 ✅ 且白名单含本客户端指纹',
    rec?.mode === 'allowed' && rec?.clients?.includes(fp), rec);
  // 清令牌后仍免弹窗（白名单直接放行）
  await clearTokens();
  const again = await getResult('m42-ask/api');
  check('清令牌后白名单仍免弹窗放行', again.code === 0 && again.body?.payload?.content === 'ASK-SECRET', again.body ?? again.err);
  await sleep(500);
  check('白名单放行未弹确认窗', !hasPage('confirm.html'), '出现了 confirm.html');
}

// ---- 11. 令牌过期：同身份静默续期（§5.3/§6.4） ----
{
  const keyOf = (keys) => keys.find((k) => k.includes('m42-allow/api'));
  const readExp = (k) => sw(`(async () => (await chrome.storage.session.get(${JSON.stringify(k)}))[${JSON.stringify(k)}])()`);
  await getResult('m42-allow/api'); // 第 7 步清过令牌，先重新签发一枚
  const beforeKey = keyOf(await tokenKeys());
  await sw(`(async () => {
    const all = await chrome.storage.session.get(null);
    const k = Object.keys(all).find((k) => k.startsWith('socket.token.') && k.includes('m42-allow/api'));
    if (k) await chrome.storage.session.set({ [k]: Date.now() - 1000 }); // 强制过期
  })()`);
  const res = await getResult('m42-allow/api');
  check('令牌过期后 ✅ 白名单静默续期', res.code === 0 && res.body?.payload?.content === 'ALLOWED-SECRET', res.body ?? res.err);
  const afterKey = keyOf(await tokenKeys());
  const renewed = afterKey === beforeKey && (await readExp(afterKey)) > Date.now();
  check('续期后令牌键不变（同客户端指纹 + 同条目路径）', renewed, { beforeKey, afterKey });
  await sleep(500);
  check('过期续期不弹确认窗', !hasPage('confirm.html'), '出现了 confirm.html');
}

// ---- 12. 锁库即清空全部令牌（§6.4） ----
{
  const before = await tokenKeys();
  check('锁库前有令牌', before.length > 0, before);
  await sw('__vipper.keychain.lock()');
  check('锁库后令牌清空', (await tokenKeys()).length === 0, await tokenKeys());
  const res = await getResult('m42-allow/api');
  check('锁库后 get → locked', res.body?.code === 'locked', res.body);
  await sw(`__vipper.keychain.unlock('m42-test')`);
}

// ---- 13. ambiguous 防御分支（绕过 M39 唯一性约束直写 storage 构造重名旧数据） ----
{
  await sw(`(async () => {
    const idx = (await chrome.storage.local.get('idx')).idx ?? [];
    const mk = () => {
      const id = crypto.randomUUID();
      return {
        bm: { id, title: 'm42-dup', remarks: '', tags: [], linkedInfos: [], urls: [], accounts: [],
          records: [{ template: 'secret', name: 's', content: 'x' }],
          status: 'active', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
        ix: { id, title: 'm42-dup', remarks: '', tags: [], linkedInfos: [], urls: [],
          accountCount: 0, lastUsedAt: 1, status: 'active' },
      };
    };
    const a = mk();
    const b = mk();
    await chrome.storage.local.set({ ['bm:' + a.bm.id]: a.bm, ['bm:' + b.bm.id]: b.bm, idx: [...idx, a.ix, b.ix] });
  })()`);
  const res = await getResult('m42-dup/s');
  check('重名旧数据 → ambiguous（拒绝服务不猜）', res.body?.code === 'ambiguous', res.body);
}

// ---- 14. wui 编辑表单：secret 记录的三态选择器 + 白名单勾选落盘 ----
{
  await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
  const page = await attachPage('wui.html');
  for (let i = 0; i < 20; i++) {
    if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
    await sleep(250);
  }
  await sleep(300);
  await page(`[...document.querySelectorAll('#results-body tr')].find((r) => r.cells[1].textContent === 'm42-off').click()`);
  await sleep(400);
  const noPath = await page(`document.querySelectorAll('#contents-view .socket-path').length`);
  check('详情预览：未开启 socket 的 secret 不显示条目路径', noPath === 0, noPath);
  await page(`document.querySelector('#contents-view .detail-actions button').click()`); // ✎
  await sleep(300);
  const form = JSON.parse(await page(`JSON.stringify((() => {
    const sel = document.querySelector('#contents-edit .exposure-sel');
    return {
      hasSel: !!sel,
      value: sel?.value,
      clientsHidden: document.querySelector('#contents-edit .exposure-clients')?.hidden,
      clientLabels: [...document.querySelectorAll('#contents-edit .exposure-clients label')].map((l) => l.textContent),
    };
  })())`));
  check('编辑表单：secret 记录出现三态选择器，缺省 ⛔ disabled',
    form.hasSel && form.value === 'disabled' && form.clientsHidden === true, form);
  check('编辑表单：白名单列出已配对客户端',
    form.clientLabels.length === 1 && form.clientLabels[0].includes('vipper-cli@'), form.clientLabels);

  await page(`(() => {
    const sel = document.querySelector('#contents-edit .exposure-sel');
    sel.value = 'allowed';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await sleep(200);
  const shownClients = await page(`document.querySelector('#contents-edit .exposure-clients')?.hidden === false`);
  check('切 ✅ 后白名单勾选区可见', shownClients === true);
  await page(`document.querySelector('#contents-edit .exposure-clients input').click()`); // 勾选客户端
  await page(`document.getElementById('edit-save').click()`);
  await sleep(600);
  const saved = JSON.parse(await sw(`(async () => {
    const b = await __vipper.vault.getBookmark('${ids.off}');
    return JSON.stringify(b.records[0].socketExposure ?? null);
  })()`));
  check('表单保存后 socketExposure 落盘（✅ + 白名单指纹）',
    saved?.mode === 'allowed' && saved?.clients?.includes(fp), saved);

  await sleep(400);
  const pathRows = JSON.parse(await page(`JSON.stringify(
    [...document.querySelectorAll('#contents-view .socket-path')].map((r) => ({
      text: r.querySelector('.txt')?.textContent,
      title: r.querySelector('.txt')?.title,
      hasCopy: !!r.querySelector('button'),
    })),
  )`));
  check('详情预览：开启 socket 的 secret 显示条目路径 + 复制按钮',
    pathRows.length === 1
    && pathRows[0].text?.includes('m42-off/api')
    && pathRows[0].hasCopy
    && pathRows[0].title?.includes("vipper-cli get 'm42-off/api'"),
    pathRows);
}

clearInterval(keepAlive);
summary();
close();
