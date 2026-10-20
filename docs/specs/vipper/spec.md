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

### 交互流程（2026-10-14 改版：wui 管理页统一入口）

1. **Alt+.** 呼出 wui 管理页（浏览器窗口中心位置）：顶行工具栏（active/archived 切换 · 搜索 · TAGS/LINS 多选过滤 · 新增书签）+ 下区三块（Settings 手风琴 / results 结果表格 / contents 详情）；已打开时**纯 toggle 关闭**（2026-10-15 定稿：Wayland 下唤回聚焦不可靠，纯 toggle 更简单，失焦时连按两次即可关+开重获焦点；原混合 toggle 作废）。顶行 TAGS/LINS 多选过滤属于**会话级视图状态**：选择结果存 `chrome.storage.session`，Alt+. 关窗再开或页面重载后恢复；浏览器重启后复位；已删除的 tag/linkedInfo 在恢复时自动剔除。搜索词与 active/archived 切换不恢复（2026-10-20 定稿）
2. 锁定门控：未解锁时 Alt+. 打开的是**解锁页**（与主页面同尺寸），解密成功后才进入主页面；能进入主页面即有权解密 password 与 secret.content
3. 搜索范围：书签名 / url / **备注**（remarks 入 idx 索引，明文以支持检索）；结果表格首列为 favicon，时间字段格式化展示
   - 拼音检索（2026-10-18 定稿）：书签名与备注额外支持**中文拼音首拼与全拼**（`tb`/`taobao` → 淘宝，`yh`/`yinhang` → 银行）；url 不做拼音转换，`records[].name` 不参与（不在 idx 内，需读取/解密详情，留作后续）。不新增派生索引，在 wui 侧运行时转换；选 pinyin-pro 是因词级多音字正确（银行 yh、重庆 cq、长城 cc、长沙 cs），代价为 wui 包约 +140KB gzip，service worker 不受影响
4. 选中条目回车在**来源标签所在的 tab group** 打开该书签（自 M3 launcher 移植；launcher 弹窗由本页面取代、淘汰）
5. 打开登录页后，**Alt+P** 主动填充账号密码（类 Bitwarden）；填充反馈采用 Bitwarden 同款字段弹跳动画（2026-10-18 新增）：被填充的输入框在 200ms 内缩放 1 → 1.2 → 1，系统开启「减少动效」（`prefers-reduced-motion`）时自动禁用；不提供扩展内动画开关（YAGNI，系统级开关已够用）。两字段的动效**先后播放**（2026-10-18 追加）：账号字段弹跳完成后才填入密码并弹跳，形成账号→密码的节奏；减少动效时无动画，两者直接同时填入。填充过程模拟**逐字符键入**（2026-10-18 再追加）：每字 20ms、单字段按约 1s 预算自动压缩间隔，逐字完成后再弹跳；减少动效时跳过逐字，直接一次性写入（仍派发最终 input/change）。锁定状态按 Alt+P 打开/聚焦 **wui 解锁页**（2026-10-18 修订，页面内解锁浮层淘汰）；页面没有 content script（扩展重载前打开的旧标签页、注入时序窗口）时自动补注入后再填充，无需刷新页面。登录表单位于跨域 iframe 的站点（如 163 邮箱）同样支持（2026-10-18 追加）：content script 覆盖所有 frame，填充前由 SW 探测实际承载表单的 frame 并定向填充；账号菜单与失败提示只在**顶层页面**展示，避免每个 frame 重复弹层。字段探测只认**可见**输入框——163 在登录 iframe 里放了一个 0 尺寸的诱饵密码框，隐藏字段不写。浏览器对不可见跨域 iframe 会把 `setTimeout` 钳到约 1 秒；填充时测量实际等待耗时，确认被节流后放弃逐字动画、本字段剩余部分与后续字段直接整段写入，避免退化成 1 秒/字（2026-10-19 追加）。账号框探测在存在密码框时以密码框为锚点：优先同一 form 内、DOM 上紧邻密码框之前的可见文本框，页面首个文本框（如页头搜索框）不再被误当账号框；显式 `autocomplete=username/email` 仍最高优先（2026-10-19 追加）
6. 一条书签绑定多个 URL 或多组账号时，弹**二级菜单**（`↑/↓` 选择 + 回车确认）；菜单弹出时自动接管焦点、关闭后还给原元素——登录表单在跨域 iframe 内时，焦点原本在 iframe 里，顶层菜单收不到键盘事件（2026-10-20 追加）
7. 编辑：点击 contents 区域右上角 ✎（或「新增书签」），**contents 区域原地切换为编辑态**（不跳转页面）；编辑态字段顺序与展示态一致（title → tags → linkedInfos → urls → accounts → records → remarks → status），URL 的 match 规则只在编辑态可选；`createdAt`/`updatedAt`/`lastUsedAt` 三个只读时间在展示态与编辑态均**置于区域最底部**（2026-10-14 定稿；M6 的独立 editor.html 淘汰）

