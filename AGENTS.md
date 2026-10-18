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

- feature 级决策记录在 `docs/specs/vipper/spec.md`，跨会话进度在 `docs/specs/vipper/tasks.md`
- 方向性变更：先改 spec，再改代码（spec-change 协议）
- 每个里程碑完成后立即 commit，一个 commit 只做一件事

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
- 真机按键行为（快捷键冲突等）无法自动化，需用户在 Chrome 中手动验收
- 手动验收按键时：必须先打开 vipper 卡片的 Service Worker DevTools 再按键——SW 30 秒休眠会断开控制台，断开后按键日志不可见（M0 已踩过此坑）
