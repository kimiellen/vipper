# vipper 安装与配置说明

## 加载扩展（开发版）

1. 构建：`pnpm build`（产物在 `.output/chrome-mv3/`）
2. 打开 `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择 `.output/chrome-mv3`
3. 代码更新后：重新 `pnpm build`，并在扩展卡片点**重新加载**

## 快捷键绑定

标签导航 4 键开箱即用（Alt+↑/↓、Alt+Shift+←/→）。

`Alt+.`（打开书签管理器）因 Chrome 的 suggested_key 上限（4 个）无法预置，**需手动绑定一次**：

1. 打开 `chrome://extensions/shortcuts`
2. 找到 vipper 的「打开书签管理器」
3. 点击输入框，按下 `Alt+.` 完成绑定

> 手动验收按键时注意：先打开 vipper 卡片的 **Service Worker** DevTools 再按键。MV3 service worker 30 秒休眠会断开控制台，断开后日志不可见。

## Hyprland 窗口规则（书签弹窗居中浮动）

Wayland 下窗口定位权在 compositor，Chrome 无法自己居中弹窗。在 `~/.config/hypr/hyprland.conf` 添加：

```conf
# vipper 书签弹窗：浮动 + 居中 + 固定大小（匹配窗口标题 Vipper）
windowrulev2 = float, initialTitle:^(Vipper)$
windowrulev2 = center, initialTitle:^(Vipper)$
windowrulev2 = size 640 480, initialTitle:^(Vipper)$
```

若你的 Chrome 窗口标题匹配不到 `initialTitle`，可改用 `title:^(Vipper)` 或先用 `hyprctl clients` 观察弹窗的实际字段。
