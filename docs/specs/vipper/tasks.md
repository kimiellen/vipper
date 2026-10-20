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
- [x] ~~待定（产品问题）：书签的**录入入口**未设计~~ 已由 M9 解决：wui 管理页「＋ 新增书签」+ contents 编辑态（2026-10-14）

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

> ⚠️ 2026-10-15 spec-change：导入语义由"增量合并"改为**全量恢复**（校验结构→清空→写入 + 主密码确认），上述合并语义作废，m8-verify 同步重写。历史记录保留不删。

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

## M9c：设计系统入库 + wui 页面骨架 ✅（2026-10-14）

- [x] tokens.css / sync-tokens.py 正式入库（`design-system/` + `scripts/`），sync 目标改为 `docs/design/prototypes/` + `entrypoints/`（递归）；token 块按设计系统约定内联进 html（@tokens 标记），旧入口无标记仅告警（M9d 淘汰）
- [x] wui 管理页三栏骨架（`entrypoints/wui/`）：顶行（active/archived seg、搜索、TAGS/LINS 多选过滤 AND 语义、新增按钮 M9e 接线）+ Settings 手风琴骨架（真实设置值与 tag/link 只读列表，交互 M9e）+ results + contents
- [x] results 接通真实数据：favicon 首列、lastUsedAt 降序、时间格式化置底、tag 按 color 彩色渲染（color-mix + cat 变量）；contents 只读详情（password/secret 遮蔽、⧉ 复制真实值、无明文泄漏）
- [x] idx 索引加 `accountCount`（仅计数，列表「账号数」列需要；spec 存储布局已同步）
- [x] 验证：`scripts/m9c-verify.mjs` 11/11 通过；M1-M8 + M9b 全量回归通过

## M9d：解锁页 + 入口切换 ✅（2026-10-14）

- [x] 解锁门控（wui 页内覆盖层，与主页面同尺寸同窗口）：三态自动路由（isInitialized/isUnlocked），创建/解锁双模式，PBKDF2 进度环 + 锁扣弹开 + 涟漪动画 + 错误抖动；角落主题/语言切换（锁定态可用，持久化在 M9e）
- [x] Alt+. 改指向 wui 页（来源标签记录保留）；键盘自 launcher 移植：↓ 进列表、↑/↓ 移动、回车打开（多 URL 弹二级菜单）、Esc 关窗
- [x] 淘汰 launcher / editor / manager 旧页面（m3/m6/m7 验证脚本随页面退役删除；行为由 m9c/m9d 覆盖）；忘记密码重置方法写入 docs/install.md（清除扩展数据），windowrule 尺寸更新为 1280x860
- [x] 验证：`scripts/m9d-verify.mjs` 12/12 通过（创建/解锁/直达三态 + 键盘打开入组 + 自动关窗）；M1/M2/M4/M5/M8/M9b/M9c 回归通过
  - 踩坑：headless Chromium 有 popup 窗口在场时 `tabs.group` 必失败的 quirk——background 改为先关 wui 窗口再入组（真机顺序无关）；m9d 场景搭建须在任何 popup 打开前完成分组

## M9e：编辑态 + Settings 完成 ✅（2026-10-14）

- [x] contents 编辑态：✎/新增书签原地切换，字段顺序与展示态一致（title→tags→linkedInfos→urls→accounts→records→remark→status→只读时间置底）；urls/accounts/records 行增删、match 选择、密码显隐/生成、tag/linkedInfo 选择器（先建后选 chips+下拉）；保存/取消/Esc；删除带 confirm
- [x] Settings：tags/linkedInfos 管理（颜色选择、行内编辑、引用拒删提示）；超时锁定/自动归档天数保存（0=关闭）；用户名/密码生成器（`utils/generator.ts`，规则持久化）；主题 dark/light/system 与 zh/en 双语切换持久化到 meta:settings（解锁页角落同步生效）
- [x] 备份迁入：导入 JSON 合并、导出需当场主密码确认
- [x] vault 补充 updateTag / updateLinkedInfo（重名重值拒绝，排除自身）
- [x] 验证：`scripts/m9e-verify.mjs` 17/17 通过；全量回归 m1/m2/m4/m5/m8/m9b/m9c/m9d 通过（m9c 的 Settings 断言随表单化更新）
  - 未做（YAGNI）：backup 组的"上次导出时间"展示（需额外存储字段，原型有但未入 spec）