### 登录提交自动保存（2026-10-20 定稿）

目标：登录页提交后，vipper 尚无对应凭据时询问是否保存；条目已存在时把新账号追加进去。锁定态不参与（见安全模型）。

**捕获（content script，所有 frame）**

- capture 阶段监听 form `submit`、密码框回车、提交类按钮点击（覆盖无 form 的纯 JS 登录页）；只处理 http/https 页面
- 提交时读**可见**账号框与密码框原值，复用 Alt+P 的字段探测（可见性过滤、密码框锚定账号框）
- 不触发：账号或密码为空；可见密码框 ≥2（注册/改密表单）；字段值与本 frame 最近一次 Alt+P 自动填充值完全相同（未修改）
- 同一次提交会先后触发 click 与 submit：同一 tab 2s 内相同凭据只捕获一次

**暂存与投递**

- SW 按 tabId 在**内存**暂存捕获（账号 / 密码 / 顶层 URL / 标题），不写 storage、不写日志；新捕获覆盖旧 pending
- 捕获时动态注册 `tabs.onUpdated`：目标 tab 导航完成（status complete）后向 **frame 0** 推送弹窗；SPA 无导航时由捕获 frame 延迟 1s 请求 SW 推送
- 每个 pending 只展示一次；保存 / 不保存 / 丢弃后清 pending 并注销 listener；新捕获替换已展示的浮卡
- 锁定检查在捕获与推送两处：锁定则静默丢弃，**不**暂存明文等待解锁（2026-10-20 决定）

**判定（顶层 URL 按 `matchUrl` 匹配 active 条目）**

- 无匹配 → **新建条目**弹窗：标题（默认标签页标题，可编辑）、网址（只读）、账号（只读）、密码（遮蔽）、TAG/LINS 多选（先建后选）
- 有匹配且所有匹配条目都不含该 username → **追加**弹窗：目标条目下拉（默认 `lastUsedAt` 最新；多个匹配时显示），账号 / 密码
- 任一匹配条目已含该 username → 静默丢弃，不弹（**不做密码更新提示**，2026-10-20 决定；改密码去 wui 手动编辑）
- 归档条目不参与匹配（与 Alt+P 一致）；已归档站点按新建处理
- 保存：新建走 `addBookmark`（`urls: [{ url: 顶层 URL, match: 'host' }]`），追加走 `saveBookmark`；均加密落盘、更新 `lastUsedAt`；保存时过滤已删除的 tag/link id

**弹窗 UI**

- content script **右上角浮动卡片**（独立 shadow host，与 Alt+P 菜单互不覆盖），宽 360px，非阻断、不抢焦点，150ms 滑入（减少动效时禁用）
- 字段：标题（新建态可编辑）/ 网址 / 账号 / 密码（遮蔽不可展开）/ TAG 多选 / LINS 多选；追加态为条目下拉 + 账号 / 密码
- 底部「不保存」「保存」；Esc 或 ✕ = 丢弃；保存成功 2s toast；文案跟随 `meta:settings.lang`
- 主题跟随 `meta:settings.theme`（`system` 在页面侧用 `prefers-color-scheme` 解析）；样式直接 `?inline` 引入 `design-system/tokens.css`，注入 shadow 时把 `:root` 映射为 `:host`，不硬编码色值

**已知边界**

- 无法可靠判定登录成功：失败登录也可能弹窗；文案保持中性、可取消
- 无可见账号框的多步登录（仅密码步）不捕获；弹窗登录 / 新标签方式登录可能错过
- SSO 中间页弹窗后若立刻跳转，浮卡随文档销毁且不再重复展示
- SW 被回收或浏览器重启会丢失 pending（此时不弹，不会写入错误数据）

### 数据模型（2026-10-17 修订）

完全独立于 Chrome 原生书签/密码系统，扩展自建存储。书签条目按页面布局分区：

