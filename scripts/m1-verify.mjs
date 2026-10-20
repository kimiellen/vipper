/**
 * M1 自动化验收：Alt+H/L 切组语义。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 * 场景与断言：视觉顺序切组、隐式组参与、不环绕、组内上次活跃标签记忆、折叠/展开反馈。
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';
import { setupScenario, dispatch, getState } from './lib/scenario.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

const setup = await setupScenario(sw);
console.log('场景就绪:', JSON.stringify(setup));

let s = await getState(sw, setup);
check('起点：active=u0（隐式组0）', s.active === setup.u0, s);

await dispatch(sw, 'group-next'); s = await getState(sw, setup);
check('↓→G1：active=b（记忆的活跃标签），G1展开 G2折叠', s.active === setup.b && !s.g1Collapsed && s.g2Collapsed, s);

await dispatch(sw, 'group-next'); s = await getState(sw, setup);
check('↓→G2：active=c，G1折叠 G2展开', s.active === setup.c && s.g1Collapsed && !s.g2Collapsed, s);

await dispatch(sw, 'group-next'); s = await getState(sw, setup);
check('↓→隐式组1：active=u2（记忆的活跃标签），真实组全部折叠', s.active === setup.u2 && s.g1Collapsed && s.g2Collapsed, s);

await dispatch(sw, 'group-next'); s = await getState(sw, setup);
check('↓边界不环绕：active 仍为 u2', s.active === setup.u2, s);

await dispatch(sw, 'group-prev'); s = await getState(sw, setup);
check('↑→G2：active=c，G2展开', s.active === setup.c && !s.g2Collapsed, s);

await dispatch(sw, 'group-prev'); s = await getState(sw, setup);
check('↑→G1：active=b（记忆保持）', s.active === setup.b && !s.g1Collapsed, s);

await dispatch(sw, 'group-prev'); s = await getState(sw, setup);
check('↑→隐式组0：active=u0', s.active === setup.u0, s);

await dispatch(sw, 'group-prev'); s = await getState(sw, setup);
check('↑边界不环绕：active 仍为 u0', s.active === setup.u0, s);

summary();
close();
