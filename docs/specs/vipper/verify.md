# vipper 验证策略（权威）

> 这份文件是验证范围的唯一事实源。`AGENTS.md`、skills 与 `docs/specs/vipper/tasks.md` 只引用它，不各自复述。
> 背景与数据：`tmp/vibe-coding-slow-analysis-2026-10-30.md`（2026-10-30 会话耗时分析）。

## 为什么分级

历史上"每次改动都跑全量回归"导致单轮 60%–100% 的时间在等测试（全量 26 个脚本，串行约 340s，冷启动抖动时更久）。
分级的目标是：**迭代期只花几十秒，里程碑收尾才为"全量"付一次费，同一轮绝不重复付。**

## 三级

| 级别 | 何时 | 命令 | 预算 |
|---|---|---|---|
| **L0** 迭代 | 每次逻辑改动后 | `pnpm typecheck && pnpm build` + **1 个**最相关里程碑脚本（`node scripts/verify-all.mjs m26`） | ≤60s |
| **L1** 里程碑收尾 | 一个里程碑实现完成、准备 commit 前 | `pnpm verify:affected`（按改动文件映射 2–10 个脚本） | ≤3min |
| **L2** 全量 | 跨 ≥3 个模块、改动映射退化为全量、或里程碑 commit 前的最终确认 | `pnpm verify`（= `node scripts/verify-all.mjs --jobs 4`） | ≤2min（并行） |

### 决策顺序

1. 改完一个逻辑单元 → L0（build + 最近的那个脚本）。
2. 把该里程碑剩余项做完、自查 diff → L1（`pnpm verify:affected` 会打印"哪些文件 → 哪些脚本"）。
3. L1 通过 → commit。只有跨模块改动或 L1 自己被判为"需要全量"时，才在 commit 前跑一次 L2。
4. **同一轮内已经通过的套件不重跑**；若必须重跑，先说明原因（例如中途又改了被验证的代码）。

## 命令速查

```bash
pnpm typecheck                 # 类型检查（L0 的一部分）
pnpm build                     # 构建 .output/chrome-mv3（验收前置）
pnpm verify:quick              # typecheck + build + 受影响脚本（日常默认）
pnpm verify:affected           # 只跑受 git 改动影响的里程碑（会打印映射理由）
pnpm verify                    # 全量，4 并发
pnpm verify:serial             # 全量，串行（排查并发干扰时用）
pnpm verify:list               # 只看 --affected 会选哪些脚本，不执行
node scripts/verify-all.mjs --changed entrypoints/wui/main.ts --list   # 预演映射
```

其他参数：`--jobs N`、`--timeout N`（单脚本超时秒）、`--json`（机器可读结果）、`--base <ref>`（对比基线，默认 `HEAD`）。

## 改动 → 里程碑映射

- 规则在 `scripts/verify-map.json`：`glob → 里程碑数组`，支持 `[]`（无 e2e 影响）、`"full"`（强制全量）、`"$script"`（改哪个 `scripts/mNN-verify.mjs` 就只跑 mNN）。
- 无法匹配、命中 `"full"`、或受影响数量超过 `maxAffected`（10）时，**保守退回全量**并在输出里说明原因。
- 新增里程碑验收脚本时，同步更新 `scripts/verify-map.json` 的 `all` 与 `patterns`；改 `scripts/lib/**` 会触发全量。

## 执行器保证

- 每个 worker 独立端口（`9333 + worker序号`）与独立 profile；验收脚本经 `VIPPER_CDP_PORT` 连接。
- 每个脚本独立硬超时（默认 60s）：挂起只算该里程碑失败，不拖垮整轮。
- 收尾杀进程组、等端口释放、删 profile；超时/失败会打印该脚本输出尾部。
- 输出每个脚本耗时与最慢 Top5；`--json` 给 agent 消费，避免大段日志进上下文。

## 禁止清单

- 禁止迭代循环里跑全量；禁止同一轮内重复跑同一套件"求安心"。
- 禁止用 `cat/sed/grep` 读验收脚本冒充"跑过验证"；证据必须是脚本实际执行输出。
- 禁止在 CI/本地各跑一遍全量来"双保险"（一个权威入口即可）。
- 全量单轮超过 ~5 分钟仍未结束：先报告现状（哪个脚本慢），而不是继续等或重跑。

## 失败处理

1. 看失败脚本的输出尾部 → 定位是断言失败还是环境问题（端口残留、Chromium 未就绪）。
2. 环境问题：重跑该里程碑脚本一次（`node scripts/verify-all.mjs <m>`）；仍失败再排查残留进程/端口。
3. 断言失败：按 debug-systematically 先复现、后改代码；修复后只重跑**该里程碑**，L1 阶段再跑受影响集合。
4. 修复了三轮仍失败：停下来向用户说明已排除项与下一步选项（不要继续盲目重跑）。

## 当前基线（2026-10-30 实测，工作树含验证改造）

- 全量 `--jobs 4`：26/26 通过，**50.9s**（旧串行 340.4s，约 6.7×）；单脚本最长 17.6s（m9d）。
- `--affected` 样例：改 `utils/tabnav.ts` → m1+m2（5.7s）；纯文档改动 → 0 个脚本（只 typecheck/build）。
- 单脚本典型 0.2–18s；`m26` 曾出现 181s 冷启动异常（旧 180s 超时线），故超时降到 60s 让异常快速暴露，而不是拖慢整轮。
- `pnpm typecheck && pnpm build`（增量）约 2–3s。
