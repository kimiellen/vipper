# vipper 任务清单

> 跨会话进度事实源。每项标注验证方式。按里程碑分组，一个里程碑约等于一个会话的工作量。

## M0：项目骨架 + 快捷键实测 ✅（2026-10-12）

- [x] 初始化 WXT + TypeScript 项目骨架（pnpm）
- [x] manifest 声明 4 个导航命令（Alt+↑/↓、Alt+Shift+←/→）+ background `onCommand` 日志
- [x] `pnpm build` 通过，产物 manifest 已核对 4 个命令齐全
- [x] **R1 绑定验证（自动化）**：Chromium 153 + CDP 实测 `chrome.commands.getAll()`，4 键全部绑定成功（含 Alt+Shift+←/→）
- [x] **R1 真机按键确认**：Chrome 154 真机实测 4 键全部触发 `onCommand`，Alt+Shift+←/→ 与历史导航无冲突。R1 关闭
  - 备注：品牌版 Chrome 154 已移除 `--load-extension`，自动化用 Chromium 153；手动验收需先开 SW DevTools 再按键

## M1：标签组导航（Alt+↑/↓）✅（2026-10-12）

- [x] 组列表计算：当前窗口内按标签栏视觉顺序排列，散标签聚合为隐式组（`utils/tabnav.ts`）
- [x] Alt+↑/↓ 切组：激活目标组上次活跃标签，不环绕
- [x] 每组上次活跃标签记忆（chrome.storage.session）
- [x] 切组后折叠其他组、展开目标组
- [x] 验证：`scripts/m1-verify.mjs` CDP 自动化验收 9/9 通过（场景：2 真实组 + 2 隐式组，覆盖顺序/记忆/边界/折叠）
  - spec 微调：隐式组按"连续未分组标签段"划分（被真实组隔断的散标签是不同隐式组），比"全局一个隐式组"更符合视觉顺序语义

## M2：组内标签导航（Alt+Shift+←/→）✅（2026-10-12）

- [x] 组内（含隐式组）左/右切换标签，不环绕、不跨组（`resolveTargetTab` 纯逻辑 + `switchTab`）
- [x] 验证：`scripts/m2-verify.mjs` 12/12 通过（隐式组/真实组/单标签组/四向边界）；M1 回归 9/9 通过
  - 顺带重构：CDP 驱动与测试场景抽取为 `scripts/lib/` 共享模块，消除 m1/m2 脚本重复

## M3：书签弹窗（Alt+.）✅（2026-10-12）

- [x] 书签数据模型（id/标题/多 URL）与 storage.local 读写层（`utils/vault.ts`）；记录字段留待 M4
- [x] Alt+. 呼出 popup 窗口（`open-launcher` 命令，无 suggested_key——配额已满）；安装说明 [docs/install.md](../../../docs/install.md) 含手动绑键步骤与 Hyprland windowrule
- [x] 弹窗 UI：搜索栏自动聚焦、关键字检索、↓ 进入条目区、方向键导航、回车打开（多 URL 书签进入二级菜单选 URL）、Esc 返回/关闭；回车经 background 在来源组打开（tabs.create + tabs.group）并自动关弹窗
- [x] 验证：`scripts/m3-verify.mjs` 8/8 通过（聚焦/过滤/钻取/入组/关窗）；M1 回归 9/9、M2 回归 12/12
- [ ] 待定（产品问题）：书签的**录入入口**未设计（当前只能靠测试脚本种子数据），后续讨论

## M4：凭据库核心 ✅（2026-10-13）

- [x] 存储布局重构：单 key 改为 idx / bm:<id> / arc:<id> / meta:* 拆分（launcher 改读 idx + lastUsedAt 降序），manifest 加 unlimitedStorage
- [x] 完整条目模型落地：基础信息（title/createdAt/updatedAt/lastUsedAt）、tags/linkedInfos 引用、urls 带 match 规则、accounts 带 label、records（note/secret）、remark、status
- [x] 主密码设置/验证流程，PBKDF2-SHA256 60 万次派生（`utils/keychain.ts` + `utils/crypto.ts` 纯函数层）
- [x] AES-GCM 加密写入层：`account.password` 与 `secret.content` 加密落盘（自描述 `$enc` 信封），密钥仅存 storage.session
- [x] 锁定策略：重启锁定（session 清空即锁）+ 惰性滑动超时锁（默认 30 分钟，meta:settings 可配）
- [x] 验证：`scripts/m4-verify.mjs` 15/15 通过；M1 回归 9/9、M2 回归 12/12、M3 回归 8/8
  - 注意：M3 前的 `vault:bookmarks` 单 key 数据不做迁移（仅开发期种子数据），m3-verify 种子改为走 vault API

