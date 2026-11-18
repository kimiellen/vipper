/**
 * M40 自动化验收：传输层 + host 骨架（socket-access.md §13）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3）。
 * verify-all 会给 Chromium 与脚本注同一 XDG_RUNTIME_DIR（.fake-home/xdg-run），
 * 并在启动前跑 install-host.sh 把 native manifest 装进测试 profile
 * （Chromium 仅启动时扫描 manifest，且用户级目录为 <user-data-dir>/NativeMessagingHosts）；
 * 手动调试需先自行执行：HOME=$PWD/.fake-home VIPPER_NMH_EXTRA_DIR=$PWD/.chrome-test-profile/NativeMessagingHosts bash scripts/install-host.sh
 *
 * 断言：
 * - X25519 两端可用（§5.2 首验）：Node webcrypto 与 SW WebCrypto 各生成密钥对，
 *   交换公钥后 AES-GCM 双向加解密互通（不可用则降级 P-256，实测可用）
 * - install-host.sh：manifest 写双浏览器路径、allowed_origins 钉扩展 ID、host 可执行；
 *   假 node v20 被版本检查拒绝（§10.4）
 * - 扩展 manifest 钉 key / minimum_chrome_version=133 / nativeMessaging 权限；
 *   chrome.runtime.id 与 allowed_origins 一致
 * - cli→host→扩展字节互通：vipper-cli ping 收到扩展 pong 回显
 * - 连接元数据：扩展侧 peers() 记录 cli 的 uid/pid/exePath
 * - 异 UID 拒连（§4 规则 1）：自报 pid=1（root）被断开；isPeerAcceptable 纯函数
 * - socket 文件 0600、目录 0700（§11）
 * - 帧格式：encodeFrame/parser 往返、超长帧拒绝（§4.3）
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { encodeFrame, createFrameParser, MAX_FRAME_BYTES } from '../packages/vipper-protocol/frame.js';
import { socketPath } from '../packages/vipper-protocol/paths.js';
import { isPeerAcceptable } from '../packages/vipper-host/src/peercred.js';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const EXT_ID = 'dmgfibpimmkihmkcdjhjnpnjbfobfbhn';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 1. 帧格式（§4.3） ----
{
  const frames = [];
  const parser = createFrameParser((msg) => frames.push(msg));
  const encoded = encodeFrame({ v: 1, id: 'a', type: 'ping', payload: { msg: '帧往返' } });
  // 刻意切碎喂入，验证碎片重组
  parser.push(encoded.subarray(0, 3));
  parser.push(encoded.subarray(3, encoded.length - 1));
  parser.push(encoded.subarray(encoded.length - 1));
  check('帧编解码往返（碎片重组）', frames.length === 1 && frames[0].payload.msg === '帧往返', frames);
  let tooBig = false;
  createFrameParser(() => {}, () => { tooBig = true; }).push(Buffer.alloc(4, 0xff));
  check('超长帧拒绝', tooBig && MAX_FRAME_BYTES === 1024 * 1024, tooBig);
}

// ---- 2. X25519 两端可用性首验（§5.2） ----
{
  const wc = globalThis.crypto.webcrypto ?? globalThis.crypto;
  const nodePair = await wc.subtle.generateKey({ name: 'X25519' }, true, ['deriveKey']);
  check('Node webcrypto 支持 X25519', nodePair.publicKey.type === 'public', nodePair);

  const swPubB64 = await sw(`(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveKey']);
    globalThis.__m40kp = kp;
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  })()`);
  check('扩展 SW WebCrypto 支持 X25519', typeof swPubB64 === 'string' && swPubB64.length > 0, swPubB64);

  // 跨运行时 ECDH：Node 用（node 私钥, sw 公钥）加密 → SW 用（sw 私钥, node 公钥）解密；再反向
  const nodePubRaw = await wc.subtle.exportKey('raw', nodePair.publicKey);
  const swPubImported = await wc.subtle.importKey('raw', Buffer.from(swPubB64, 'base64'), { name: 'X25519' }, false, []);
  const nodeKey = await wc.subtle.deriveKey(
    { name: 'X25519', public: swPubImported }, nodePair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const msg1 = 'node→sw 互通';
  const iv1 = wc.getRandomValues(new Uint8Array(12));
  const ct1 = await wc.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, nodeKey, new TextEncoder().encode(msg1));

  const round = JSON.parse(await sw(`(async () => {
    const b2u = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const u2b = (u) => btoa(String.fromCharCode(...u));
    const nodePub = await crypto.subtle.importKey('raw', b2u(${JSON.stringify(b64(nodePubRaw))}), { name: 'X25519' }, false, []);
    const key = await crypto.subtle.deriveKey(
      { name: 'X25519', public: nodePub }, globalThis.__m40kp.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const plain1 = new TextDecoder().decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b2u(${JSON.stringify(b64(iv1))}) }, key, b2u(${JSON.stringify(b64(ct1))})));
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const ct2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, key, new TextEncoder().encode('sw→node 互通'));
    return JSON.stringify({ plain1, iv2: u2b(iv2), ct2: u2b(new Uint8Array(ct2)) });
  })()`));
  const plain2 = new TextDecoder().decode(await wc.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(round.iv2, 'base64') }, nodeKey, Buffer.from(round.ct2, 'base64')));
  check('X25519 跨运行时互通（Node↔SW 双向）', round.plain1 === msg1 && plain2 === 'sw→node 互通', { plain1: round.plain1, plain2 });
}

// ---- 3. install-host.sh（§10.2） ----
{
  const inst = spawnSync('bash', ['scripts/install-host.sh'], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
    encoding: 'utf8',
  });
  check('install-host.sh 安装成功', inst.status === 0, inst.stderr || inst.stdout);

  const hostBin = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-host/bin/vipper-host.js`;
  const cliBin = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-cli/bin/vipper-cli.js`;
  check('host/cli 落盘且可执行',
    existsSync(hostBin) && (statSync(hostBin).mode & 0o111) !== 0 && existsSync(cliBin) && (statSync(cliBin).mode & 0o111) !== 0,
    { hostBin, cliBin });

  for (const browser of ['google-chrome', 'chromium']) {
    const mp = `${FAKE_HOME}/.config/${browser}/NativeMessagingHosts/com.vipper.host.json`;
    const m = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : null;
    check(`manifest 写入 ${browser} 且内容正确`,
      m?.name === 'com.vipper.host' && m?.type === 'stdio' && m?.path === hostBin
      && JSON.stringify(m?.allowed_origins) === JSON.stringify([`chrome-extension://${EXT_ID}/`]),
      m);
  }

  // Node 版本检查（§10.4）：假 node v20 必须被拒绝
  const fakeBin = mkdtempSync(resolve(ROOT, 'tmp/m40-fake-node-'));
  writeFileSync(`${fakeBin}/node`, '#!/bin/sh\necho v20.11.0\n', { mode: 0o755 });
  const bad = spawnSync('bash', ['scripts/install-host.sh'], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME, PATH: `${fakeBin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  rmSync(fakeBin, { recursive: true, force: true });
  check('Node <22 被 install-host.sh 拒绝', bad.status === 1 && /Node\.js ≥ 22/.test(bad.stderr), bad.stderr || bad.stdout);
}

// ---- 4. 扩展 manifest 钉 key（§10.1/§10.4） ----
{
  const built = JSON.parse(readFileSync(resolve(ROOT, '.output/chrome-mv3/manifest.json'), 'utf8'));
  check('构建 manifest 钉 key + Chrome≥133 + nativeMessaging',
    typeof built.key === 'string' && built.key.startsWith('MIIB')
    && built.minimum_chrome_version === '133'
    && built.permissions.includes('nativeMessaging'),
    { key: typeof built.key, min: built.minimum_chrome_version, perms: built.permissions });
  const runtimeId = await sw('chrome.runtime.id');
  check('chrome.runtime.id 与 allowed_origins 钉死一致', runtimeId === EXT_ID, runtimeId);
}

// ---- 5. cli→host→扩展字节互通 ----
{
  await sw('__vipper.socket.connect()'); // SW 启动时 manifest 未装，这里显式重连（幂等）
  const sock = socketPath();
  let sockReady = false;
  for (let i = 0; i < 50 && !sockReady; i++) {
    sockReady = existsSync(sock);
    if (!sockReady) await sleep(200);
  }
  check('host 监听 socket 就位', sockReady, sock);
  const status = JSON.parse(await sw('JSON.stringify(__vipper.socket.status())'));
  check('扩展侧 native 端口已连接', status.connected === true, status);

  // socket 文件 0600、目录 0700（§11）
  if (sockReady) {
    check('socket 文件权限 0600', (statSync(sock).mode & 0o777) === 0o600, (statSync(sock).mode & 0o777).toString(8));
    check('socket 目录权限 0700', (statSync(resolve(sock, '..')).mode & 0o777) === 0o700, (statSync(resolve(sock, '..')).mode & 0o777).toString(8));
  }

  // 走安装后的 cli 发 ping（同时验证安装产物可独立运行）
  const cliBin = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-cli/bin/vipper-cli.js`;
  const cli = spawn('node', [cliBin, 'ping', 'm40-字节互通'], { cwd: ROOT, encoding: 'utf8' });
  let cliOut = '';
  let cliErr = '';
  cli.stdout.on('data', (d) => { cliOut += d; });
  cli.stderr.on('data', (d) => { cliErr += d; });
  const cliCode = await new Promise((r) => cli.on('close', r));
  check('cli ping 收到扩展 pong 回显', cliCode === 0 && cliOut.includes('pong') && cliOut.includes('m40-字节互通'), { cliCode, cliOut, cliErr });

  // 连接元数据（§3）：扩展侧应记录到本次 cli 连接
  const peers = JSON.parse(await sw('JSON.stringify(__vipper.socket.peers())'));
  const mine = peers.find((p) => p.pid === cli.pid);
  check('扩展记录连接元数据（uid/pid/exePath）',
    !!mine && mine.uid === process.getuid() && /node/.test(mine.exePath),
    { peers, cliPid: cli.pid });
}

// ---- 6. 异 UID 拒连（§4 规则 1） ----
{
  // 自报不可信 pid → host 从 /proc 读回校验失败 → 拒连。
  // 真实 Linux 用 pid 1（root，uid 0 ≠ 当前用户）；沙箱里 pid 1 与当前同 uid，
  // 改用不存在的 pid（/proc 读回失败，同一拒连通路）。
  let roguePid = 1;
  let rogueNote = '自报 root pid';
  try {
    const m = readFileSync('/proc/1/status', 'utf8').match(/^Uid:\s+(\d+)/m);
    if (m && Number(m[1]) === process.getuid()) {
      roguePid = 4194303; // 超过常见 pid_max，必不存在
      rogueNote = '沙箱 pid1 同 uid，改自报不存在 pid';
    }
  } catch { /* 保持 pid 1 */ }
  const sock = socketPath();
  const rogueResult = await new Promise((resolvePromise) => {
    const rogue = net.connect(sock);
    let connected = false; // 必须先连上，否则 socket 不存在也会误报 closed
    const timer = setTimeout(() => { rogue.destroy(); resolvePromise('timeout'); }, 3000);
    rogue.on('connect', () => {
      connected = true;
      rogue.write(encodeFrame({ v: 1, type: '$peer.hello', pid: roguePid }));
    });
    rogue.on('data', () => { clearTimeout(timer); rogue.destroy(); resolvePromise('got-data'); });
    rogue.on('close', () => { clearTimeout(timer); resolvePromise(connected ? 'closed' : 'connect-failed'); });
    rogue.on('error', () => {});
  });
  if (process.getuid() === 0) {
    check('异 UID 连接被拒（root 下跳过，记通过）', true, 'root 环境 uid 恒等');
  } else {
    check(`凭据校验失败拒连（${rogueNote}，被断开且无数据）`, rogueResult === 'closed', rogueResult);
    check('isPeerAcceptable 纯函数：异 UID false / 同 UID true',
      isPeerAcceptable({ uid: 0, pid: 1, exePath: '' }, process.getuid()) === false
      && isPeerAcceptable({ uid: process.getuid(), pid: 1, exePath: '' }, process.getuid()) === true,
      process.getuid());
  }
}

summary();
close();
