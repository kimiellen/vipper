# vipper 安装与配置说明

## 加载扩展（开发版）

1. 构建：`pnpm build`（产物在 `.output/chrome-mv3/`）
2. 打开 `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择 `.output/chrome-mv3`
3. 代码更新后：重新 `pnpm build`，并在扩展卡片点**重新加载**

## 快捷键绑定

标签导航 4 键开箱即用（Alt+H/L、Alt+J/K）。

`Alt+.`（打开书签管理器）因 Chrome 的 suggested_key 上限（4 个）无法预置，**需手动绑定一次**：

1. 打开 `chrome://extensions/shortcuts`
2. 找到 vipper 的「打开书签管理器」
3. 点击输入框，按下 `Alt+.` 完成绑定

> 手动验收按键时注意：先打开 vipper 卡片的 **Service Worker** DevTools 再按键。MV3 service worker 30 秒休眠会断开控制台，断开后日志不可见。

## Hyprland 窗口规则（弹窗居中浮动）

Wayland 下窗口定位权在 compositor，Chrome 无法自己居中弹窗。

**关键：必须匹配 `class`，不能匹配标题。** 扩展弹窗映射时的 `initialTitle` 是 `_crx_<扩展id>`，页面标题（Vipper / Vipper 编辑 / Vipper 管理表）是加载后才设置的，窗口规则在创建时评估，按标题匹配一定错过。而 class `chrome-<扩展id>-Default` 在映射瞬间即确定。

**不要设 `size` 规则。** 弹窗尺寸由 vipper 按显示器 workArea 等比计算（宽高各 5/6，clamp 到 900×600 ~ 1600×900），windowrule 设 size 会覆盖该计算，导致小屏放不下、多显示器无法各自适配。

Lua 配置版（`hl.window_rule`，Hyprland 0.56 真机验证通过）——注意 match 字段是**正则表达式**（不是 Lua pattern，`-` 无需转义）：

```lua
-- vipper 弹窗：浮动 + 居中（wui 管理页/解锁页同一 class，一条规则全覆盖）
-- 尺寸由扩展按显示器自动计算，此处不设 size
hl.window_rule({
	name = "vipper-float",
	match = { class = "^chrome-bfkbiapichhdhealeodggldhchmdlhhj-Default$" },
	float = true,
	center = true,
})
```

> 排障经验：effects 里字段类型写错（如 size 传了 table）会导致**整条规则静默失效**。验证方法：`hyprctl reload` 后重开弹窗，`hyprctl clients` 应看到 `floating: 1`。

传统 conf 版（hyprland.conf）：

```conf
windowrulev2 = float, class:^chrome-bfkbiapichhdhealeodggldhchmdlhhj-Default$
windowrulev2 = center, class:^chrome-bfkbiapichhdhealeodggldhchmdlhhj-Default$
```

注意：未打包扩展的 id 由扩展目录的**绝对路径**派生（当前对应 `.output/chrome-mv3` 的构建路径）。目录变动后 id 会变，用 `hyprctl clients` 查看弹窗的实际 `class` 字段更新规则。

## 忘记主密码（重置）

主密码不落盘、不可找回，vipper 页面**故意不提供**"忘记密码"入口（避免恶意清除数据）。确认要重置时手动清除扩展存储：

1. 打开 `chrome://extensions` → vipper 卡片 → **详细信息**
2. 在「检查视图 / Inspect views」处点击 **service worker**，打开 DevTools
3. DevTools → **应用 / Application** → 左侧 **存储 / Storage** → **Extension storage** → 右键 **Local** → **Clear**
4. 重新打开 vipper（Alt+.）→ 进入「创建主密码」流程

⚠️ 这会**永久删除全部书签/账号/记录**（加密数据没有主密码无法解密）。有导出 JSON 备份的话，重置后可经 设置→备份→导入 恢复。

> 同理，这也是**修改主密码的唯一方法**：清除 local 数据 → 创建新主密码 → 导入之前的备份（备份里的密文导入时会用新密钥重新加密）。