## M5：Alt+P 填充 ✅（2026-10-13）

- [x] content script 登录表单探测与填充（原生 setter + input/change 事件，兼容受控组件）
- [x] Alt+P 按 match 规则匹配（host/exact/prefix；exact = origin+pathname，忽略 query/hash）
- [x] 多账号二级菜单（closed shadow DOM 浮层，↑/↓ + 回车，显示 label 或 username）；锁定状态浮层内输主密码解锁（错密码报错）
- [x] 明文凭据最小暴露：菜单只传展示名，选定后 SW 解密单条经消息过境；填充后更新 lastUsedAt
- [x] 验证：`scripts/m5-verify.mjs` 6/6 通过（内嵌 HTTP 登录页 + CDP Input 可信按键）；M1 9/9、M2 12/12、M3 8/8、M4 15/15 回归通过
  - 修复 M4 漏改：单 URL 书签打开误传 BookmarkUrl 对象（m3 回归捕获）
  - 增强：来源窗口/组失效时打开书签有兜底

## M6：书签编辑与管理 UI ✅（2026-10-13）

- [x] 书签编辑页（`editor.html`）：基础信息/tag 栏/关联信息栏/URL 区/账号区/记录区/备注区，分区布局与 spec 一致；锁定门控（未解锁先输主密码）
- [x] 管理表页（`manager.html`）：tag + 关联信息先建后选，重名/重值拒绝
- [x] launcher 列表：lastUsedAt 降序、favicon（`favicon` 权限 + `/_favicon/`）、打开时经 background 更新 lastUsedAt；Ctrl+E 编辑 / Ctrl+N 新建 / Ctrl+M 管理表
- [x] 验证：`scripts/m6-verify.mjs` 12/12 通过；M1-M5 全量回归通过；新增 `pnpm typecheck`（tsc 严格模式，修复存量类型错误）

## M7：归档 ✅（2026-10-13）

- [x] 手动归档/恢复（bm: ↔ arc: 数据迁移 + idx 状态更新，vault 层 archiveBookmark/restoreBookmark）
- [x] 自动归档：浏览器启动时 + 每日 alarm 扫描，lastUsedAt 超阈值（默认 180 天，meta:settings 可配）
- [x] 归档页：launcher?archive=1 独立窗口复用布局，Ctrl+A 进入、Ctrl+R 恢复；编辑页归档/恢复按钮
- [x] 验证：`scripts/m7-verify.mjs` 7/7 通过；M1-M6 全量回归通过

## M8：导入导出 ✅（2026-10-13）

- [x] 导出全量明文 JSON（管理页数据区，当场输主密码确认；含归档条目与管理表）
- [x] 导入 JSON 合并入库：同 id updatedAt 新者胜；tag/关联信息按名去重 + 引用 id 重映射；明文敏感字段重新加密落盘
- [x] 验证：`scripts/m8-verify.mjs` 10/10 通过（导出明文→清空→换主密码导入→解密一致；合并双向语义）；M1-M7 全量回归通过

## M9a：wui 设计原型补全 ✅（2026-10-14）

- [x] 解锁页原型：创建/解锁双模式自动路由、与主页面同尺寸、锁形图标 + 进度环动画（锁扣弹开 + 成功涟漪 + 错误抖动）、角落主题/语言切换
- [x] 编辑态原型（并入主原型 contents 区域）：✎ 原地切换编辑态，字段顺序与展示态一致，三个只读时间置底；urls 带 match 选择、accounts 带显隐+生成、records 分 note/secret
- [x] 验证：headless 截图自检（动画四态 × 双主题 × 双语、窄栏换行）+ 用户目检两轮（第一轮反馈：图标不可识别→锁形、编辑态原地化、时间置底，均已修复）

## M9b：数据层 spec-change 落地 ✅（2026-10-14）

