#!/usr/bin/env node
/**
 * 里程碑验收运行器：分级验证 + 并行执行 + 耗时统计。
 *
 * 用法：
 *   node scripts/verify-all.mjs                      # 全量（L2），串行
 *   node scripts/verify-all.mjs m26 m27              # 指定里程碑
 *   node scripts/verify-all.mjs --affected           # 按 git 改动推断受影响里程碑（L1）
 *   node scripts/verify-all.mjs --affected --base origin/main
 *   node scripts/verify-all.mjs --changed a.ts,b.ts  # 用指定文件预演受影响集合（调试）
 *   node scripts/verify-all.mjs --jobs 4             # 并行 worker 数（默认 1）
 *   node scripts/verify-all.mjs --timeout 60         # 单脚本超时秒数（默认 60）
 *   node scripts/verify-all.mjs --list               # 只打印将要执行的里程碑，不执行
 *   node scripts/verify-all.mjs --json               # 机器可读 JSON 输出
 *
 * 设计：
 * - 每个 worker 独占端口（9333 + worker 序号）、独立 Chromium 进程组与独立 profile；
 *   验收脚本通过环境变量 `VIPPER_CDP_PORT` 连接（`scripts/lib/sw-driver.mjs` 默认读取）。
 * - 每个脚本独立硬超时；超时/启动失败只影响该里程碑。
 * - 收尾保证：杀进程组、等端口释放、删 profile；Ctrl-C 会清理所有 worker。
 * - 改动 → 里程碑的映射见 `scripts/verify-map.json`；匹配不到或影响面过大时保守退回全量。
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE_HOME = resolve(ROOT, '.fake-home');
const EXT = resolve(ROOT, '.output/chrome-mv3');
const BASE_PORT = 9333;
const DEFAULT_TIMEOUT_S = 60;
const CDP_READY_TIMEOUT_MS = 30_000;

/** 特殊启动参数的脚本；其余用标准扩展加载回路 */
const SPECIAL = {
  m16: ['--enable-unsafe-extension-debugging'], // 不预加载扩展，脚本内 loadUnpacked
};

const MAP = JSON.parse(readFileSync(resolve(import.meta.dirname, 'verify-map.json'), 'utf8'));
const ALL = MAP.all;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = { milestones: [], affected: false, files: null, base: 'HEAD', jobs: 1, timeoutS: DEFAULT_TIMEOUT_S, json: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--affected') opts.affected = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--jobs') opts.jobs = parsePositiveInt(argv[++i], '--jobs');
    else if (a === '--timeout') opts.timeoutS = parsePositiveInt(argv[++i], '--timeout');
    else if (a === '--base') opts.base = argv[++i] ?? opts.base;
    else if (a === '--changed') opts.files = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    } else opts.milestones.push(a);
  }
  return opts;
}

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${flag} 需要正整数，收到: ${value}`);
    process.exit(2);
  }
  return n;
}

// ---------- 改动 → 里程碑 ----------

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const PATTERNS = MAP.patterns.map((p) => ({ ...p, re: globToRegExp(p.glob) }));

function gitChangedFiles(base) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  return [...new Set([...run(['diff', '--name-only', base]), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

function milestoneFromScript(file) {
  const m = file.match(/scripts\/(m[0-9]+[a-z]?)-verify\.mjs$/);
  return m ? m[1] : null;
}

/** @returns {{targets: string[], reasons: string[], fallback: string|null}} */
function resolveAffected(files) {
  if (!files.length) return { targets: [], reasons: ['工作区无改动'], fallback: null };
  const picked = new Set();
  const reasons = [];
  let fallback = null;
  for (const file of files) {
    const rule = PATTERNS.find((p) => p.re.test(file));
    if (!rule) {
      fallback = `未匹配规则: ${file}`;
      break;
    }
    if (rule.milestones === 'full') {
      fallback = `影响全量: ${file}`;
      break;
    }
    const list = rule.milestones === '$script' ? [milestoneFromScript(file)].filter(Boolean) : rule.milestones;
    if (!list.length) {
      reasons.push(`${file} → 无 e2e 影响（${rule.glob}）`);
      continue;
    }
    reasons.push(`${file} → ${list.join(',')}`);
    for (const m of list) picked.add(m);
  }
  if (fallback) return { targets: [...ALL], reasons, fallback };
  const ordered = ALL.filter((m) => picked.has(m));
  if (ordered.length > MAP.maxAffected) {
    return { targets: [...ALL], reasons, fallback: `受影响里程碑 ${ordered.length} 个 > 上限 ${MAP.maxAffected}` };
  }
  return { targets: ordered, reasons, fallback: null };
}

// ---------- CDP / 浏览器 ----------

const cdpUp = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch {
    return false;
  }
};

async function waitCdp(port, up, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await cdpUp(port)) === up) return true;
    await sleep(200);
  }
  return false;
}

const browsers = new Set();
const scripts = new Set();

function killGroup(proc, signal = 'SIGTERM') {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    /* 已退出 */
  }
}

function launch(milestone, port) {
  mkdirSync(FAKE_HOME, { recursive: true });
  const special = SPECIAL[milestone];
  const args = [
    '--headless=new',
    // 每个里程碑独立 profile：避免上一个浏览器的残留状态/锁文件干扰
    `--user-data-dir=${resolve(ROOT, `.chrome-test-profile-${milestone}`)}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(special ?? [`--load-extension=${EXT}`]),
    'about:blank',
  ];
  const proc = spawn('chromium', args, {
    cwd: ROOT,
    env: { ...process.env, HOME: FAKE_HOME },
    stdio: 'ignore',
    detached: true,
  });
  browsers.add(proc);
  proc.once('exit', () => browsers.delete(proc));
  return proc;
}