- **基础信息区**：`title`（书签名）、`createdAt`、`updatedAt`、`lastUsedAt`（条目列表按 lastUsedAt **降序**）
- **tag 栏**：`tags: TagId[]`，引用 tag 管理表，可多个
- **关联信息栏**：`linkedInfos: LinkedInfoId[]`，引用关联信息表，可多个
- **URL 区**：`urls: { url, match }[]`，默认 1 条可增；`match` 为匹配规则 `host | exact | prefix`（默认 `host`；`exact` = origin + pathname，忽略 query/hash），供 Alt+P 判定"当前页面是否适用此 URL"（学 Bitwarden）；match 只在编辑模式展示/选择
- **账号区**：`accounts: { username, password }[]`，默认 1 对可增；`password` 加密落盘（2026-10-14 起删除 `label` 字段，多账号二级菜单直接显示 username）
- **记录区**：`records: (Note | Secret)[]`，默认空、不限量；只有这两种是"模板"（可重复添加）：
  - `note` 明文记录：`{ name, content }`，不加密
  - `secret` 私密记录：`{ name, content }`，`content` 加密落盘，展示遮蔽为 `*`
- **备注区**：`remarks: string`，书签级固定唯一字段，不是模板，不加密；**入 idx 支持搜索**。2026-10-17 由 `remark` 更名；旧 `bm:`/`arc:`/`idx` 数据首次访问时自动迁移，导入兼容旧版导出文件的 `remark` 字段
- **条目状态**：`status: 'active' | 'archived'`
- **favicon**：展示层自动获取站点图标，不入数据模型

两张全局管理表（均**只能先建后选**，不支持即输即建，防止相近语义重复添加）：

- tag 管理表：`{ id, name, color }[]`（color 为 Catppuccin 14 彩色之一，2026-10-14 新增）
- 关联信息表：`{ id, name, value }[]`（name 如"手机1/邮箱1/微信"，2026-10-14 起由 `{id,type,value}` 改为 name 自由命名）
- 删除管理表条目时若被书签引用：**拒绝删除并提示被引用**

加密格式自描述：`{"$enc":"v1","iv":<base64>,"data":<base64>}`，便于将来算法/密钥迁移。只有 `account.password` 与 `secret.content` 是密文，其余字段明文以支持检索。

### 存储布局（性能设计）

chrome.storage.local 是 LevelDB 键值库（声明 `unlimitedStorage` 去配额上限），性能靠 **key 拆分**而非分文件：

| key | 内容 | 访问场景 |
|---|---|---|
| `idx` | 轻量索引 `[{id,title,remarks,tags,linkedInfos,urls,accountCount,lastUsedAt,status}]`（accountCount 仅计数，供列表展示） | 搜索/列表只读它 |
| `bm:<id>` | 条目详情 | 打开/编辑某条时读 |
| `arc:<id>` | 归档条目 | 归档视图专用，active 搜索天然不污染 |
| `meta:tags` / `meta:links` / `meta:settings` | 管理表与配置（锁定超时、自动归档阈值、主题、语言） | 管理页 |

### 归档

- 入口：管理页顶行 **active/archived seg 切换**——激活哪个就搜索/展示哪个状态的条目（2026-10-14 起取代 M7 的 launcher archive 独立窗口）
- 归档操作仅两种：① Settings→general 配置**自动归档天数**；② 编辑模式中将 status 改为 archived（恢复同理）
- 自动归档阈值：**默认 0 = 不开启**（2026-10-14 修订，原默认 180 天）；扫描仍由启动时 + 每日 alarm 执行
- 归档 = 数据从 `bm:` 挪到 `arc:` + `idx` 更新状态；**不做真实文件**

### 导入导出（2026-10-17 修订）

- 导出：全量**明文 JSON**，需输入主密码确认（明文导出是有意设计，用于本地 git 备份）；`remarks` 改名后导出版本为 **2**
- 导入**兼容 version 1**：旧文件里的 `remark` 字段自动读取为 `remarks`（旧备份不失效）
- 导入 = **数据恢复**：校验文件结构后**全量替换**（清空现有书签与管理表再写入），不做增量合并；同样**需输入主密码确认**（防恶意覆盖）。原"增量合并"语义作废
- 备份主路径 = 导出 JSON 提交本地 git；软链 LevelDB 目录可行但不推荐（二进制噪音、恢复脆弱）

### 安全模型（2026-10-14 修订）