- [x] tag 管理表加 `color`（Catppuccin 14 色，非法颜色拒绝）；关联信息表 `{id,type,value}` → `{id,name,value}`（重名/重值均拒绝）
- [x] accounts 删除 `label` 字段（Alt+P 二级菜单直接显示 username）；旧数据不迁移（开发期种子数据）
- [x] idx 索引加 `remark` 支持搜索（filterIndex 含旧数据兜底）；settings 默认值 0/0（getKey 0 跳过超时判定；autoArchive 0 短路）
- [x] 管理表删除查引用：被书签引用时拒绝并报引用数与条目标题
- [x] 验证：`scripts/m9b-verify.mjs` 8/8 通过；M1-M8 全量回归通过（m4 超时锁断言改为默认关闭+显式开启两态；m7 自动归档显式设阈值）
  - self-review 修复：content.ts 残留 label 注释；filterIndex 对旧 idx 无 remark 的 `?? ''` 兜底

> 影响面（2026-10-14 盘点）：
> - `utils/vault.ts`：`Account.label` 删除；`Tag` 加 color、`addTag(name,color)`；`LinkedInfo` 改 `{id,name,value}`、`addLinkedInfo(name,value)`、导入去重键 type+value→name+value；`deleteTag/deleteLinkedInfo` 加引用检查（扫 idx 的 tags/linkedInfos）；`IndexEntry` 加 remark、`toIndex` 同步、`filterIndex` 加 remark 匹配
> - `utils/keychain.ts`：`DEFAULT_SETTINGS` 30/180→0/0；`getKey` 中 `lockTimeoutMin===0` 跳过超时判定
> - `utils/vault.ts` `autoArchive`：`autoArchiveDays===0` 直接返回 []（否则 cutoff=now 会把全部条目归档——必须特判）
> - `entrypoints/background.ts:106`：Alt+P 候选 `a.label || a.username` → `a.username`
> - `entrypoints/editor/main.ts`：账号行删除 label 输入（此页 M9d 起被编辑模式取代，本里程碑仅保证编译通过）
> - `entrypoints/manager/main.ts`：linkedInfo 表单 type/value → name/value（同上，M9e 重建）
> - 种子/验证脚本：m3/m5/m8-verify 种子数据去 label；m4-verify 默认值断言改 0/0

## M9c：设计系统入库 + wui 页面骨架

- [ ] tokens.css / sync-tokens.py 从 tmp 正式入库（design-system/ + scripts/），抽共享 CSS 供各 entrypoint 引用
- [ ] wui 管理页三栏骨架：顶行（active/archived seg、搜索、TAGS/LINS 多选过滤、新增按钮）+ Settings/results/contents
- [ ] results 接通真实数据：favicon 首列、lastUsedAt 降序、时间格式化、tag 彩色渲染；contents 只读详情（secret 遮蔽）
- [ ] 验证：`scripts/m9c-verify.mjs`（CDP）；M1-M8 回归通过

## M9d：解锁页 + 入口切换

- [ ] 解锁页实现：三态自动路由（isInitialized/isUnlocked）、PBKDF2 进度环动画、错误反馈；角落主题/语言切换
- [ ] Alt+. 改指向 wui 页（来源标签记录保留）；"回车在来源组打开 + 多 URL 二级菜单"从 launcher 移植到 results
- [ ] 淘汰 launcher / editor / manager 旧页面；重置方法（清扩展存储）写入 README/docs/install.md
- [ ] 验证：`scripts/m9d-verify.mjs`（锁定→解锁→进主页面→回车打开入组）；M1-M8 回归通过

## M9e：编辑模式 + Settings 完成

- [ ] 编辑模式表单实现：保存/取消、status 切换归档、urls/accounts/records 行增删、match 选择；tag/linkedInfo 选择器（先建后选）
- [ ] Settings 手风琴：tag/linkedInfo 管理（含 color 选择、引用拒绝删除）、超时锁定/自动归档天数配置、导入导出迁入（主密码确认）
- [ ] 用户名/密码生成器（长度/符号可配，纯前端）；主题 dark/light/system 与 zh/en 双语切换持久化到 meta:settings
- [ ] 验证：`scripts/m9e-verify.mjs`；M1-M8 全量回归通过
