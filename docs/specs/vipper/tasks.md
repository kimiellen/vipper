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

## M6：书签编辑与管理 UI

- [ ] 书签编辑页：基础信息区 / tag 栏 / 关联信息栏 / URL 区 / 账号区 / 记录区 / 备注区（分区布局见 spec）
- [ ] tag 管理表 + 关联信息表的管理页（先建后选，不即输即建）
- [ ] launcher 列表：按 lastUsedAt 降序、显示 favicon、打开/填充时更新 lastUsedAt
- [ ] 验证：m6-verify.mjs + 手动 UI 验收

## M7：归档

- [ ] 手动归档/恢复（bm: ↔ arc: 数据迁移 + idx 状态更新）
- [ ] 自动归档：lastUsedAt 超阈值（默认 180 天，meta:settings 可配）
- [ ] 归档页：复用 launcher 布局（archive 模式）
- [ ] 验证：m7-verify.mjs

## M8：导入导出

- [ ] 导出全量明文 JSON（需主密码确认）
- [ ] 导入 JSON 合并入库
- [ ] 验证：m8-verify.mjs（导出→清空→导入→数据一致）
