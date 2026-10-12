# vipper 任务清单

> 跨会话进度事实源。每项标注验证方式。按里程碑分组，一个里程碑约等于一个会话的工作量。

## M0：项目骨架 + 快捷键实测

- [ ] 初始化 WXT + TypeScript 项目骨架（pnpm）
- [ ] manifest 声明 4 个导航命令（Alt+↑/↓、Alt+Shift+←/→）+ background `onCommand` 日志
- [ ] `pnpm build` 通过，产出 chrome-mv3 目录
- [ ] **实测**：加载扩展后 4 个键均能触发 `onCommand`（重点验证风险项 R1：Alt+Shift+←/→；不通过则 spec-change 改为 Alt+H/L）
  - 验证方式：chrome://extensions 加载 .output/chrome-mv3，打开 service worker 控制台，逐键观察日志

## M1：标签组导航（Alt+↑/↓）

- [ ] 组列表计算：当前窗口内按标签栏视觉顺序排列，散标签聚合为隐式组
- [ ] Alt+↑/↓ 切组：激活目标组上次活跃标签，不环绕
- [ ] 每组上次活跃标签记忆（chrome.storage.session）
- [ ] 切组后折叠其他组、展开目标组
- [ ] 验证：构造 3 组 + 散标签场景，实际按键验证全部语义

## M2：组内标签导航（Alt+Shift+←/→）

- [ ] 组内（含隐式组）左/右切换标签，不环绕
- [ ] 验证：实际按键验证

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
