# vipper 任务清单

> 跨会话进度事实源。已完成记录在 [tasks-archive.md](./tasks-archive.md)。
> 验证按 [verify.md](./verify.md) 分级执行：L0 typecheck + build + 最相关脚本 / L1 `pnpm verify:affected` / L2 全量（仅里程碑收尾，一轮一次）。
> 术语口径以仓库根目录 [GLOSSARY.md](../../../GLOSSARY.md) 为准。

## 当前状态

- 已完成：M0–M38（详见归档）、**M39 唯一性约束**（2026-11-18）；socket 功能设计定稿（[socket-access.md](./socket-access.md)，Q1–Q17 质询确认）
- 下一批里程碑：**M40 → M43**（socket 功能，一个里程碑一个会话，按序推进）

## 未完成

### M40 传输层 + host 骨架（socket-access.md §13）

- [ ] pnpm workspace 改造（`packages/vipper-host`、`packages/vipper-cli`）
- [ ] Transport 接口 + unix-socket 实现（Linux）、SO_PEERCRED 对端校验、帧格式（§4.3）
- [ ] **首验 X25519 两端可用性**（Chrome WebCrypto / Node webcrypto；不可用降级 P-256，§5.2）
- [ ] wxt.config.ts 给 manifest 钉固定 `key`（扩展 ID 固定，§10.1）
- [ ] `scripts/install-host.sh`（Native Messaging manifest 注册 Chrome + Chromium、Node ≥22 检查，§10.2）
- [ ] Native Messaging 接通扩展
- [ ] 验证：Linux 上 cli→host→扩展字节互通；异 UID 连接被拒；新增 m40 验证脚本并登记 verify-map.json

### M41 配对层

- [ ] X25519 配对握手、确认窗（`chrome.windows.create` 小窗）、配对存储（`chrome.storage.local`）
- [ ] X25519+HKDF+AES-GCM 加密通道（WebCrypto 纯实现）
- [ ] 待确认请求落 `chrome.storage.session`（SW 回收不丢）
- [ ] 验证：未配对请求全拒；弹窗确认后通道加密可用；删私钥文件需重新配对；新增 m41 验证脚本

### M42 授权层

- [ ] `socketExposure` 三态字段 + 客户端白名单（wui 编辑表单三态选择器）
- [ ] 寻址规则（条目路径，§6.2；`ambiguous` 防御分支）
- [ ] 令牌 TTL（`chrome.storage.session`，默认 8h 可配）、锁库清令牌、60s 超时默认拒绝、🔔 弹窗
- [ ] 验证：三态行为全部符合 §6；令牌过期续期身份不变；SW 回收后令牌不丢；新增 m42 验证脚本

### M43 cli 四模式 + 审计

- [ ] `vipper-cli get` / `vipper-cli run --` / fd 模式（socket-access.md §9）
- [ ] 审计日志（storage.local 滚动 1000 条）+ 管理页「已配对客户端」「审计日志」两小节
- [ ] release workflow 增加 host-cli tarball job（§10.3）
- [ ] 验证：git/msmtp 实战通过；审计可回放；新增 m43 验证脚本

## 待定

- M5 跨 OS（macOS 凭据 API、Windows named-pipe）：Linux 跑通前不动（socket-access.md §14）
- 方案 B（独立后端 daemon）：方向性备选，触发条件见 socket-access.md §1

## 使用约定

- 新里程碑：先在 spec.md 写决策与理由，再在下方新增未完成项；每项标注验证方式。
- 一个里程碑一个会话；完成即勾选，并在同一个 commit 收尾，然后建议用户新开会话。
- 不再逐里程碑记录"回归清单"：验证范围由 verify.md 的 L0/L1/L2 与 `scripts/verify-map.json` 决定，避免回归矩阵随里程碑数量膨胀。
- 已完成的项不原地改写；后续新情况作为新任务追加（历史留在归档里）。
