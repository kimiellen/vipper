/**
 * M43 自动化验收：cli 四模式 + 审计日志 + 管理页两小节（socket-access.md §8/§9/§13）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3）；
 * 环境约定同 m41/m42（HOME 指进沙箱，XDG_RUNTIME_DIR 由 verify-all 注入）。
 *
 * 断言：
 * - `vipper-cli get`：成功把明文写 stdout（密码命令模式 2 的消费面）；⛔ 条目失败且 stdout 为空
 * - fd 模式（模式 3）：`<(vipper-cli get x)` 进程替换读出的内容正确
 * - git 实战（模式 2）：`git credential fill` 经 credential.helper 调 vipper-cli get 拿到密钥
 * - `vipper-cli run -e VAR=path -- cmd`（模式 4）：密钥进子进程 env；任一 get 失败则不启动子进程
 * - 审计（§8）：granted / denied / locked / not_found / bad_request 各留痕，字段齐全；
 *   锁库保留审计；滚动上限生效（可配，默认 1000）
 * - 管理页（§7）：已配对客户端列表渲染、重命名落盘、撤销删除身份并清空其令牌；审计日志小节可回放
 *
 * msmtp 不在沙箱内，其 `passwordeval "vipper-cli get …"` 的消费语义与 git helper 相同
 * （执行命令、读 stdout 第一行），git 实战已覆盖同一路径。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';
import { socketPath } from '../packages/vipper-protocol/paths.js';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const CLI = `${FAKE_HOME}/.local/lib/vipper/packages/vipper-cli/bin/vipper-cli.js`;
const CLIENT_KEY = `${FAKE_HOME}/.config/vipper/client-key`;

const { sw, attachPage, hasPage, close } = await connectSW();
const { check, summary } = createChecker();

// SW 30s 空闲会被回收（native 端口随之中断）：验收期间每 10s 一次 eval 保活
const keepAlive = setInterval(() => { sw('__vipper.socket.status().connected').catch(() => {}); }, 10_000);

/** 跑安装后的 cli，HOME 指进沙箱（身份文件与 host 安装都落在沙箱里） */
function runCli(args, { input } = {}) {
  const child = spawn('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  if (input) child.stdin.end(input);
  return { child, done: new Promise((r) => child.on('close', (code) => r({ code, out, err }))) };
}

/** 同步跑一条 shell 命令（fd 模式 / git 实战），HOME 指进沙箱 */
function sh(cmd, { input } = {}) {
  const res = spawnSync('bash', ['-c', cmd], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    encoding: 'utf8',
    input,
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** 读审计（flush 后取，避免 fire-and-forget 未落盘） */
async function audit() {
  return JSON.parse(await sw(`(async () => JSON.stringify(await __vipper.socket.audit()))()`));
}

async function clearAudit() {
  await sw(`chrome.storage.local.remove('socket.audit')`);
}

// ---- 0. 安装 latest host/cli + 链路就绪 + vault 解锁 + 配对 ----
{
  const inst = spawnSync('bash', ['scripts/install-host.sh'], {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
    encoding: 'utf8',
  });
  check('install-host.sh 安装成功（含 M43 cli get/run）', inst.status === 0, inst.stderr || inst.stdout);

  await sw(`chrome.storage.local.remove(['socket.clients', 'socket.audit'])`);
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
    await sw(`__vipper.keychain.setupMasterPassword('m43-test')`);
  }
  check('vault 解锁', (await sw(`__vipper.keychain.unlock('m43-test')`)) === true);
}

// ---- 1. 配对（复用 M41 链路） ----
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

// ---- 2. 准备条目：✅ 白名单（可读）/ ⛔ 缺省 / 🔔 ----
let ids = {};
{
  ids = JSON.parse(await sw(`(async () => {
    const mk = (title, records) => __vipper.vault.addBookmark({
      title, urls: [{ url: 'https://m43.example', match: 'host' }], records,
    });
    const git = await mk('m43-git', [{ template: 'secret', name: 'token', content: 'GIT-SECRET-42',
      socketExposure: { mode: 'allowed', clients: ['${fp}'] } }]);
    const off = await mk('m43-off', [{ template: 'secret', name: 'api', content: 'OFF-SECRET' }]);
    const ask = await mk('m43-ask', [{ template: 'secret', name: 'api', content: 'ASK-SECRET',
      socketExposure: { mode: 'ask', clients: [] } }]);
    return JSON.stringify({ git: git.id, off: off.id, ask: ask.id });
  })()`));
  check('条目准备完成', Object.keys(ids).length === 3, ids);
}

// ---- 3. vipper-cli get：成功写 stdout（模式 2 的消费面） ----
{
  const res = await runCli(['get', 'm43-git/token']).done;
  check('vipper-cli get → stdout 明文，退出 0，stderr 空',
    res.code === 0 && res.out.trim() === 'GIT-SECRET-42' && res.err === '', res);
}

// ---- 4. vipper-cli get：⛔ 条目失败且不泄露内容 ----
{
  const res = await runCli(['get', 'm43-off/api']).done;
  check('vipper-cli get ⛔ 条目 → 退出非 0 且 stdout 为空',
    res.code !== 0 && res.out === '', res);
}

// ---- 5. fd 模式（模式 3）：进程替换 <(vipper-cli get x) ----
{
  const { code, out, err } = sh(`cat <(node '${CLI}' get m43-git/token)`);
  check('fd 模式：进程替换读出的内容正确', code === 0 && out.trim() === 'GIT-SECRET-42', { code, out, err });
}

// ---- 6. git 实战（模式 2）：credential.helper 调 vipper-cli get ----
{
  const helper = `!f() { echo username=vipper; echo "password=$(node '${CLI}' get m43-git/token)"; }; f`;
  const { code, out, err } = sh(
    `git -c credential.helper= -c credential.helper='${helper}' credential fill`,
    { input: 'protocol=https\nhost=github.com\n\n' },
  );
  check('git credential fill 经 vipper-cli 拿到密钥',
    code === 0 && out.includes('password=GIT-SECRET-42'), { code, out, err });
}

// ---- 7. vipper-cli run（模式 4）：env 注入 ----
{
  const ok = await runCli([
    'run', '-e', 'TOKEN=m43-git/token', '--', 'node', '-e',
    'process.stdout.write(process.env.TOKEN ?? "MISSING")',
  ]).done;
  check('vipper-cli run 注入子进程 env 并可读', ok.code === 0 && ok.out === 'GIT-SECRET-42', ok);

  const bad = await runCli([
    'run', '-e', 'TOKEN=m43-off/api', '--', 'node', '-e', 'console.log("SHOULD-NOT-RUN")',
  ]).done;
  check('run 取密钥失败 → 整体失败且不启动子进程',
    bad.code !== 0 && !bad.out.includes('SHOULD-NOT-RUN'), bad);

  const usage = await runCli(['run', '--', 'true']).done;
  check('run 缺少 -e 时打印用法并以 2 退出', usage.code === 2 && /用法/.test(usage.err), usage);
}

// ---- 8. 审计：granted / not_found / bad_request / locked / denied 留痕 ----
{
  await clearAudit();
  await runCli(['get', 'm43-git/token']).done; // granted
  await runCli(['get', 'm43-off/api']).done;   // not_found
  await runCli(['get', 'noslash']).done;       // bad_request
  await sleep(200);
  const list = await audit();
  const byResult = (r) => list.filter((e) => e.result === r);
  const granted = byResult('granted');
  check('审计：granted 留痕且字段齐全（指纹/名字/路径/结果/时间）',
    granted.length === 1 && granted[0].fingerprint === fp
    && granted[0].clientName.startsWith('vipper-cli@')
    && granted[0].path === 'm43-git/token' && typeof granted[0].at === 'number', granted);
  check('审计：not_found 留痕', byResult('not_found').length === 1, list);
  check('审计：bad_request 留痕', byResult('bad_request').length === 1, list);

  // 锁库：locked 记一条，且审计本身不被锁库清掉（§6.4/§8）
  await sw('__vipper.keychain.lock()');
  await runCli(['get', 'm43-git/token']).done;
  await sleep(200);
  const lockedList = await audit();
  check('审计：locked 留痕且锁库不清审计',
    lockedList.some((e) => e.result === 'locked')
    && lockedList.some((e) => e.result === 'granted'), lockedList);
  await sw(`__vipper.keychain.unlock('m43-test')`);

  // 🔔 拒绝 → denied
  await clearAudit();
  const req = runCli(['get', 'm43-ask/api']);
  const page = await attachPage('confirm.html');
  await page(`document.getElementById('a-btn-deny').click()`);
  const res = await req.done;
  check('🔔 拒绝后 cli 退出非 0', res.code !== 0 && res.out === '', res);
  await sleep(200);
  const denied = (await audit()).filter((e) => e.result === 'denied');
  check('审计：denied 留痕', denied.length === 1, denied);
}

// ---- 9. 审计滚动上限（可配）：设 5 后连发 6 条，最旧被挤出 ----
{
  await sw(`(async () => {
    const s = (await chrome.storage.local.get('meta:settings'))['meta:settings'] ?? {};
    await chrome.storage.local.set({ 'meta:settings': { ...s, socketAuditMax: 5 } });
  })()`);
  await clearAudit();
  for (const n of [1, 2, 3, 4, 5, 6]) await runCli(['get', `m43-off/a${n}`]).done;
  await sleep(300);
  const list = await audit();
  const paths = list.map((e) => e.path);
  check('审计滚动：上限 5 生效，保留最新 5 条（a2–a6），最旧 a1 被挤出',
    list.length === 5 && !paths.includes('m43-off/a1') && paths.includes('m43-off/a6'), paths);

  // 恢复默认上限并验证默认值 1000（§8）
  await sw(`(async () => {
    const s = (await chrome.storage.local.get('meta:settings'))['meta:settings'] ?? {};
    delete s.socketAuditMax;
    await chrome.storage.local.set({ 'meta:settings': s });
  })()`);
  const settings = JSON.parse(await sw('(async () => JSON.stringify(await __vipper.keychain.getSettings()))()'));
  check('审计上限默认 1000 条', settings.socketAuditMax === 1000, settings.socketAuditMax);
}

// ---- 10. 管理页：审计日志可回放 + 已配对客户端（渲染 / 重命名 / 撤销清令牌） ----
{
  // 先断言审计（此前的 get 都已结案，页面渲染与当前审计一致；后续客户端操作会新增审计，不再断言审计）
  await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
  const page = await attachPage('wui.html');
  for (let i = 0; i < 20; i++) {
    if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
    await sleep(250);
  }
  await page(`document.querySelector('.set-group-audit .set-head').click()`);
  await sleep(300);
  const auditRows = JSON.parse(await page(`JSON.stringify(
    [...document.querySelectorAll('#settings-audit-list .rlist-row')].map((r) => r.textContent)
  )`));
  const newest = (await audit()).at(-1);
  check('管理页：审计日志渲染（行数 > 0，含路径与结果）',
    auditRows.length === 5 && auditRows.join('\n').includes('m43-off/a6') && auditRows.join('\n').includes('not_found'),
    auditRows.slice(0, 3));
  check('管理页：审计最新一条在最前（倒序回放）', !!newest && auditRows[0].includes(newest.path),
    { newest: newest?.path, first: auditRows[0] });

  // 已配对客户端小节
  await page(`document.querySelector('.set-group-clients .set-head').click()`);
  await sleep(300);
  const clientRows = JSON.parse(await page(`JSON.stringify(
    [...document.querySelectorAll('#settings-client-list .rlist-row')].map((r) => r.textContent)
  )`));
  check('管理页：已配对客户端列表渲染（名字 + 指纹 + 配对时间）',
    clientRows.length === 1 && clientRows[0].includes('vipper-cli@') && clientRows[0].includes(fp.slice(0, 12)), clientRows);

  // 重命名
  await page(`document.querySelector('#settings-client-list .rlist-actions button').click()`);
  await sleep(200);
  await page(`(() => {
    const input = document.querySelector('#settings-client-list .rlist-row input');
    input.value = 'm43-renamed';
    document.querySelector('#settings-client-list .rlist-row .btn').click();
  })()`);
  await sleep(400);
  const renamed = JSON.parse(await sw(`(async () => JSON.stringify(await __vipper.socket.pairedClients()))()`));
  check('管理页：重命名落盘到 socket.clients', renamed[fp]?.name === 'm43-renamed', renamed[fp]);
  const renamedRow = await page(`document.querySelector('#settings-client-list .rlist-row').textContent`);
  check('管理页：重命名后列表刷新显示新名字', renamedRow.includes('m43-renamed'), renamedRow);

  // 先发一次 allowed get 确保有令牌，再撤销 → 身份删除 + 令牌清空
  await runCli(['get', 'm43-git/token']).done;
  const tokensBefore = JSON.parse(await sw(
    `(async () => JSON.stringify(Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('socket.token.'))))()`,
  ));
  check('撤销前该客户端有令牌', tokensBefore.some((k) => k.includes(fp)), tokensBefore);
  await page(`document.querySelector('#settings-client-list .rlist-actions button:last-child').click()`);
  await sleep(300);
  const dialogShown = await page(`!document.getElementById('confirm-overlay').hidden`);
  check('撤销弹危险操作二次确认', dialogShown === true);
  await page(`document.getElementById('confirm-ok').click()`);
  await sleep(500);
  const after = JSON.parse(await sw(`(async () => JSON.stringify(await __vipper.socket.pairedClients()))()`));
  const tokensAfter = JSON.parse(await sw(
    `(async () => JSON.stringify(Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('socket.token.'))))()`,
  ));
  check('撤销后身份删除', !after[fp], after);
  check('撤销后该客户端令牌清空', !tokensAfter.some((k) => k.includes(fp)), tokensAfter);
  const emptyRow = await page(`document.querySelector('#settings-client-list').textContent`);
  check('撤销后列表显示空态', /暂无已配对客户端|no paired clients/.test(emptyRow), emptyRow);
  await page(`window.close()`);
}

clearInterval(keepAlive);
summary();
close();
