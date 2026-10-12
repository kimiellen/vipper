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
- 未分组的散标签：**连续的一段**未分组标签视为一个隐式组，参与 ↑/↓ 导航（被真实组隔断的散标签属于不同隐式组，与视觉顺序一致）
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

完全独立于 Chrome 原生书签/密码系统，扩展自建存储。书签条目按页面布局分区（2026-10-13 定稿）：

- **基础信息区**：`title`（书签名）、`createdAt`、`updatedAt`、`lastUsedAt`（条目列表按 lastUsedAt **降序**）
- **tag 栏**：`tags: TagId[]`，引用 tag 管理表，可多个
- **关联信息栏**：`linkedInfos: LinkedInfoId[]`，引用关联信息表（手机号/微信号/邮箱等），可多个
- **URL 区**：`urls: { url, match }[]`，默认 1 条可增；`match` 为匹配规则 `host | exact | prefix`（默认 `host`），供 Alt+P 判定"当前页面是否适用此 URL"（学 Bitwarden）
- **账号区**：`accounts: { username, password, label? }[]`，默认 1 对可增；`password` 加密落盘；`label` 用于多账号二级菜单辨识（如"主号/小号"），缺省显示 username
- **记录区**：`records: (Note | Secret)[]`，默认空、不限量；只有这两种是"模板"（可重复添加）：
  - `note` 明文记录：`{ name, content }`，不加密
  - `secret` 私密记录：`{ name, content }`，`content` 加密落盘
- **备注区**：`remark: string`，书签级固定唯一字段，不是模板，不加密
- **条目状态**：`status: 'active' | 'archived'`
- **favicon**：展示层自动获取站点图标，不入数据模型

两张全局管理表（均**只能先建后选**，不支持即输即建，防止相近语义重复添加）：

- tag 管理表：`{ id, name }[]`
- 关联信息表：`{ id, type, value }[]`（type 如手机号/邮箱/微信/自定义）

加密格式自描述：`{"$enc":"v1","iv":<base64>,"data":<base64>}`，便于将来算法/密钥迁移。只有 `account.password` 与 `secret.content` 是密文，其余字段明文以支持检索。

### 存储布局（性能设计）

chrome.storage.local 是 LevelDB 键值库（声明 `unlimitedStorage` 去配额上限），性能靠 **key 拆分**而非分文件：

| key | 内容 | 访问场景 |
|---|---|---|
| `idx` | 轻量索引 `[{id,title,tags,linkedInfos,lastUsedAt,status}]` | 搜索/列表只读它 |
| `bm:<id>` | 条目详情 | 打开/编辑某条时读 |
| `arc:<id>` | 归档条目 | 归档页专用，主搜索天然不污染 |
| `meta:tags` / `meta:links` / `meta:settings` | 管理表与配置（含自动归档阈值） | 管理页 |

### 归档

- 手动归档 + 自动归档（lastUsedAt 超过阈值，**默认 180 天、可配置**）
- 归档 = 数据从 `bm:` 挪到 `arc:` + `idx` 更新状态；**不做真实文件**
- 归档页复用 launcher 布局与功能（archive 模式）

### 导入导出

- 导出：全量**明文 JSON**，需输入主密码确认（明文导出是有意设计，用于本地 git 备份）
- 导入：读取 JSON 合并入库
- 备份主路径 = 导出 JSON 提交本地 git；软链 LevelDB 目录可行但不推荐（二进制噪音、恢复脆弱）

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

- 录入/编辑与管理 UI 的具体页面设计（编辑页布局已定分区，交互细节待定）
- TOTP 二步验证种子、密码历史（评估后缓办）
- 切组滚动动画的 UI 载体（第一版不做）

## 技术栈

- Chrome Extension **Manifest V3**
- **WXT + TypeScript**（MV3 脚手架、content script 打包、开发期 HMR）
- 加解密：WebCrypto API（浏览器原生，无依赖）
