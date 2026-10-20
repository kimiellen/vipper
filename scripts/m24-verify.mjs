/**
 * M24 自动化验收：弹窗尺寸按显示器 workArea 等比计算。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 纯函数：4K @200%（1920×1080）→ 精确 1600×900；MacBook 1512×982 → 1260×818；
 *   笔记本 1128×752 → 940×627；超大屏 clamp 上限；小屏 clamp 下限
 * - 多显示器：按来源窗口中心点命中的显示器各自计算；中心跨屏时按中心点所在屏
 * - 回退链：命中失败 → 主显示器；无显示器信息 → 1600×900
 * - 接线：manifest 含 system.display 权限；__vipper.launcherSize() 与 node 侧纯函数
 *   对相同输入（SW 实取的显示器 + 焦点窗口）计算结果一致
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';
import {
  computeLauncherSize,
  displayAt,
  sizeForWorkArea,
  LAUNCHER_FALLBACK,
} from '../utils/launcherSize.ts';

const { check, summary } = createChecker();

// ---- 1. 纯函数：典型显示器尺寸 ----
const d = (left, top, w, h, isPrimary = false) => ({
  bounds: { left, top, width: w, height: h },
  workArea: { left, top, width: w, height: h },
  isPrimary,
});

check('4K @200%（1920×1080）→ 精确 1600×900',
  JSON.stringify(sizeForWorkArea(d(0, 0, 1920, 1080).workArea)) === JSON.stringify({ width: 1600, height: 900 }),
  sizeForWorkArea(d(0, 0, 1920, 1080).workArea));

check('MacBook Pro 14"（1512×982）→ 1260×818',
  JSON.stringify(sizeForWorkArea(d(0, 0, 1512, 982).workArea)) === JSON.stringify({ width: 1260, height: 818 }),
  sizeForWorkArea(d(0, 0, 1512, 982).workArea));

check('笔记本原生屏（1128×752）→ 940×627（>900 保持三列紧凑布局）',
  JSON.stringify(sizeForWorkArea(d(0, 0, 1128, 752).workArea)) === JSON.stringify({ width: 940, height: 627 }),
  sizeForWorkArea(d(0, 0, 1128, 752).workArea));

check('超大屏（3840×2160）→ clamp 上限 1600×900',
  JSON.stringify(sizeForWorkArea(d(0, 0, 3840, 2160).workArea)) === JSON.stringify({ width: 1600, height: 900 }),
  sizeForWorkArea(d(0, 0, 3840, 2160).workArea));

check('小屏（1024×700）→ clamp 下限 900×600',
  JSON.stringify(sizeForWorkArea(d(0, 0, 1024, 700).workArea)) === JSON.stringify({ width: 900, height: 600 }),
  sizeForWorkArea(d(0, 0, 1024, 700).workArea));

// workArea 小于 bounds（有 dock/面板）时按 workArea 算
const docked = { bounds: { left: 0, top: 0, width: 1920, height: 1080 }, workArea: { left: 0, top: 0, width: 1920, height: 1040 }, isPrimary: true };
check('workArea 小于 bounds 时按 workArea 计算',
  JSON.stringify(computeLauncherSize([docked], undefined)) === JSON.stringify({ width: 1600, height: 867 }), // 1040*5/6=866.67→867
  computeLauncherSize([docked], undefined));

// ---- 2. 多显示器：按来源窗口中心点命中的显示器 ----
const main4k = d(0, 0, 1920, 1080, true);      // 主屏：4K @200%
const laptop = d(1920, 0, 1128, 752);          // 副屏：笔记本（主屏右侧）
const dual = [main4k, laptop];

check('来源窗口在主屏 → 1600×900',
  JSON.stringify(computeLauncherSize(dual, { left: 100, top: 100, width: 1200, height: 800 })) === JSON.stringify({ width: 1600, height: 900 }),
  computeLauncherSize(dual, { left: 100, top: 100, width: 1200, height: 800 }));

check('来源窗口在副屏 → 940×627',
  JSON.stringify(computeLauncherSize(dual, { left: 2000, top: 100, width: 900, height: 600 })) === JSON.stringify({ width: 940, height: 627 }),
  computeLauncherSize(dual, { left: 2000, top: 100, width: 900, height: 600 }));

// 窗口跨屏：中心点在主屏（left=900, width=1200 → 中心 x=1500 在主屏）
check('跨屏窗口按中心点所在屏计算（中心在主屏）',
  JSON.stringify(computeLauncherSize(dual, { left: 900, top: 100, width: 1200, height: 800 })) === JSON.stringify({ width: 1600, height: 900 }),
  computeLauncherSize(dual, { left: 900, top: 100, width: 1200, height: 800 }));

// ---- 3. 回退链 ----
check('无显示器信息 → 默认 1600×900',
  JSON.stringify(computeLauncherSize([], { left: 0, top: 0, width: 100, height: 100 })) === JSON.stringify(LAUNCHER_FALLBACK),
  computeLauncherSize([], { left: 0, top: 0, width: 100, height: 100 }));

check('来源窗口坐标缺失 → 主显示器',
  JSON.stringify(computeLauncherSize(dual, undefined)) === JSON.stringify({ width: 1600, height: 900 }),
  computeLauncherSize(dual, undefined));

check('来源窗口中心不在任何显示器 → 主显示器',
  JSON.stringify(computeLauncherSize(dual, { left: -5000, top: -5000, width: 100, height: 100 })) === JSON.stringify({ width: 1600, height: 900 }),
  computeLauncherSize(dual, { left: -5000, top: -5000, width: 100, height: 100 }));

check('displayAt 边界：右下边缘外不命中', displayAt(dual, 1920, 1080)?.isPrimary !== true, displayAt(dual, 1920, 1080));

// ---- 4. 接线：SW 真实 launcherSize() 与 node 侧纯函数对拍 ----
const { sw, close } = await connectSW();

check('manifest 含 system.display 权限',
  await sw(`chrome.runtime.getManifest().permissions.includes('system.display')`),
  await sw(`chrome.runtime.getManifest().permissions`));

const displays = await sw(`chrome.system.display.getInfo().catch(() => [])`);
const focused = await sw(`chrome.windows.getLastFocused().catch(() => undefined)`);
const actual = await sw(`__vipper.launcherSize()`);
const expected = computeLauncherSize(displays ?? [], focused ?? undefined);

check('SW launcherSize() 与纯函数对拍一致（headless 环境实取显示器 + 焦点窗口）',
  JSON.stringify(actual) === JSON.stringify(expected),
  { actual, expected, displays, focused });

check('结果在 clamp 区间内（900~1600 × 600~900）',
  actual.width >= 900 && actual.width <= 1600 && actual.height >= 600 && actual.height <= 900,
  actual);

close();
summary();
