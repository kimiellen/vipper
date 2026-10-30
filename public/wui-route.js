/**
 * wui 首帧视图路由。
 *
 * Alt+, 打开 wui.html#groups 时，主模块（main.ts）要等设置读取、解锁校验、读库等
 * 多个 await 之后才切视图；这段时间浏览器已经把默认可见的书签页画出来了，
 * 视觉上就是「先闪一下 wui 书签视图，再跳到 groups」。
 *
 * 本脚本在 <head> 里同步执行（早于首帧绘制、不依赖 CSP unsafe-inline），
 * 只按 hash 在 <html> 上打 data-view 标记；index.html 的 CSS 据此在首帧
 * 就隐藏错误视图。数据渲染与视图状态的最终来源仍是 main.ts（applyViewMode）。
 *
 * 注意：这里的判定条件必须与 main.ts 的 `viewMode` 初始值保持一致。
 */
document.documentElement.dataset.view = location.hash === '#groups' ? 'groups' : 'bookmarks';
