# vipper Spec

> 本文档是 vipper 项目后续所有开发会话的事实源。方向性变更走 spec-change 协议：先更新本文档，再改代码。

## 项目概述

vipper 是一个 Chrome MV3 扩展，目标用户是作者本人（Arch Linux + Hyprland，scrolling 布局）。包含两大功能：

1. **标签管理器**：在 Chrome 内复刻 Hyprland 的二维导航操作逻辑
2. **书签 + 密码管理器**：独立于 Chrome 原生系统的"书签 + 记录"一体化管理，凭据加密存储、主动填充

## Feature 1：标签管理器（二维导航）

### 操作映射

| Hyprland | Chrome (vipper) | 语义 |
|---|---|---|
| Super+↑/↓ 切换 workspace | **Alt+↑/↓** | 切换标签组 |
| Super+←/→ 切换窗口 | **Alt+Shift+←/→** | 组内切换标签 |

### 已确认语义

- 组模型：**Chrome 原生 Tab Groups**（`chrome.tabGroups` API 驱动）
- 组的顺序：按标签栏**从左到右的视觉顺序**映射为**上→下**
- 未分组的散标签：视为一个**隐式组**，参与 ↑/↓ 导航
- 边界：**不环绕**（到顶/到底、到左/到右后按键无效）
- 切组后激活目标组内**上次活跃的标签**（每组记忆）
- 作用域：**仅当前窗口**（多 Chrome 窗口互不干扰）
- 视觉反馈：切组时**折叠其他组、展开目标组**，由 Chrome 标签栏原生呈现；滚动动画**第一版不做**，留作后续增强

### 技术路径

- `chrome.commands` 声明 4 个命令（上/下/左/右），service worker 监听 `onCommand`
- commands 快捷键浏览器全局生效，不依赖页面焦点——这是选择它而非 content script 按键监听的原因

## Feature 2：书签 + 密码管理器

### 交互流程

1. **Alt+.** 呼出书签管理弹窗（浏览器窗口中心位置）
2. 光标自动落在搜索栏，输入关键字检索
3. `↓` 进入条目区域，方向键移动，回车在**来源标签所在的 tab group** 打开该书签
4. 打开登录页后，**Alt+P** 主动填充账号密码（类 Bitwarden）
5. 一条书签绑定多个 URL 或多组账号时，弹**二级菜单**（`↑/↓` 选择 + 回车确认）

### 数据模型

完全独立于 Chrome 原生书签/密码系统，扩展自建存储（`chrome.storage.local`）：

- 一条**书签** = 多个 URL + 多条**记录**
- 记录模板化（模板字段设计待细化，见"待定项"）：
  - 账号密码模板
  - 记录模板
  - 私密记录模板

### 安全模型（已确认）

- **主密码 + WebCrypto**：PBKDF2 派生密钥，AES-GCM 加密
- 密码字段与私密记录模板**加密后落盘**，密钥永不持久化
- 解锁策略：**浏览器重启必锁 + 30 分钟无操作自动锁定**（超时时长可配置）
- 数据只能通过插件本身读取

### UI 载体

- 管理弹窗：`chrome.windows.create({type: 'popup'})`，页面设固定标题，由 **Hyprland windowrule**（匹配 initialTitle）实现浮动居中——Wayland 下窗口定位权在 compositor，Chrome 的 left/top 不可靠
- Alt+P 二级菜单：登录页内 content script 浮层（登录页均为普通网站，无注入限制）

## 关键约束（Chrome 平台限制）

1. `Alt+←/→` 是 Chrome 保留的历史导航键，**扩展不可覆盖** → 组内切换改用 `Alt+Shift+←/→`
2. manifest 的 `suggested_key` **上限 4 个**，标签导航已用满 → `Alt+.` 和 `Alt+P` 需安装后在 `chrome://extensions/shortcuts` **手动绑定一次**（写入安装说明）
3. `Ctrl+Alt` 组合因 AltGr 冲突被禁止
4. content script 无法注入 `chrome://` 页面、新标签页、Web Store

## 风险项

- **R1**：`Alt+Shift+←/→` 能否绑定未经实测，文档未明确。第 0 里程碑验证，备选方案 `Alt+H/L`。

## 待定项（后续讨论后通过 spec-change 补充）

- 记录模板的字段设计（账号密码 / 记录 / 私密记录三种模板的字段）
- 是否要求用户可见的真实文件存储（需 native messaging，当前按 chrome.storage.local 设计）
- 切组滚动动画的 UI 载体（第一版不做）

## 技术栈

- Chrome Extension **Manifest V3**
- **WXT + TypeScript**（MV3 脚手架、content script 打包、开发期 HMR）
- 加解密：WebCrypto API（浏览器原生，无依赖）
