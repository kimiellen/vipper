/**
 * wui 弹窗尺寸计算（spec「wui 主页面布局」2026-10-20）：
 * 按浏览器所在显示器的 workArea 等比计算，宽高各 5/6（≈83%），clamp 到 [900×600, 1600×900]。
 * 5/6 + 上限使 4K @200%（逻辑 1920×1080）精确保持 1600×900；窄于 900 的极端屏幕
 * 由 wui 页面的 ≤900px 媒体查询降级为单列堆叠，横向不裁切。
 * 纯函数，不依赖 chrome.*，供 background 与验证脚本共用。
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** chrome.system.display.DisplayInfo 的结构子集 */
export interface DisplayLike {
  bounds: Rect;
  workArea: Rect;
  isPrimary: boolean;
}

/** chrome.windows.Window 的结构子集（坐标均可选） */
export interface WindowLike {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** 1600×900 恰为 1920×1080 的 5/6，4K @200% 观感与改版前一致 */
export const LAUNCHER_RATIO = 5 / 6;
export const LAUNCHER_MIN = { width: 900, height: 600 } as const;
export const LAUNCHER_MAX = { width: 1600, height: 900 } as const;
/** system.display 不可用 / 无显示器信息时的回退 */
export const LAUNCHER_FALLBACK = { width: 1600, height: 900 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 单个显示器 workArea → 弹窗尺寸（比例 + clamp） */
export function sizeForWorkArea(workArea: Rect): { width: number; height: number } {
  return {
    width: clamp(Math.round(workArea.width * LAUNCHER_RATIO), LAUNCHER_MIN.width, LAUNCHER_MAX.width),
    height: clamp(Math.round(workArea.height * LAUNCHER_RATIO), LAUNCHER_MIN.height, LAUNCHER_MAX.height),
  };
}

/** 点 (x, y) 命中的显示器；无命中返回 undefined */
export function displayAt(displays: DisplayLike[], x: number, y: number): DisplayLike | undefined {
  return displays.find(
    (d) =>
      x >= d.bounds.left &&
      x < d.bounds.left + d.bounds.width &&
      y >= d.bounds.top &&
      y < d.bounds.top + d.bounds.height,
  );
}

/**
 * 弹窗目标尺寸：按来源窗口中心点命中的显示器计算（多显示器各自适配）；
 * 命中失败回退主显示器；无显示器信息回退默认值。
 */
export function computeLauncherSize(
  displays: DisplayLike[],
  sourceWindow: WindowLike | undefined,
): { width: number; height: number } {
  const { left, top, width, height } = sourceWindow ?? {};
  const display =
    (left !== undefined && top !== undefined && width !== undefined && height !== undefined
      ? displayAt(displays, left + width / 2, top + height / 2)
      : undefined) ?? displays.find((d) => d.isPrimary);
  if (!display) return { ...LAUNCHER_FALLBACK };
  return sizeForWorkArea(display.workArea);
}
