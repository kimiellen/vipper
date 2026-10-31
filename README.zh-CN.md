<div align="center">
  <img src="assets/vipper.svg" alt="vipper logo" width="96" height="96">
  <h1>vipper</h1>
  <p><strong>标签快捷切换器 · 书签管理器 · 密码及书签信息管理器</strong></p>
  <p>
    <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/license-MIT-a6e3a1" alt="MIT License">
    <img src="https://img.shields.io/badge/chrome-MV3-89b4fa" alt="Chrome MV3">
    <img src="https://img.shields.io/badge/WXT-TypeScript-cba6f7" alt="WXT + TypeScript">
    <img src="https://img.shields.io/badge/crypto-WebCrypto%20only-f9e2af" alt="WebCrypto only">
  </p>
</div>

![vipper 管理页](docs/guide/assets/main.zh.png)

vipper 是一个 Chrome Manifest V3 扩展，把三件日常工具装进同一个键盘优先的入口：

1. **标签切换器**——`Alt+H/L` 在标签组之间切换、`Alt+J/K` 在组内切换的键盘二维导航
2. **标签组管理器**——自建的标签组快照库（`Alt+,`）：浏览器重启后一键重开整个组，与浏览器实时双向同步，可锁定不想被覆盖的页面
3. **书签 + 密码管理器**——完全独立于 Chrome 原生系统的加密仓库，管理书签、账号与私密记录，支持一键填充和登录后自动保存

所有操作都围绕键盘设计：打开、搜索、填充、整理，全程不碰鼠标。

## 功能特点

**标签切换器**

- `Alt+H/L` 切换**标签组**；`Alt+J/K` 在**组内**切换标签
- 连续的一段未分组标签视为隐式组——普通散标签也参与导航
- 每组记忆上次活跃的标签；切组时自动折叠其他组
- 边界不环绕，仅作用于当前窗口——多个 Chrome 窗口互不干扰

**标签组管理器**

- `Alt+,` 呼出组管理页：顶部一排组色 chips，左栏是选中组的页面，右栏是书签搜索
- 每个组是 **vipper 自有的快照**（名称 + Chrome 9 色之一 + 有序页面）；回车即在浏览器重建真实标签组。Chrome 书签栏的 saved tab groups 没有扩展 API 可枚举，两者是独立数据
- **打开期间双向实时同步**：浏览器里新增 / 关闭 / 跳转 / 拖入拖出的页面都会回流到快照；在管理页删除、排序、添加也会立即作用到浏览器标签
- **锁定页面**即冻结该条目：浏览器里被关闭或跳转都不会改写快照，下次打开它仍在
- 单个标签关闭 = 删除页面；整窗或整个组关闭只让实时映射失效——**快照完整保留**，这正是浏览器重启后的重开依赖
- **新建 / 编辑 / 删除组**都在这一页完成：内联表单（组名 + Chrome 9 色）保存后即时更新 chips，已打开时同步 Chrome 组的标题与颜色；删除先弹页面内确认，只删快照与映射，不关闭浏览器里已有的标签
- **回车打开即聚焦**：按快照顺序重建标签并合成 Chrome 组，激活首条目、折叠同窗口其他组；已打开的组只激活、不重复建；窗口内各 vipper 组按 chips 顺序排列
- **chips 长按 400ms 拖动排序**；`←/→` 移动 chips、`Enter` 打开组、`/` 跳到搜索框、`Ctrl+/` 回 chips；搜索沿用书签库的拼音索引与 TAGS/LINS 过滤，`↑/↓` 选择结果、`Enter` 追加到当前组
- `+add tab` 支持手动输入 URL 或抓取当前标签页；长按拖动调整页面顺序
- 快照存在本地，浏览器重启后仍在；扩展重载只清空实时映射，按「组名 + 颜色」认回已打开组

![标签组管理页](docs/guide/assets/groups.zh.png)

完整操作与截图见 **[标签组管理](docs/guide/zh-CN/groups.md)**。

**书签 + 密码管理器**

- `Alt+.` 呼出管理页：搜索、TAGS/LINS 多选过滤、详情、原地编辑，一屏完成
- 搜索覆盖书签名 / url / 备注，并支持**中文拼音**（首拼与全拼）：`yh` 命中银行，`tb` 命中淘宝
- `Alt+P` 在登录页主动填充账号密码（Bitwarden 式），逐字符键入 + 字段弹跳动画
- 一条书签可绑多个 URL（`host / exact / prefix` 匹配规则）与多组账号（方向键二级菜单选择）
- **登录自动保存**：提交登录表单后，vipper 弹窗询问新建条目或追加账号——一键加密落盘
- 记录区分明文 `note` 与加密 `secret`（恢复码、API Key 等），不限量
- tag（Catppuccin 配色）与关联信息（手机/邮箱/微信）先建后选，被引用的条目拒绝删除
- 条目归档（手动或超期自动）、JSON 导入导出，适合用 git 做本地备份
- Catppuccin Mocha/Latte 双主题、中英双语界面