## M10：wui 主页面固定高度 + 加宽（2026-10-17）

- [x] 页面锁定视口高度、整页不滚动；Settings / results / contents 三块同高，各自内部滚动（results 表头吸顶）
- [x] 窗口默认尺寸 1280×860 → 1600×900（`background.ts` + `docs/install.md` windowrule）
- [x] results 固定列宽：加宽书签名/tags/linkedInfos 列；内容超出时单元格两侧渐隐裁切，不换行、不撑宽表格；悬停显示完整内容
- [x] 验证：新增 `scripts/m10-verify.mjs` 14/14 通过（页面/三块无整页滚动、内部滚动、列宽与单行裁切、表头吸顶、Settings/contents 内部滚动）+ 截图自检 + `pnpm typecheck`/`pnpm build` + m9c（11/11）/m9d（15/15）/m9e（20/20）回归

## M11：备注字段改名 remark → remarks（2026-10-17）

- [x] 数据模型 / 索引 / UI 字段统一为 `remarks`；contents 展示态与编辑态标签同步
- [x] 旧数据自动迁移：首次访问把 `idx`、`bm:`、`arc:` 的 `remark` 改名为 `remarks`，完成后写 `meta:migrations` 标记
- [x] 导出格式升到 version 2（使用 `remarks`）；导入兼容 version 1 的 `remark` 字段
- [x] 同步 keeper 转换器、设计原型标签
- [x] 验证：`scripts/m11-verify.mjs` 8/8 通过（迁移 / v1 导入 / UI 标签）+ keeper 转换器 191 条烟测 + `pnpm typecheck`/`pnpm build` + m4/m5/m8/m9b/m9c/m9d/m9e/m10 全量回归通过

## M12：搜索支持中文首拼与全拼 ✅（2026-10-18）

- [x] 引入 pinyin-pro；新建 `utils/search.ts`：直接子串匹配 + title/remarks 的首拼/全拼匹配，查询与拼音串统一小写去标点，按文本记忆化
- [x] 从 `utils/vault.ts` 移除 `filterIndex`，wui 改由 `utils/search` 接线，确保 pinyin-pro 不进 service worker 包
- [x] 搜索框 placeholder / wui 文件头注释补充拼音提示（中英）
- [x] 新增 `scripts/m12-verify.mjs`（tb/taobao、yh/yinhang、cq/chongqing、cc/changcheng、cs/changsha、remarks、url、归一化、空查询排序）；更新 m9b/m11 中失效的 `__vipper.vault.filterIndex` 断言
- [x] 验证：`scripts/m12-verify.mjs` 26/26 通过 + m9b 8/8、m9c 11/11、m10 15/15、m11 8/8 回归 + `pnpm typecheck` / `pnpm build`（background 13.47 kB、wui chunk 323.77 kB，词典未进 SW）

## M13：Alt+P 填充反馈动画（2026-10-18）

- [x] 新增 `assets/fill-animation.css`：`.vipper-animated-fill` 跑 `vipperfill` keyframes（200ms，scale 1→1.2→1），`prefers-reduced-motion: reduce` 时 `animation: none`；由 content script 引入，经 manifest 注入页面
- [x] `entrypoints/content.ts`：填充后给实际写入的字段加类、200ms 后移除（不用 `animationend`，减少动效下也能清理）；不新增设置项
- [x] 验证：`scripts/m13-verify.mjs` 18/18 通过（类出现与移除、`getAnimations()` 动画名/时长、动画中点 transform 放大、多账号菜单路径、减少动效降级）+ m5 6/6 回归 + `pnpm typecheck` / `pnpm build`（产物 manifest 含 content CSS）

## M14：填充动画改为账号→密码顺序播放（2026-10-18）