- **主密码 + WebCrypto**：PBKDF2 派生密钥，AES-GCM 加密
- 密码字段与私密记录模板**加密后落盘**，密钥永不持久化
- **登录自动保存的明文暂存**（2026-10-20）：只存在 SW 内存 pending，不写 local/session storage、不进日志；保存即加密落盘并清 pending；弹窗模型不回传密码
- **Alt+P 锁定引导**（2026-10-18）：锁定状态按 Alt+P 打开/聚焦 wui 解锁页（已打开则聚焦，不 toggle 关闭）；解锁后回到登录页再按 Alt+P 继续填充。页面内嵌解锁浮层淘汰
- **解锁页三态自动路由**（同一页面，`isInitialized()` / `isUnlocked()` 判定）：
  - 未初始化 → 「创建主密码」模式（两次输入 + 忘记无法找回警示），创建即解锁进主页面
  - 已锁定 → 「解锁」模式，解密成功进主页面
  - 已解锁 → 直接进主页面
- 解锁策略：**浏览器重启必锁**；超时锁定**默认 0 = 不开启**（2026-10-14 修订，原默认 30 分钟），可配置
- **不提供"忘记密码"入口**（避免恶意清除数据）；重置方法（清除扩展存储）写入 README/docs/install.md
- 数据只能通过插件本身读取

### UI 载体（2026-10-14 改版）

- **wui 管理页**：`chrome.windows.create({type: 'popup'})`，页面设固定标题，由 **Hyprland windowrule**（匹配 initialTitle）实现浮动居中——Wayland 下窗口定位权在 compositor，Chrome 的 left/top 不可靠；解锁页与主页面**同尺寸**
- **设计系统**：Catppuccin Mocha（dark，默认）/ Latte（light）双主题 token，`design-system/tokens.css` 为唯一来源，`scripts/sync-tokens.py` 同步到各页面；组件样式只许引用 token 变量
- **解锁页**：中央为锁形图标 + 进度环（图标须语义明确可识别，不用抽象图形；2026-10-14 定稿），成功动画为锁扣弹开 + 涟漪过渡进入主页面；角落提供主题/语言切换（锁定态可用）
- **主题切换**（dark/light/system）与**中英双语**（zh/en，data-zh/data-en 属性）为页面级能力，偏好持久化到 meta:settings
- **用户名/密码生成器**：Settings→general 内置（单词组合 / 随机密码，长度与符号可配），纯前端
- Alt+P 二级菜单：登录页内 content script 浮层（登录页均为普通网站，无注入限制）

### wui 主页面布局（2026-10-17 定稿）

- 窗口默认 **1600×900**（原 1280×860）：加宽部分主要给 results，兼顾 tags/linkedInfos 的展示宽度
- 页面高度锁定为视口高度，**整页不滚动**；顶行工具栏固定，下区 Settings / results / contents 三块同高
- 三块各自内部滚动：书签多时只滚 results，Settings 与 contents 同理；results 表头在内部滚动时吸顶
- results 的基础信息列单行展示（书签名 / tags / linkedInfos 均不换行、不撑开表格）；内容超出单元格时在两侧裁切渐隐，悬停可查看完整内容。理由：多 tag、多关联信息时保持行高一致与全局视图

## 关键约束（Chrome 平台限制）

1. `Alt+←/→` 是 Chrome 保留的历史导航键，**扩展不可覆盖** → 组内切换改用 `Alt+Shift+←/→`
2. manifest 的 `suggested_key` **上限 4 个**，标签导航已用满 → `Alt+.` 和 `Alt+P` 需安装后在 `chrome://extensions/shortcuts` **手动绑定一次**（写入安装说明）
3. `Ctrl+Alt` 组合因 AltGr 冲突被禁止
4. content script 无法注入 `chrome://` 页面、新标签页、Web Store

## 风险项

- **R1**：`Alt+Shift+←/→` 能否绑定未经实测，文档未明确。第 0 里程碑验证，备选方案 `Alt+H/L`。

## 待定项（后续讨论后通过 spec-change 补充）

- TOTP 二步验证种子、密码历史（评估后缓办）
- 切组滚动动画的 UI 载体（第一版不做）

## 技术栈

- Chrome Extension **Manifest V3**
- **WXT + TypeScript**（MV3 脚手架、content script 打包、开发期 HMR）
- 加解密：WebCrypto API（浏览器原生，无依赖）
