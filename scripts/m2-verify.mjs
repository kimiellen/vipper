/**
 * M2 自动化验收：Alt+J/K 组内标签导航。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 * 断言：组内左右移动、隐式组同样适用、组边界不跨组不环绕、单标签组原地不动。
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';
import { setupScenario, dispatch, getState, activate } from './lib/scenario.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

const setup = await setupScenario(sw);
console.log('场景就绪:', JSON.stringify(setup));

// ---- 隐式组0 [u0 u1]，起点 u0 ----
let s = await getState(sw, setup);
check('起点：active=u0', s.active === setup.u0, s);

await dispatch(sw, 'tab-next'); s = await getState(sw, setup);
check('→：u0→u1', s.active === setup.u1, s);

await dispatch(sw, 'tab-next'); s = await getState(sw, setup);
check('→边界：u1 右侧是 G1，不跨组，仍为 u1', s.active === setup.u1, s);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('←：u1→u0', s.active === setup.u0, s);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('←边界：u0 左侧无标签，仍为 u0', s.active === setup.u0, s);

// ---- 真实组 G1 [a b] ----
await activate(sw, setup.a);

await dispatch(sw, 'tab-next'); s = await getState(sw, setup);
check('G1 内 →：a→b', s.active === setup.b, s);

await dispatch(sw, 'tab-next'); s = await getState(sw, setup);
check('G1 内 →边界：b 右侧是 G2，不跨组，仍为 b', s.active === setup.b, s);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('G1 内 ←：b→a', s.active === setup.a, s);

// ---- 单标签组 G2 [c] ----
await activate(sw, setup.c);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('单标签组 ←：仍为 c', s.active === setup.c, s);

await dispatch(sw, 'tab-next'); s = await getState(sw, setup);
check('单标签组 →：仍为 c', s.active === setup.c, s);

// ---- 隐式组1 [u2 u3]，从 u3 向左 ----
await activate(sw, setup.u3);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('隐式组1 ←：u3→u2', s.active === setup.u2, s);

await dispatch(sw, 'tab-prev'); s = await getState(sw, setup);
check('隐式组1 ←边界：u2 左侧是 G2，不跨组，仍为 u2', s.active === setup.u2, s);

summary();
close();
