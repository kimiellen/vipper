/**
 * M41 自动化验收：配对层（socket-access.md §5/§13）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3）；
 * 环境约定同 m40-verify（XDG_RUNTIME_DIR 由 verify-all 注入，host socket 落在其中）。
 *
 * 断言：
 * - 未配对请求全拒（§5/§11）：明文业务请求、伪造 session 信封、篡改密文 → 统一 unpaired
 * - 配对握手：cli sping 触发确认窗（chrome.windows.create 小窗），
 *   待确认请求落 chrome.storage.session（§7 要点 3）；窗内展示名称/路径/PID/指纹；
 *   点「允许配对」→ 通道建立，加密 ping 回显成功
 * - 配对存储：chrome.storage.local 出现客户端记录（指纹/名称/配对时间）；
 *   私钥文件 ~/.config/vipper/client-key 0600
 * - 身份复用：再次 sping 不再弹窗直接成功（§5.3 身份不变）
 * - 拒绝路径：撤销配对记录后重连，点「拒绝」→ cli 收到 pair_denied 退出非 0
 * - 删私钥文件需重新配对（§5.3）：删 client-key → 新身份 → 确认窗再次出现（指纹不同）
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { encodeFrame, createFrameParser } from '../packages/vipper-protocol/frame.js';
import { socketPath } from '../packages/vipper-protocol/paths.js';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const CLI = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-cli/bin/vipper-cli.js`;
const CLIENT_KEY = `${FAKE_HOME}/.config/vipper/client-key`;

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// SW 30s 空闲会被回收（native 端口随之中断）：验收期间每 10s 一次 eval 保活
const keepAlive = setInterval(() => { sw('__vipper.socket.status().connected').catch(() => {}); }, 10_000);

/** 跑安装后的 cli，HOME 指进沙箱（身份文件落 .fake-home/.config/vipper/） */
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

/** 裸协议请求（不经 cli）：连 host → $peer.hello → 发一帧 → 收同 id 响应 */
function rawRequest(frame, { timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const sock = net.connect(socketPath());
    const timer = setTimeout(() => { sock.destroy(); rejectPromise(new Error('raw 请求超时')); }, timeoutMs);
    const parser = createFrameParser((msg) => {
      if (msg?.id === frame.id) {
        clearTimeout(timer);
        sock.destroy();
        resolvePromise(msg);
      }
    }, (err) => { clearTimeout(timer); sock.destroy(); rejectPromise(err); });
    sock.on('error', (e) => { clearTimeout(timer); rejectPromise(e); });
    sock.on('data', (c) => parser.push(c));
    sock.on('connect', () => {
      sock.write(encodeFrame({ v: 1, type: '$peer.hello', pid: process.pid }));
      sock.write(encodeFrame(frame));
    });
  });
}

// ---- 0. 安装最新 host/cli + host 链路就绪 ----
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
}

// ---- 1. 未配对请求全拒（§5/§11） ----
{
  // 明文业务请求（非 pair/ping）：统一 unpaired
  const plain = await rawRequest({ v: 1, id: 'm41-plain', type: 'get', payload: { path: 'x/y' } });
  check('未配对明文业务请求 → unpaired', plain.type === 'error' && plain.error?.code === 'unpaired', plain);

  // 伪造 session 的加密信封：统一 unpaired
  const forged = await rawRequest({
    v: 1, id: 'm41-forged', session: 'nonexistent-session',
    $enc: 'v1', iv: Buffer.alloc(12).toString('base64'), data: Buffer.alloc(32).toString('base64'),
  });
  check('伪造 session 信封 → unpaired', forged.type === 'error' && forged.error?.code === 'unpaired', forged);
}

