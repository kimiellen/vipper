#!/usr/bin/env node
/**
 * 全量回归运行器：逐个里程碑验收脚本，每个脚本都用全新的 Chromium profile 跑一遍。
 *
 * 用法：
 *   node scripts/verify-all.mjs            # 全部 m*-verify
 *   node scripts/verify-all.mjs m26 m27    # 只跑指定里程碑
 *
 * 前置：`pnpm build` 已产出 .output/chrome-mv3；`chromium` 在 PATH 中（见 AGENTS.md）。
 * m16 例外：启动时不加载扩展，脚本内用 CDP Extensions.loadUnpacked 动态加载。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const EXT = resolve(ROOT, '.output/chrome-mv3');
const SCRIPT_TIMEOUT_MS = 180_000;

/** 特殊启动参数的脚本；其余用标准扩展加载回路 */
const SPECIAL = {
  m16: ['--enable-unsafe-extension-debugging'], // 不预加载扩展，脚本内 loadUnpacked
};

const ALL = [
  'm1', 'm2', 'm4', 'm5', 'm8', 'm9b', 'm9c', 'm9d', 'm9e', 'm10', 'm11', 'm12', 'm13',
  'm16', 'm17', 'm19', 'm21', 'm22', 'm23', 'm24', 'm26', 'm27', 'm28', 'm29', 'm30', 'm31',
];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdpUp = async () => {
  try {
    return (await fetch('http://127.0.0.1:9333/json/version')).ok;
  } catch {
    return false;
  }
};

async function waitCdp(up, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await cdpUp()) === up) return true;
    await sleep(200);
  }
  return false;
}

function launch(milestone) {
  mkdirSync(FAKE_HOME, { recursive: true });
  const special = SPECIAL[milestone];
  const args = [
    '--headless=new',
    // 每个里程碑独立 profile：避免上一个浏览器的残留状态/锁文件干扰
    `--user-data-dir=${resolve(ROOT, `.chrome-test-profile-${milestone}`)}`,
    '--remote-debugging-port=9333',
    '--no-first-run',
    '--no-default-browser-check',
    ...(special ?? [`--load-extension=${EXT}`]),
    'about:blank',
  ];
  return spawn('chromium', args, {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
    stdio: 'ignore',
    detached: true, // 独立进程组：kill 时连 zygote/renderer 一起回收，避免跨批次残留
  });
}

/** 等进程组真正退出（SIGTERM → 3s 后 SIGKILL），最多等 6s */
function stop(proc) {
  return new Promise((r) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return r();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      r();
    };
    proc.once('exit', finish);
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* 已退出 */ }
    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }, 3000);
    setTimeout(finish, 6000);
  });
}

/** 脚本硬超时：eval 遇到已销毁的 target 会永不返回，不能让运行器无限挂起 */
function runScript(milestone) {
  return new Promise((r) => {
    const proc = spawn('node', [`scripts/${milestone}-verify.mjs`], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      r({ code, out });
    };
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => finish(code ?? 1));
    setTimeout(() => {
      if (settled) return;
      proc.kill('SIGKILL');
      out += `\n[verify-all] 超时 ${SCRIPT_TIMEOUT_MS}ms，已终止`;
      finish(1);
    }, SCRIPT_TIMEOUT_MS);
  });
}

/** 清空旧浏览器：任何 9333 监听者残留都先等它消失，再起新进程 */
async function ensurePortFree(timeout = 15_000) {
  if (!(await cdpUp())) return true;
  return waitCdp(false, timeout);
}

const results = [];
for (const milestone of targets) {
  const profile = resolve(ROOT, `.chrome-test-profile-${milestone}`);
  rmSync(profile, { recursive: true, force: true });
  const portFree = await ensurePortFree();
  let res;
  if (!portFree) {
    res = { code: 1, out: '9333 端口被残留浏览器占用且 15s 内未释放' };
  } else {
    const br = launch(milestone);
    const ok = await waitCdp(true);
    res = ok ? await runScript(milestone) : { code: 1, out: 'Chromium 未在 15s 内就绪（9333）' };
    await stop(br);
    await waitCdp(false, 10_000);
  }
  rmSync(profile, { recursive: true, force: true });
  const line = res.out.trim().split('\n').filter(Boolean).at(-1) ?? '';
  const tail = res.out.includes('通过')
    ? res.out.trim().split('\n').filter((l) => /通过|FAIL/.test(l)).slice(-2).join(' | ')
    : line;
  results.push({ milestone, code: res.code, tail, out: res.out });
  console.log(`${res.code === 0 ? 'PASS' : 'FAIL'}  ${milestone}-verify  ${tail}`);
  if (res.code !== 0) {
    console.log(res.out.trim().split('\n').slice(-15).join('\n'));
  }
  await sleep(300);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} 个里程碑脚本通过`);
if (failed.length) console.log('失败:', failed.map((f) => f.milestone).join(', '));
process.exitCode = failed.length ? 1 : 0;