- [x] `entrypoints/content.ts`：账号字段填入并完成 200ms 弹跳后，再填入密码并触发密码弹跳；动画结束后重新探测密码框（防站点在用户名输入后替换/渲染密码框）；`prefers-reduced-motion: reduce` 时跳过等待、两者同时填入
- [x] 更新 `scripts/m13-verify.mjs`：正常模式断言两字段动画类加入时间差 ≥180ms，减少动效模式断言时间差 <50ms；保留原有动画名/时长/transform/清理断言
- [x] 验证：`scripts/m13-verify.mjs` 22/22 通过（新增：账号动画结束后才加密码动画类、间隔 ≥180ms；减少动效下两字段同时填入）+ m5 6/6 回归 + `pnpm typecheck` / `pnpm build`

## M15：填充逐字输入动画（2026-10-18）

- [x] `entrypoints/content.ts`：新增逐字写入（每字 20ms、单字段 1000ms 预算自动压缩），逐字完成后才弹跳；账号逐字→弹跳→重新探测密码框→密码逐字→弹跳；减少动效时跳过逐字、一次性写入
- [x] 收到 `vipper:fill` 时先关闭浮层，避免解锁框/菜单盖住逐字过程
- [x] 扩展 `scripts/m13-verify.mjs`：断言中间值递增、弹跳在输入完成后、密码逐字在账号弹跳结束后、减少动效每字段仅 1 次 input；保留动画名/时长/transform/清理与顺序断言
- [x] 验证：`scripts/m13-verify.mjs` 28/28 通过（逐字中间值递增、弹跳在输入完成后、密码逐字在账号弹跳后开始、减少动效每字段仅 1 次 input）+ m5 6/6 回归 + `pnpm typecheck` / `pnpm build`

## M16：Alt+P 锁定引导 + 旧页面补注入（2026-10-18）

> spec-change：M5 的「锁定状态浮层内输主密码解锁」作废，改为打开/聚焦 wui 解锁页；历史记录保留。

- [x] manifest 加 `scripting` 权限与 `<all_urls>` host 权限；`safeSend` 识别无接收方后 `insertCSS` + `executeScript` 补注入 content script，再按 100ms 间隔重试至监听就绪（最多 5 次）
- [x] 锁定态 Alt+P 打开/聚焦 wui（不 toggle）；删除 content 侧解锁浮层、`vipper:locked` / `vipper:unlock` / `vipper:unlock-failed` 链路
- [x] 更新 `scripts/m5-verify.mjs` 锁定场景：锁定按 Alt+P 弹 wui → 解锁 → 再按 Alt+P 可填充
- [x] 新增 `scripts/m16-verify.mjs`：启动时不加载扩展，先打开登录页，再通过 CDP `Extensions.loadUnpacked` 动态加载（`runtime.reload()` 在 headless 下会禁用扩展，弃用）；断言消息失联后自动补注入并完成填充（含动画 CSS）
- [x] 验证：m16 9/9、m5 7/7、m9d 15/15、m13 28/28 回归 + `pnpm typecheck` / `pnpm build`

## M17：Alt+P 支持跨域 iframe 登录表单（2026-10-18）

> 起因：163 邮箱登录表单在 `dl.reg.163.com` 跨域 iframe 内，顶层 content script 的 `document.querySelector` 看不到字段，Alt+P 误报「未找到登录表单」。

- [x] content script 改为 `allFrames: true`；登录字段选择器抽到 `utils/loginForm.ts`，content script 与 SW 探测共用
- [x] SW 用 `chrome.scripting.executeScript({ allFrames: true })` 探测承载表单的 frame（可见密码框优先，其次可见账号框），`tabs.sendMessage` 带 `frameId` 定向填充；旧标签页补注入也按目标 frame 进行
- [x] 账号菜单/失败提示固定发往 frame 0（顶层），避免多 frame 重复浮层
- [x] 字段探测只认可见输入框：163 的登录 iframe 里有一个 0 尺寸诱饵密码框，隐藏字段不参与定位/填充
- [x] 新增 `scripts/m17-verify.mjs`：跨域 iframe 登录页完成填充（单账号直填 + 多账号菜单路径 + 诱饵密码框不填充）
- [x] 验证：m17 11/11、m5 7/7、m16 9/9、m13 28/28 回归 + 真站 mail.163.com 实测可见账号/密码框填充成功（诱饵框为空）+ `pnpm typecheck` / `pnpm build`

