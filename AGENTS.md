# vipper 项目约定

Chrome MV3 扩展：标签管理器 + 书签/密码管理器。面向 Hyprland（Wayland）桌面。

## 技术栈

- Chrome Extension Manifest V3
- WXT + TypeScript
- 加解密只用 WebCrypto API，不引入第三方加密库
- pnpm 作为包管理器

## 代码红线

- 凭据、私密记录**绝不**明文写入任何持久存储；加密后落盘，密钥不持久化
- 不为"以后可能用到"写代码（YAGNI）；同一逻辑不写第二遍（DRY）
- service worker 随时可能被回收：不依赖内存态，会话状态用 `chrome.storage.session`

## 文档纪律

- feature 级决策记录在 `docs/specs/vipper/spec.md`，跨会话进度在 `docs/specs/vipper/tasks.md`；已完成里程碑归档在 `docs/specs/vipper/tasks-archive.md`（不必每会话通读）
- 验证范围/分级见 `docs/specs/vipper/verify.md`（权威）；不要在本文件或 skills 里另写一套
- 方向性变更（含任何 `spec.md` 修改）：先经用户确认（spec-change 协议），再改文档，最后改代码
- 每个里程碑完成后立即 commit，一个 commit 只做一件事
- 临时探针脚本/截图放 `tmp/` 或复用 `scripts/lib/`，会话结束前删除；不把一次性脚本留在仓库

## 版本与发版

- 版本只改 `package.json` 的 `version`（WXT 写进 manifest）；`CHANGELOG.md` 由 release-please 生成，**不手写版本段落**（例外：0.1.0 首版为人工基线）
- 日常照常提交，用 Conventional Commits；破坏性变更必须带 `!` 或 `BREAKING CHANGE:` footer，并在 release notes 里补迁移说明
- 发版 = 合并机器人开的 release PR（release-please）→ 自动打 `vX.Y.Z` tag、建 Release，同 workflow 第二个 job 构建并上传 `vipper-<version>.zip` + `.sha256`
- 首次引导（一次性，仅 0.1.0）：`git tag -a v0.1.0 -m "vipper 0.1.0"` 与 main 一起 push → `pnpm build` 后把 `.output/chrome-mv3` 打成**以扩展根为根**的 zip（沙箱无 `zip`，用 `python3` zipfile 按 relpath 逐条写入）+ `sha256sum` → `gh release create v0.1.0 vipper-0.1.0.zip vipper-0.1.0.zip.sha256 --title v0.1.0 --notes-file <(从 CHANGELOG 摘 0.1.0 段)`；0.2.0 起全自动
- 仓库设置需允许 Actions 创建 PR（Settings → Actions → Allow GitHub Actions to create and approve pull requests），否则 release-please 开不了 PR
- CI 只跑 L0（typecheck + build + 打包）；Chromium 验证仍按 `docs/specs/vipper/verify.md` 在本地执行
- **不要**给 `package.json` 加 `packageManager` 字段：pnpm 12 会据此自装 pnpm 并重写 `pnpm-lock.yaml`（沙箱里会写出重复 `importers:` 的坏文件）；pnpm 版本钉在 workflow 的 `pnpm/action-setup` 里

## 自动化测试回路（Agent 沙箱环境）

品牌版 Chrome ≥137 已移除 `--load-extension`，自动化验证用 **Chromium**：

```bash
# 沙箱内 HOME 只读，必须给 chromium 指一个可写 HOME
HOME=$PWD/.fake-home chromium --headless=new \
  --user-data-dir=$PWD/.chrome-test-profile \
  --load-extension=$PWD/.output/chrome-mv3 \
  --remote-debugging-port=9333 --no-first-run --no-default-browser-check about:blank
```

- MV3 service worker 是事件驱动的，headless 下 target 不可见时用浏览器级 CDP `Target.setDiscoverTargets` 发现
- `scripts/m16-verify.mjs` 是特例：启动时**去掉** `--load-extension`、追加 `--enable-unsafe-extension-debugging`；脚本先打开登录页，再用 CDP `Extensions.loadUnpacked` 加载扩展，用于验证旧页面补注入
- 沙箱内 `pnpm add` 需要 `--store-dir=$PWD/.pnpm-store`
- **验证分级（详见 `docs/specs/vipper/verify.md`）**：
  - L0 每次逻辑改动：`pnpm typecheck && pnpm build` + 1 个最相关里程碑脚本（≤60s）
  - L1 里程碑收尾：`pnpm verify:affected`（打印"文件 → 脚本"映射，≤3min）
  - L2 全量：`pnpm verify`（`--jobs 4`），仅 commit 前或跨 3+ 模块；同一轮只跑一次，不重复跑已通过的套件
- `scripts/verify-all.mjs` 每个脚本独立 Chromium 进程组 + 独立 profile + 60s 硬超时，输出每脚本耗时；`--jobs N` 并行（端口 `9333+N`，脚本读 `VIPPER_CDP_PORT`）
- 真机按键行为（快捷键冲突等）无法自动化，需用户在 Chrome 中手动验收
- 手动验收按键时：必须先打开 vipper 卡片的 Service Worker DevTools 再按键——SW 30 秒休眠会断开控制台，断开后按键日志不可见（M0 已踩过此坑）