// ---- 2. 配对握手：确认窗允许 → 加密通道可用 ----
let firstFingerprint = '';
{
  const cli = runCli(['sping', 'm41-加密通道']);
  // 确认窗出现（chrome.windows.create 小窗，§7）
  let page = null;
  try {
    page = await attachPage('confirm.html');
  } catch { /* 下面统一断言 */ }
  check('未配对请求触发确认窗', page !== null, 'confirm.html target 未出现');

  if (page) {
    // 待确认请求落 chrome.storage.session（§7 要点 3：SW 回收不丢）
    const pending = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pendingPairs()))()'));
    check('待确认请求落 chrome.storage.session',
      pending.length === 1 && pending[0].name.startsWith('vipper-cli@') && /^[0-9a-f]{64}$/.test(pending[0].fingerprint),
      pending);
    firstFingerprint = pending[0]?.fingerprint ?? '';

    // 窗内展示：名称/exe 路径/PID/指纹（§5.1 步骤 3；exe/PID 来自 host /proc 校验）。
    // 倒计时文本由 1s interval 首次触发后才渲染，先等一拍。
    // （沙箱内 PID namespace 隔离，host 读 /proc 会解析到 chromium 路径，exe 仅断言非空——
    //   进程属性本来就只是展示辅助，不作安全锚点，§5.3）
    await sleep(1200);
    const shown = await page(`JSON.stringify({
      name: document.getElementById('f-name').textContent,
      exe: document.getElementById('f-exe').textContent,
      pid: document.getElementById('f-pid').textContent,
      fp: document.getElementById('f-fp').textContent,
      countdown: document.getElementById('countdown').textContent,
    })`).then(JSON.parse);
    check('确认窗展示名称/路径/PID/指纹',
      shown.name.startsWith('vipper-cli@') && shown.exe.length > 0 && shown.exe !== '未知' && /^\d+$/.test(shown.pid)
      && shown.fp.startsWith(firstFingerprint.slice(0, 16)) && /自动拒绝/.test(shown.countdown),
      shown);

    await page(`document.getElementById('btn-allow').click()`);
  }
  const res = await cli.done;
  check('允许后加密 ping 回显成功（通道可用）',
    res.code === 0 && res.out.includes('secure-pong') && res.out.includes('m41-加密通道'),
    res);

  // 配对存储（chrome.storage.local）：指纹 → 名称/公钥/配对时间
  const clients = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pairedClients()))()'));
  const mine = clients[firstFingerprint];
  check('配对存储落 chrome.storage.local',
    !!mine && mine.name.startsWith('vipper-cli@') && typeof mine.identityPub === 'string' && mine.pairedAt > 0,
    clients);

  // 私钥文件 0600（§5.1 步骤 1）
  check('客户端私钥文件 0600',
    existsSync(CLIENT_KEY) && (statSync(CLIENT_KEY).mode & 0o777) === 0o600,
    (statSync(CLIENT_KEY).mode & 0o777).toString(8));

  // 篡改密文：拿真实 session 伪造一条（密钥不对 → 解密失败 → unpaired）
  const tampered = await rawRequest({
    v: 1, id: 'm41-tampered', session: 'm41-tampered-session',
    $enc: 'v1', iv: Buffer.alloc(12, 1).toString('base64'), data: Buffer.alloc(48, 2).toString('base64'),
  });
  check('篡改/伪造密文 → unpaired（不区分失败原因）',
    tampered.type === 'error' && tampered.error?.code === 'unpaired', tampered);
}

// ---- 3. 身份复用：同私钥再连不再弹窗（§5.3 身份不变） ----
{
  const cli = runCli(['sping', 'm41-身份复用']);
  const res = await cli.done;
  check('已配对身份再连直接成功', res.code === 0 && res.out.includes('m41-身份复用'), res);
  await sleep(1000);
  check('身份复用不再弹确认窗', !hasPage('confirm.html'), '出现了 confirm.html');
}

// ---- 4. 拒绝路径：确认窗点「拒绝」→ cli pair_denied ----
{
  await sw(`chrome.storage.local.remove('socket.clients')`); // 撤销配对（M43 管理页按钮的底层语义）
  const cli = runCli(['sping', 'm41-应被拒绝']);
  let page = null;
  try {
    page = await attachPage('confirm.html');
  } catch { /* 统一断言 */ }
  check('撤销配对后重连再次弹确认窗', page !== null, 'confirm.html target 未出现');
  if (page) await page(`document.getElementById('btn-deny').click()`);
  const res = await cli.done;
  check('拒绝后 cli 收到 pair_denied 退出非 0',
    res.code !== 0 && res.err.includes('拒绝'),
    res);
  const clients = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pairedClients()))()'));
  check('拒绝不留下配对记录', Object.keys(clients).length === 0, clients);
}

// ---- 5. 删私钥文件需重新配对（§5.3） ----
{
  // 先恢复一条配对（旧身份），再删私钥 → 新身份必须重新走确认窗
  const reCli = runCli(['pair']);
  const rePage = await attachPage('confirm.html');
  await rePage(`document.getElementById('btn-allow').click()`);
  await reCli.done;

  rmSync(CLIENT_KEY, { force: true });
  const cli = runCli(['sping', 'm41-新身份']);
  let page = null;
  try {
    page = await attachPage('confirm.html');
  } catch { /* 统一断言 */ }
  check('删私钥文件后确认窗再次出现（需重新配对）', page !== null, 'confirm.html target 未出现');
  if (page) {
    const pending = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pendingPairs()))()'));
    check('新身份指纹与旧身份不同',
      pending.length === 1 && pending[0].fingerprint !== firstFingerprint && /^[0-9a-f]{64}$/.test(pending[0].fingerprint),
      { pending, firstFingerprint });
    await page(`document.getElementById('btn-allow').click()`);
  }
  const res = await cli.done;
  check('新身份允许后通道恢复可用', res.code === 0 && res.out.includes('m41-新身份'), res);
  const clients = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.socket.pairedClients()))()'));
  check('配对存储含旧+新两条身份记录', Object.keys(clients).length === 2, Object.keys(clients));
}

clearInterval(keepAlive);
summary();
close();