/** 等进程组真正退出（SIGTERM → 3s 后 SIGKILL），最多等 6s */
function stop(proc) {
  return new Promise((r) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return r();
    let done = false;
    let killTimer = null;
    let doneTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(doneTimer);
      r();
    };
    proc.once('exit', finish);
    killGroup(proc, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(proc, 'SIGKILL'), 3000);
    doneTimer = setTimeout(finish, 6000);
  });
}

/** 清空旧浏览器：任何残留监听者都先等它消失，再起新进程 */
async function ensurePortFree(port, timeout = 15_000) {
  if (!(await cdpUp(port))) return true;
  return waitCdp(port, false, timeout);
}

// ---------- 执行一个里程碑 ----------

function runScript(milestone, port, timeoutS) {
  return new Promise((r) => {
    const proc = spawn('node', [`scripts/${milestone}-verify.mjs`], {
      cwd: ROOT,
      env: { ...process.env, VIPPER_CDP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    scripts.add(proc);
    let out = '';
    let settled = false;
    const started = Date.now();
    let timer = null;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scripts.delete(proc);
      r({ code, out, ms: Date.now() - started, timedOut });
    };
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => finish(code ?? 1));
    timer = setTimeout(() => {
      if (settled) return;
      proc.kill('SIGKILL');
      out += `\n[verify-all] 超时 ${timeoutS}s，已终止`;
      finish(1, true);
    }, timeoutS * 1000);
  });
}

async function runOne(milestone, port, timeoutS) {
  const t0 = Date.now();
  const profile = resolve(ROOT, `.chrome-test-profile-${milestone}`);
  rmSync(profile, { recursive: true, force: true });
  if (!(await ensurePortFree(port))) {
    return { milestone, code: 1, ms: Date.now() - t0, tail: `端口 ${port} 被残留浏览器占用且 15s 内未释放`, out: '', timedOut: false };
  }
  const br = launch(milestone, port);
  let res;
  try {
    if (!(await waitCdp(port, true, CDP_READY_TIMEOUT_MS))) {
      res = { code: 1, out: `Chromium 未在 ${CDP_READY_TIMEOUT_MS / 1000}s 内就绪（端口 ${port}）`, ms: Date.now() - t0, timedOut: false };
    } else {
      res = await runScript(milestone, port, timeoutS);
    }
  } finally {
    await stop(br);
    await waitCdp(port, false, 15_000);
    rmSync(profile, { recursive: true, force: true });
  }
  const lines = res.out.trim().split('\n').filter(Boolean);
  const tail = res.code === 0
    ? (lines.filter((l) => /通过|FAIL/.test(l)).at(-1) ?? lines.at(-1) ?? '')
    : (lines.at(-1) ?? '');
  return { milestone, code: res.code, ms: res.ms, tail, out: res.out, timedOut: !!res.timedOut };
}

// ---------- 主流程 ----------

const opts = parseArgs(process.argv.slice(2));

let targets;
let reasons = [];
let fallback = null;
if (opts.affected || opts.files) {
  const files = opts.files ?? gitChangedFiles(opts.base);
  const resolved = resolveAffected(files);
  targets = resolved.targets;
  reasons = resolved.reasons;
  fallback = resolved.fallback;
} else if (opts.milestones.length) {
  targets = [];
  for (const m of opts.milestones) {
    for (const one of m.split(',')) {
      if (!ALL.includes(one)) {
        console.error(`未知里程碑: ${one}（可选: ${ALL.join(' ')}）`);
        process.exit(2);
      }
      if (!targets.includes(one)) targets.push(one);
    }
  }
} else {
  targets = [...ALL];
}

if (opts.affected || opts.files) {
  if (!opts.json) {
    for (const r of reasons) console.log(`  ${r}`);
    if (fallback) console.log(`  回退全量：${fallback}`);
    if (!targets.length) console.log('  结论：无 e2e 受影响（文档/工具脚本改动），只需 typecheck + build');
  }
  if (opts.list) {
    console.log(targets.length ? `将执行: ${targets.join(' ')}` : '将执行: （无）');
    process.exit(0);
  }
  if (!targets.length) {
    if (opts.json) console.log(JSON.stringify({ targets: [], reasons, fallback, passed: 0, failed: 0, totalMs: 0, results: [] }, null, 2));
    process.exit(0);
  }
}

const jobs = Math.min(opts.jobs, targets.length);
if (!opts.json) console.log(`verifying ${targets.length} 个里程碑（jobs=${jobs}, timeout=${opts.timeoutS}s）: ${targets.join(' ')}\n`);
if (opts.list) {
  console.log(targets.join(' '));
  process.exit(0);
}

const results = [];
const byWorker = Array.from({ length: jobs }, () => []);
targets.forEach((m, i) => byWorker[i % jobs].push(m));

const startedAll = Date.now();

async function worker(slot, queue) {
  for (const milestone of queue) {
    const r = await runOne(milestone, BASE_PORT + slot, opts.timeoutS);
    results.push(r);
    if (!opts.json) {
      console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${milestone}-verify  ${r.tail}  ${(r.ms / 1000).toFixed(1)}s`);
      if (r.code !== 0) console.log(r.out.trim().split('\n').slice(-20).join('\n'));
    }
  }
}

const stopAll = (signal) => {
  for (const p of scripts) { try { p.kill('SIGKILL'); } catch { /* noop */ } }
  for (const b of browsers) killGroup(b, 'SIGKILL');
  process.exit(signal === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', () => stopAll('SIGINT'));
process.once('SIGTERM', () => stopAll('SIGTERM'));

await Promise.all(byWorker.map((queue, slot) => worker(slot, queue)));

const totalMs = Date.now() - startedAll;
const ordered = targets.map((m) => results.find((r) => r.milestone === m)).filter(Boolean);
const failed = ordered.filter((r) => r.code !== 0);

if (opts.json) {
  console.log(JSON.stringify({
    jobs,
    targets,
    totalMs,
    passed: ordered.length - failed.length,
    failed: failed.length,
    results: ordered.map((r) => ({ milestone: r.milestone, code: r.code, ms: r.ms, timedOut: r.timedOut, tail: r.tail })),
  }, null, 2));
} else {
  const slowest = [...ordered].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.milestone} ${(r.ms / 1000).toFixed(1)}s`);
  console.log(`\n${ordered.length - failed.length}/${ordered.length} 个里程碑脚本通过，总耗时 ${(totalMs / 1000).toFixed(1)}s（jobs=${jobs}）`);
  if (slowest.length) console.log(`最慢: ${slowest.join(' / ')}`);
  if (failed.length) console.log(`失败: ${failed.map((f) => f.milestone).join(', ')}`);
}
process.exitCode = failed.length ? 1 : 0;
