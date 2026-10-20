# 安装与快捷键

[English](../installation.md) | 简体中文 · [← 返回 README](../../../README.zh-CN.md)

---

## 加载扩展

```bash
pnpm install
pnpm build        # 产物：.output/chrome-mv3
```

1. 打开 `chrome://extensions`
2. 开启右上角**开发者模式**
3. **加载已解压的扩展程序** → 选择 `.output/chrome-mv3`
4. 代码更新后：重新 `pnpm build`，并在扩展卡片点**重新加载**

## 手动绑定两个快捷键

标签导航 4 键开箱即用。Chrome 限制每个扩展最多预置 4 个快捷键，以下两个需手动绑定一次：

1. 打开 `chrome://extensions/shortcuts`
2. 找到 **vipper**，绑定：
   - 「打开书签管理器」→ `Alt+.`
   - 「在当前登录页填充账号密码」→ `Alt+P`

## 首次使用：创建主密码

按 `Alt+.`——首次启动会要求创建主密码。它用于加密所有凭据，**不会被存储**，也无法找回。忘记后的重置方法见[安全模型 → 重置](security.md)。

![创建主密码](../assets/unlock-create.zh.png)

## Hyprland（Wayland）：弹窗浮动居中

Wayland 下窗口定位权在 compositor，Chrome 无法自己居中弹窗。弹窗**尺寸**由 vipper 按显示器 workArea 等比计算（各取 5/6，clamp 到 900×600 ~ 1600×900），Hyprland 只需负责 float + center。

**规则必须匹配 `class`，不能匹配标题。** 弹窗映射瞬间的 `initialTitle` 是 `_crx_<扩展id>`，真实标题是加载后才设置的，按标题匹配一定错过；而 class `chrome-<扩展id>-Default` 在映射瞬间即确定。

**不要设 `size` 规则**——它会覆盖 vipper 的按显示器计算，导致小屏放不下、多显示器无法各自适配。

Lua 配置版（`hl.window_rule`，Hyprland 0.56 真机验证通过；match 字段是**正则表达式**）：

```lua
hl.window_rule({
	name = "vipper-float",
	match = { class = "^chrome-<扩展id>-Default$" },
	float = true,
	center = true,
})
```

传统 `hyprland.conf` 版：

```conf
windowrulev2 = float, class:^chrome-<扩展id>-Default$
windowrulev2 = center, class:^chrome-<扩展id>-Default$
```

> 未打包扩展的 id 由扩展目录的**绝对路径**派生。构建目录变动后 id 会变——用 `hyprctl clients` 查看弹窗的实际 `class` 字段并更新规则。
>
> 排障经验：字段类型写错（如 `size` 传了 table）会导致**整条规则静默失效**。验证方法：`hyprctl reload` 后重开弹窗，`hyprctl clients` 应看到 `floating: 1`。

## 其他平台

无需窗口规则——vipper 会按来源显示器的尺寸等比打开居中的弹窗。

> 手动验收按键时注意：先打开 vipper 卡片的 **Service Worker** DevTools 再按键。MV3 service worker 30 秒休眠会断开控制台，断开后日志不可见。
