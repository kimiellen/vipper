/**
 * M1 自动化验收：CDP 驱动 Chromium 中的 vipper service worker，验证 Alt+↑/↓ 切组语义。
 *
 * 前置（见 AGENTS.md「自动化测试回路」）：
 *   HOME=$PWD/.fake-home chromium --headless=new \
 *     --user-data-dir=$PWD/.chrome-test-profile \
 *     --load-extension=$PWD/.output/chrome-mv3 \
 *     --remote-debugging-port=9333 --no-first-run --no-default-browser-check about:blank
 *
 * 场景（标签栏视觉顺序）：
 *   [u0 u1] [G1: a b] [G2: c] [u2 u3]
 *   隐式组0    真实组1    真实组2   隐式组1
 *
 * 断言：视觉顺序切组、隐式组参与、不环绕、组内上次活跃标签记忆、折叠/展开反馈。
 */

const ver = await fetch('http://127.0.0.1:9333/json/version').then((r) => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
function raw(method, params = {}, sessionId) {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

let swTarget = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  const t = m.params?.targetInfo;
  if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged')
    && t?.type === 'service_worker' && t.url.includes('background')) swTarget = t;
};
await raw('Target.setDiscoverTargets', { discover: true });
for (let i = 0; i < 60 && !swTarget; i++) await new Promise((r) => setTimeout(r, 500));
if (!swTarget) { console.error('FAIL: service worker not found (扩展未加载？)'); process.exit(1); }
const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });

async function sw(expression) {
  const r = await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error('SW eval error: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// ---- 场景搭建 ----
const setup = JSON.parse(await sw(`(async () => {
  const win = await chrome.windows.getCurrent();
  const mk = () => chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false }).then((t) => t.id);
  const [u0] = (await chrome.tabs.query({ windowId: win.id })).map((t) => t.id);
  const u1 = await mk(), a = await mk(), b = await mk(), c = await mk(), u2 = await mk(), u3 = await mk();
  const g1 = await chrome.tabs.group({ tabIds: [a, b] });
  const g2 = await chrome.tabs.group({ tabIds: [c] });
  const act = async (id) => { await chrome.tabs.update(id, { active: true }); await new Promise((r) => setTimeout(r, 250)); };
  await act(b);   // 播种：G1 上次活跃 = b
  await act(u2);  // 播种：隐式组1 上次活跃 = u2
  await act(u0);  // 起点：隐式组0 的 u0
  return JSON.stringify({ win: win.id, u0, u1, a, b, c, u2, u3, g1, g2 });
})()`));
console.log('场景就绪:', JSON.stringify(setup));

const dispatch = async (cmd) => {
  await sw(`__vipper.dispatch(${JSON.stringify(cmd)})`);
  await new Promise((r) => setTimeout(r, 300)); // 等 onActivated 记忆与折叠生效
};
const state = () => sw(`(async () => {
  const [act] = await chrome.tabs.query({ active: true, windowId: ${setup.win} });
  const g1 = await chrome.tabGroups.get(${setup.g1});
  const g2 = await chrome.tabGroups.get(${setup.g2});
  return JSON.stringify({ active: act.id, g1Collapsed: g1.collapsed, g2Collapsed: g2.collapsed });
})()`).then(JSON.parse);

const results = [];
function check(name, cond, actual) {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' 实际: ' + JSON.stringify(actual)}`);
}

// ---- 断言序列 ----
let s = await state();
check('起点：active=u0（隐式组0）', s.active === setup.u0, s);

await dispatch('group-next'); s = await state();
check('↓→G1：active=b（记忆的活跃标签），G1展开 G2折叠', s.active === setup.b && !s.g1Collapsed && s.g2Collapsed, s);

await dispatch('group-next'); s = await state();
check('↓→G2：active=c，G1折叠 G2展开', s.active === setup.c && s.g1Collapsed && !s.g2Collapsed, s);

await dispatch('group-next'); s = await state();
check('↓→隐式组1：active=u2（记忆的活跃标签），真实组全部折叠', s.active === setup.u2 && s.g1Collapsed && s.g2Collapsed, s);

await dispatch('group-next'); s = await state();
check('↓边界不环绕：active 仍为 u2', s.active === setup.u2, s);

await dispatch('group-prev'); s = await state();
check('↑→G2：active=c，G2展开', s.active === setup.c && !s.g2Collapsed, s);

await dispatch('group-prev'); s = await state();
check('↑→G1：active=b（记忆保持）', s.active === setup.b && !s.g1Collapsed, s);

await dispatch('group-prev'); s = await state();
check('↑→隐式组0：active=u0', s.active === setup.u0, s);

await dispatch('group-prev'); s = await state();
check('↑边界不环绕：active 仍为 u0', s.active === setup.u0, s);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
