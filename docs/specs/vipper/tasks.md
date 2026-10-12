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

## M3：书签弹窗（Alt+.）

- [ ] 书签数据模型（多 URL + 多记录引用）与 storage.local 读写层
- [ ] Alt+. 呼出 popup 窗口；安装说明含手动绑键步骤与 Hyprland windowrule
- [ ] 弹窗 UI：搜索栏自动聚焦、关键字检索、↓ 进入条目区、方向键导航、回车在来源组打开（tabs.create + tabs.group）
- [ ] 验证：实际跑通 搜索→打开→进组 完整流程

## M4：凭据库与解锁

- [ ] 主密码设置/验证流程，PBKDF2 派生密钥（WebCrypto）
- [ ] AES-GCM 加密写入层：密码字段与私密记录加密落盘，密钥仅存 storage.session
- [ ] 锁定策略：重启锁定 + 30 分钟无操作锁定（时长可配置）
- [ ] 验证：单测（加解密往返、错误密码拒绝）+ 重启浏览器实测锁定

## M5：Alt+P 填充

- [ ] content script 登录表单探测与填充（兼容受控组件：原生 setter + input 事件）
- [ ] Alt+P 按当前 origin 匹配凭据并填充
- [ ] 多账号/多 URL 二级菜单（↑/↓ + 回车）
- [ ] 验证：真实登录页实测
