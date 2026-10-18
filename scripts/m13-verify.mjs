/**
 * M13 自动化验收：Alt+P 填充后的字段弹跳动画（对齐 Bitwarden）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 内嵌 HTTP 服务器提供三个登录测试页（127.0.0.1:8378 /solo /multi /rm），各绑定一条 exact 书签。
 * 页面内预装 MutationObserver 记录字段类名变化，从而捕捉 200ms 动画窗口内的状态。
 *
 * 断言：
 * - 单账号直接填充：用户名字段与密码字段都加 vipper-animated-fill 类
 * - 动画名 vipperfill、时长 200ms、动画中点 transform 放大（scale > 1.1）
 * - 约 200ms 后类被移除（清理不依赖 animationend）
 * - 逐字输入：input 事件产生的值逐步递增，最终等于账号/密码
 * - 弹跳在逐字输入完成后才触发；密码逐字在账号弹跳结束后才开始
 * - 多账号二级菜单选定后同样按逐字→弹跳、账号→密码的顺序执行
 * - prefers-reduced-motion: reduce 时类仍加、animation-name 为 none、无运行中动画、无 transform 放大；每字段仅 1 次 input（跳过逐字）且两字段同时填入
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const FORM = `<!doctype html><html><body>
<input id="u" name="username" type="text" />
<input id="p" name="password" type="password" />
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(FORM);
});
await new Promise((r) => server.listen(8378, '127.0.0.1', r));

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

const key = (k, code, vk) => ({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
const ENTER = key('Enter', 'Enter', 13);
const DOWN = key('ArrowDown', 'ArrowDown', 40);

/** 页面内预装记录器：抓类名增删、动画名/时长/运行实例、动画中点 transform */
const RECORDER = `(() => {
  window.__anim = { inputs: { u: [], p: [] } };
  const read = (el, tag) => {
    const cs = getComputedStyle(el);
    const anims = el.getAnimations();
    return {
      tag,
      t: Math.round(performance.now()),
      cls: el.classList.contains('vipper-animated-fill'),
      animName: cs.animationName,
      duration: anims[0]?.effect.getTiming().duration ?? null,
      transform: cs.transform,
      running: anims.map((a) => a.animationName ?? 'waapi'),
    };
  };
  for (const id of ['u', 'p']) {
    const el = document.getElementById(id);
    const log = (window.__anim[id] = [read(el, 'initial')]);
    el.addEventListener('input', () => window.__anim.inputs[id].push({ t: Math.round(performance.now()), value: el.value }));
    new MutationObserver(() => {
      log.push(read(el, 'class'));
      if (log.length === 2 && el.classList.contains('vipper-animated-fill')) {
        setTimeout(() => log.push(read(el, 'mid')), 100);
      }
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  return true;
})()`;

function scaleOf(transform) {
  if (!transform || transform === 'none') return 1;
  const m = /matrix\(([^)]+)\)/.exec(transform);
  return m ? Number(m[1].split(',')[0]) : 1;
}

function fieldLog(log, id) {
  const entries = log[id];
  const add = entries.find((e) => e.tag === 'class' && e.cls);
  const mid = entries.find((e) => e.tag === 'mid');
  const last = entries.at(-1);
  return { entries, add, mid, last };
}

async function openTab(url) {
  await sw(`(async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(url)}, active: true });
  })()`);
  await sleep(900); // 等页面加载 + content script 注入
}

async function readAnim(urlPart) {
  const page = await attachPage(urlPart);
  return JSON.parse(await page(`JSON.stringify(window.__anim)`));
}

async function readForm(urlPart) {
  const page = await attachPage(urlPart);
  return JSON.parse(await page(`JSON.stringify({ u: document.querySelector('#u')?.value, p: document.querySelector('#p')?.value })`));
}

// ---- 场景数据 ----
await sw(`__vipper.keychain.setupMasterPassword('m13-test')`);
await sw(`(async () => {
  await __vipper.vault.addBookmark({
    title: 'Solo',
    urls: [{ url: 'http://127.0.0.1:8378/solo', match: 'exact' }],
    accounts: [{ username: 'alice', password: 'p1' }],
  });
  await __vipper.vault.addBookmark({
    title: 'Multi',
    urls: [{ url: 'http://127.0.0.1:8378/multi', match: 'exact' }],
    accounts: [
      { username: 'alice', password: 'p1' },
      { username: 'bob', password: 'p2' },
    ],
  });
  await __vipper.vault.addBookmark({
    title: 'ReduceMotion',
    urls: [{ url: 'http://127.0.0.1:8378/rm', match: 'exact' }],
    accounts: [{ username: 'carol', password: 'p3' }],
  });
})()`);

// ---- 1. 单账号直接填充：两个字段都弹跳 ----
await openTab('http://127.0.0.1:8378/solo');
let page = await attachPage('/solo');
await page(RECORDER);
await sw(`__vipper.dispatch('autofill')`);
await sleep(800);

