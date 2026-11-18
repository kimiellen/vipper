# vipper 任务清单

> 跨会话进度事实源。已完成记录在 [tasks-archive.md](./tasks-archive.md)。
> 验证按 [verify.md](./verify.md) 分级执行：L0 typecheck + build + 最相关脚本 / L1 `pnpm verify:affected` / L2 全量（仅里程碑收尾，一轮一次）。
> 术语口径以仓库根目录 [GLOSSARY.md](../../../GLOSSARY.md) 为准。

## 当前状态

- 已完成：M0–M38（详见归档）、**M39 唯一性约束**、**M40 传输层 + host 骨架**、**M41 配对层**、**M42 授权层**（2026-11-18）；socket 功能设计定稿（[socket-access.md](./socket-access.md)，Q1–Q17 质询确认）
- 下一批里程碑：**M43**（socket 功能收尾：cli 四模式 + 审计，一个里程碑一个会话）

## 未完成

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