## M18：Alt+P 在定时器节流时降级为整段写入（2026-10-19）

> 现象：阿里云登录（登录表单位于 `passport.aliyun.com` 跨域 iframe）偶发 1 秒/字的逐字填充；Chrome 对不可见跨域 iframe 会把 `setTimeout` 钳到约 1 秒（M17 已实测：iframe 完全滚出视口时 1000ms/次，视口内 20ms/次）。

- [x] content script 记录逐字间隔的实际耗时；超过「设定值 + 120ms」判定为定时器被节流，本字段剩余部分与后续字段直接整段写入
- [x] 账号→密码之间的 200ms 弹跳等待同样做节流检测；已判定节流时跳过等待
- [x] 扩展 `scripts/m17-verify.mjs`：iframe 完全滚出视口（与视口交集为 0）的场景断言 2.5s 内完成填充
- [x] 验证：m17 14/14、m5 7/7、m16 9/9、m13 28/28 回归 + 真站阿里云登录 iframe 滚出视口后 220ms 完成填充 + `pnpm typecheck` / `pnpm build`

## M19：Alt+P 账号框按密码框上下文定位（2026-10-19）

> 现象：Steam 登录页（store.steampowered.com）的账号框没有 name/id/placeholder 语义，旧逻辑回落到页面第一个文本框，用户名填进页头搜索栏；密码框正常。共性问题是账号框探测与密码框位置无关。

- [x] content script 拆分 `findPassword` / `findUsername`；存在密码框时，账号框优先取同一 form 内、DOM 上紧邻密码框之前的可见文本框；`autocomplete=username/email` 仍最高优先
- [x] 新增 `scripts/m19-verify.mjs`：Steam 同款 DOM（搜索框在 form 外 + 账号框无语义）、无 form 版本、带 `name=username` 版本；断言搜索框不被填充
- [x] 验证：m19 8/8、m5 7/7、m13 28/28、m16 9/9、m17 14/14 回归 + 真站 Steam 实测（搜索框为空、账号/密码填入）+ 163/阿里云真站回归 + `pnpm typecheck` / `pnpm build`

## M20：Alt+P 二级菜单接管焦点（跨域 iframe 键盘）（2026-10-20）

> 现象：Apple ID 登录（表单位于 `idmsa.apple.com` 跨域 iframe）弹出账号菜单后，↑/↓/回车无效。焦点仍在 iframe 的账号框内，键盘事件不会到达顶层 document 的菜单监听器。

- [x] `showPicker` 的 panel 设为可聚焦并 `focus()`；关闭菜单（选定/Esc）时把焦点还给打开前的 `document.activeElement`（通常是 iframe 元素，浏览器会恢复其内部焦点）
- [x] 扩展 `scripts/m17-verify.mjs`：焦点在跨域 iframe 内时，菜单展示、接管顶层焦点、↓+Enter 完成选择并填充
- [x] 验证：m17 18/18、m19 8/8、m5 7/7、m13 28/28、m16 9/9 回归 + 真站 Apple 实测焦点在 iframe 内时 ↓+Enter 填充第 2 个账号 + `pnpm typecheck` / `pnpm build`

## M21：wui TAGS/LINS 过滤选择会话内记忆（2026-10-20）

> 起因：Alt+. 关窗再开会重新创建 wui 页面，TAGS/LINS 过滤选择丢失；希望重新唤醒后仍是上次的过滤视图。spec 决策见「交互流程」第 1 条。

