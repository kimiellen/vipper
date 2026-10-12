/**
 * M1/M2 共享测试场景：在 Chromium 当前窗口构造标签条
 *   [u0 u1] [G1: a b] [G2: c] [u2 u3]
 *   隐式组0    真实组1    真实组2   隐式组1
 * 并播种活跃记忆：G1→b，隐式组1→u2，最终落在隐式组0的 u0。
 */

import { sleep } from './sw-driver.mjs';

export async function setupScenario(sw) {
  return JSON.parse(await sw(`(async () => {
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
}

/** 通过扩展暴露的调试钩子派发命令，并等待记忆/折叠副作用生效 */
export async function dispatch(sw, cmd) {
  await sw(`__vipper.dispatch(${JSON.stringify(cmd)})`);
  await sleep(300);
}

/** 读取当前状态：活跃标签 + 两个真实组的折叠状态 */
export function getState(sw, setup) {
  return sw(`(async () => {
    const [act] = await chrome.tabs.query({ active: true, windowId: ${setup.win} });
    const g1 = await chrome.tabGroups.get(${setup.g1});
    const g2 = await chrome.tabGroups.get(${setup.g2});
    return JSON.stringify({ active: act.id, g1Collapsed: g1.collapsed, g2Collapsed: g2.collapsed });
  })()`).then(JSON.parse);
}

/** 直接激活某标签（M2 用来把焦点放进指定组） */
export async function activate(sw, tabId) {
  await sw(`chrome.tabs.update(${tabId}, { active: true })`);
  await sleep(250);
}