## 安全模型

- 主密码 + **PBKDF2-SHA256（60 万次迭代）** + **AES-GCM**，只用浏览器原生 WebCrypto——零第三方加密依赖
- 只有 `account.password` 与 `secret.content` 是密文，其余字段保持明文以支持检索
- 密钥**只存 `chrome.storage.session`**——永不落盘；浏览器每次重启即锁定
- 登录时捕获的凭据只暂存于 service worker 内存，锁定状态下直接丢弃
- 按设计**不提供"忘记密码"入口**——详见[安全模型](docs/guide/zh-CN/security.md)

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+H` / `Alt+L` | 切换到上一个 / 下一个标签组 |
| `Alt+J` / `Alt+K` | 组内向左 / 向右切换标签 |
| `Alt+.` | 呼出 / 关闭管理页（需手动绑定一次，见安装指南） |
| `Alt+,` | 呼出 / 关闭标签组管理页（需手动绑定一次） |
| `Alt+P` | 在当前登录页填充账号密码（需手动绑定一次） |

> Chrome 限制每个扩展最多预置 4 个快捷键，因此 `Alt+.`、`Alt+,` 与 `Alt+P` 需在 `chrome://extensions/shortcuts` 手动绑定——一次性操作，30 秒完成。

## 前置配置（Chrome 侧）

vipper 不接管 Chrome 的原生系统，以下几项按需自行配置：

- **标签组是 Chrome 原生功能**：右键任意标签 →「添加到新标签组」即可分组；在 Chrome 设置中开启「保存并同步标签组」后，组会保存到书签栏并跨设备同步——这与 vipper 自建的书签库互不影响
- **原生书签与密码管理器照常可用**：vipper 的书签 / 凭据完全独立存储，不禁用也不读取 Chrome 的同类功能；是否保留 Chrome 的「保存密码」提示，在 设置 → 自动填充和密码 → Google 密码管理工具 中自行决定
- **快捷键占用检查**：四个导航键（`Alt+H/J/K/L`）与三个手动绑定键（`Alt+.` / `Alt+,` / `Alt+P`）如与其他扩展冲突，在 `chrome://extensions/shortcuts` 调整

## 安装

```bash
pnpm install
pnpm build
```

然后在 `chrome://extensions` 开启开发者模式 → **加载已解压的扩展程序** → 选择 `.output/chrome-mv3`，再绑定三个手动快捷键。

完整步骤——包括让弹窗在 Wayland 下浮动居中的 Hyprland 窗口规则：**[安装指南](docs/guide/zh-CN/installation.md)**

## 使用手册

按操作分类，每篇独立成页、图文配合：

- [安装与快捷键](docs/guide/zh-CN/installation.md)——加载扩展、绑键、Hyprland 规则
- [标签导航](docs/guide/zh-CN/tab-navigation.md)——二维模型与精确语义
- [标签组管理](docs/guide/zh-CN/groups.md)——chips、快照重建、锁定与双向同步
- [书签管理](docs/guide/zh-CN/bookmarks.md)——搜索、拼音、过滤、打开、原地编辑
- [主动填充（Alt+P）](docs/guide/zh-CN/autofill.md)——匹配规则、多账号菜单、iframe 登录
- [登录自动保存](docs/guide/zh-CN/auto-save.md)——登录后的新建 / 追加弹窗
- [标签、关联信息与归档](docs/guide/zh-CN/organization.md)——让仓库保持整洁
- [备份：导入与导出](docs/guide/zh-CN/backup.md)——明文 JSON、全量恢复语义
- [设置](docs/guide/zh-CN/settings.md)——主题、语言、生成器、锁定与归档策略
- [安全模型](docs/guide/zh-CN/security.md)——加密细节与密码重置

## 开发

```bash
pnpm dev          # WXT 开发服务器（HMR）
pnpm build        # 生产构建 → .output/chrome-mv3
pnpm typecheck    # 严格模式 tsc
```

里程碑级验收脚本在 `scripts/`（CDP 驱动，运行于 headless Chromium）。手册配图可通过 `node scripts/docs-shot.mjs` 复现。

## 许可证

[MIT](LICENSE) © 2026 kimiellen