- [x] TAGS/LINS 选中项写入 `chrome.storage.session`（`ui:wuiFilters`）：关窗重开/页面重载恢复，浏览器重启复位；不恢复搜索词与 active/archived
- [x] 恢复时按当前 tag/linkedInfo 表剔除已删除的 id，避免残留过滤把结果全部隐藏
- [x] 新增 `scripts/m21-verify.mjs`：选中后关窗重开仍保持、取消后重开仍为空、失效 tag 被剔除、状态只落 session 不落 local
- [x] 验证：`scripts/m21-verify.mjs` 11/11 通过（关窗重开保持勾选与结果、取消后保持空、已删除 tag 被剔除、状态只落 session）+ m9c 11/11、m9d 15/15、m10 15/15、m12 26/26 回归 + `pnpm typecheck` / `pnpm build`

## M22：登录提交自动保存——捕获 + 新建条目（2026-10-20）

> spec 见「登录提交自动保存」（2026-10-20 定稿）。本里程碑接通无匹配条目的新建链路；有匹配条目时静默不弹，追加由 M23 接上。

- [x] content：capture 阶段监听 form submit / 密码框回车 / 提交类按钮点击，读取可见账号 + 密码；过滤空值、≥2 可见密码框（注册/改密）、同 frame 刚自动填充未改；2s 内相同凭据去重
- [x] content：SPA 无导航时提交后 1s 请求推送；新增右上角保存浮卡（独立 shadow host、标题可编辑、TAG/LINS 多选、Esc/✕ 丢弃），样式 `?inline` 引入 tokens.css 并 `:root → :host`，跟随主题 / 语言
- [x] SW：按 tabId 内存 pending（不落 storage、不进日志），动态注册 `tabs.onUpdated` 在目标 tab 导航完成后推送 frame 0；捕获 / 推送两处检查锁定；另加 1.2s 兜底推送（spec 已补注，覆盖导航先于监听注册的竞态）
- [x] SW：无匹配条目判定 + 新建保存（顶层 URL + match host，过滤失效 tag/link id，更新 lastUsedAt），保存 / 丢弃后清 pending 并注销 listener
- [x] 新增 `scripts/m22-verify.mjs`：无条目弹窗与字段、保存后密文落盘 / 索引正确、锁定不弹、改密表单不弹、填充未改不弹、重复提交只弹一次
- [x] 验证：`scripts/m22-verify.mjs` 52/52 通过（跳转推送、SPA 1s 自取 + 双提交去重、无 form 点击捕获、锁定 / 改密 / 填充未改不弹、pending 不落 storage、保存密文可解密、浮卡 zh/dark、light+en 文案与浅色背景、TAG 下拉） + m5 7/7、m13 28/28、m16 9/9、m17 18/18、m19 8/8 回归 + `pnpm typecheck` / `pnpm build` + 浮卡 / TAG 下拉 / 浅色英文截图自检

## M23：登录提交自动保存——追加 + 多匹配 + 跨 frame/SPA（2026-10-20）

- [x] SW：有匹配且所有条目不含该 username → 追加弹窗（多匹配返回候选，默认 lastUsedAt 最新）；任一匹配条目已含该 username → 静默
- [x] content：追加态浮卡（目标条目下拉 + 账号 / 密码），所选条目 id 回传并由 SW 校验；单条目也显示下拉便于确认目标（spec 已补注）
- [x] SW：追加保存（保留既有密文账号，新密码加密落盘；更新 lastUsedAt）；保存前重新校验条目仍匹配、username 仍不存在
- [x] 覆盖跨域 iframe（捕获在 frame、弹窗在顶层、URL 取顶层）与 SPA（preventDefault + pushState）场景
- [x] 新增 `scripts/m23-verify.mjs`：新账号追加、同 username 静默、多条目切换后追加、跨域 iframe、SPA、click + submit 去重、en 文案
- [x] 抽取 `scripts/lib/login-capture.mjs` 共享验收驱动，m22 同步改用（消除两份页面探针/操作副本）
- [x] 修复浮卡并发推送竞态：导航完成 / 页面 1s 自取 / SW 1.2s 兜底三路可能并发，入口立即置 `prompted`，只推一次
- [x] 验证：`scripts/m23-verify.mjs` 36/36 通过 + m22 52/52（refactor 后回归）、m5 7/7、m13 28/28、m16 9/9、m17 18/18、m19 8/8 + `pnpm typecheck` / `pnpm build` + 追加浮卡截图自检