let form = await readForm('/solo');
let log = await readAnim('/solo');
check('单账号填充结果正确', form.u === 'alice' && form.p === 'p1', form);
const soloU = fieldLog(log, 'u');
const soloP = fieldLog(log, 'p');
for (const [id, f] of [['u', soloU], ['p', soloP]]) {
  check(`#${id} 填充后加 vipper-animated-fill 类`, f.add?.cls === true, f.entries);
  check(`#${id} 动画名 vipperfill 且时长 200ms`,
    f.mid?.animName === 'vipperfill' && f.mid?.duration === 200,
    { animName: f.mid?.animName, duration: f.mid?.duration });
  check(`#${id} 动画中点 transform 放大（scale > 1.1）`, scaleOf(f.mid?.transform) > 1.1, f.mid?.transform);
  check(`#${id} 约 200ms 后类被移除`, f.last?.cls === false && (f.last?.t ?? 0) - (f.add?.t ?? 0) >= 180,
    { addT: f.add?.t, lastT: f.last?.t, cls: f.last?.cls });
}
const soloValsU = log.inputs.u.map((e) => e.value);
const soloValsP = log.inputs.p.map((e) => e.value);
check('账号逐字输入：值逐步递增到完整账号',
  soloValsU.length >= 3 && (soloValsU[0]?.length ?? 0) < (soloValsU.at(-1)?.length ?? 0) && soloValsU.at(-1) === 'alice',
  soloValsU);
check('密码逐字输入：值逐步递增到完整密码',
  soloValsP.length >= 2 && new Set(soloValsP).size >= 2 && soloValsP.at(-1) === 'p1',
  soloValsP);
check('账号弹跳在逐字输入完成后触发',
  (soloU.add?.t ?? 0) >= (log.inputs.u.at(-1)?.t ?? Infinity),
  { lastInputAt: log.inputs.u.at(-1)?.t, popAt: soloU.add?.t });
check('密码弹跳在逐字输入完成后触发',
  (soloP.add?.t ?? 0) >= (log.inputs.p.at(-1)?.t ?? Infinity),
  { lastInputAt: log.inputs.p.at(-1)?.t, popAt: soloP.add?.t });
const soloStartGap = (log.inputs.p[0]?.t ?? 0) - (soloU.add?.t ?? 0);
check('密码逐字在账号弹跳结束后开始（≥180ms）', soloStartGap >= 180 && soloStartGap <= 500, soloStartGap);

// ---- 2. 多账号二级菜单选定后同样弹跳 ----
await openTab('http://127.0.0.1:8378/multi');
page = await attachPage('/multi');
await page(RECORDER);
await sw(`__vipper.dispatch('autofill')`);
await sleep(350); // 等候选菜单出现
await page.send('Input.dispatchKeyEvent', DOWN);  // 选第 2 个账号（bob）
await page.send('Input.dispatchKeyEvent', ENTER);
await sleep(800);
form = await readForm('/multi');
log = await readAnim('/multi');
const multiU = fieldLog(log, 'u');
const multiP = fieldLog(log, 'p');
check('菜单选第 2 个账号填充正确', form.u === 'bob' && form.p === 'p2', form);
check('菜单路径同样触发动画类与 vipperfill',
  multiU.add?.cls === true && multiU.mid?.animName === 'vipperfill',
  { add: multiU.add, mid: multiU.mid });
check('菜单路径动画中点 transform 放大', scaleOf(multiU.mid?.transform) > 1.1, multiU.mid?.transform);
const multiValsU = log.inputs.u.map((e) => e.value);
check('菜单路径账号逐字输入', multiValsU.length >= 2 && multiValsU.at(-1) === 'bob', multiValsU);
check('菜单路径账号弹跳在输入完成后触发',
  (multiU.add?.t ?? 0) >= (log.inputs.u.at(-1)?.t ?? Infinity),
  { lastInputAt: log.inputs.u.at(-1)?.t, popAt: multiU.add?.t });
const multiStartGap = (log.inputs.p[0]?.t ?? 0) - (multiU.add?.t ?? 0);
check('菜单路径：密码逐字在账号弹跳后开始', multiStartGap >= 180 && multiStartGap <= 500, multiStartGap);

// ---- 3. prefers-reduced-motion: reduce 降级 ----
await openTab('http://127.0.0.1:8378/rm');
page = await attachPage('/rm');
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
const rmMatches = await page(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
check('媒体模拟生效（prefers-reduced-motion: reduce）', rmMatches === true, rmMatches);
await page(RECORDER);
await sw(`__vipper.dispatch('autofill')`);
await sleep(500);
form = await readForm('/rm');
log = await readAnim('/rm');
const rmU = fieldLog(log, 'u');
const rmP = fieldLog(log, 'p');
check('减少动效下仍完成填充', form.u === 'carol' && form.p === 'p3', form);
check('减少动效下类仍加（清理逻辑不依赖 animationend）', rmU.add?.cls === true, rmU.entries);
check('减少动效下 animation-name 为 none 且无运行中动画',
  rmU.mid?.animName === 'none' && rmU.mid?.running.length === 0,
  { animName: rmU.mid?.animName, running: rmU.mid?.running });
check('减少动效下无 transform 放大', scaleOf(rmU.mid?.transform) === 1, rmU.mid?.transform);
check('减少动效下类仍按时移除', rmU.last?.cls === false, rmU.last);
const rmValsU = log.inputs.u.map((e) => e.value);
const rmValsP = log.inputs.p.map((e) => e.value);
check('减少动效跳过逐字：每字段仅 1 次 input',
  rmValsU.length === 1 && rmValsP.length === 1 && rmValsU[0] === 'carol' && rmValsP[0] === 'p3',
  { u: rmValsU, p: rmValsP });
const rmGap = (rmP.add?.t ?? 0) - (rmU.add?.t ?? 0);
check('减少动效跳过错峰等待（两字段同时填入）', rmGap >= 0 && rmGap < 50, rmGap);
await page.send('Emulation.setEmulatedMedia', { features: [] });

summary();
server.close();
close();
