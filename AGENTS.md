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
