# Changelog

本项目所有值得注意的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

从 `0.1.1` 起，本文件由 [release-please](https://github.com/googleapis/release-please) 依据
Conventional Commits 自动维护，**不要手写版本段落**；`0.1.0` 为人工基线。

## [0.2.0](https://github.com/kimiellen/vipper/compare/v0.1.1...v0.2.0) (2026-11-20)


### Features

* **socket:** M40 传输层 + host 骨架（cli→host→扩展字节互通） ([b45aa00](https://github.com/kimiellen/vipper/commit/b45aa00be5869fc8f0ffe0b5e0cb663912b4fc07))
* **socket:** M41 配对层（X25519 握手 + 确认窗 + 加密通道） ([888cb27](https://github.com/kimiellen/vipper/commit/888cb27d61c592c8cc6c53cdc6b1f6aeb2190494))
* **socket:** M42 授权层（三态策略 + 寻址 + 令牌 TTL + 🔔 弹窗） ([25826d2](https://github.com/kimiellen/vipper/commit/25826d2164c090f7de937521f0267b5dca31790d))
* **socket:** M43 cli 四模式 + 审计（get/run + 审计日志 + 管理页 + tarball） ([6ea4cba](https://github.com/kimiellen/vipper/commit/6ea4cba82ecfce061f1d0e7de420eee093ade3b0))
* **vault:** M39 唯一性约束（socket 寻址前置） ([d14283d](https://github.com/kimiellen/vipper/commit/d14283d8f50d4e5372da741be29bc3394eae4e7d))
* **wui:** 私密记录详情展示 socket 条目路径并支持复制 ([013b85c](https://github.com/kimiellen/vipper/commit/013b85ce975935cc9589fad0c03fa0949eeb2713))


### Bug Fixes

* **groups:** 选中（展开）即记录 lastOpened，重开视图落在最后展开的组 ([ff32085](https://github.com/kimiellen/vipper/commit/ff320858b97300d627bac85b4e9b085a239efc55))
* **install:** 安装脚本把 vipper-cli 链入 ~/.local/bin ([a73a7f8](https://github.com/kimiellen/vipper/commit/a73a7f81f9e2aedcfcab51b232761426ab67e591))

## [0.1.1](https://github.com/kimiellen/vipper/compare/v0.1.0...v0.1.1) (2026-11-01)


### Bug Fixes

* **release:** tag 格式统一为 vX.Y.Z，修复 release-please 认不到 v0.1.0 ([73d84f4](https://github.com/kimiellen/vipper/commit/73d84f4ae1dc892daaebcd80d8d92148128f43ac))

## [0.1.0] - 2026-11-01

首个可用版本：Chrome MV3 扩展 vipper —— 标签管理器 + 书签/密码管理器，面向 Hyprland（Wayland）桌面。

### Added

- 标签管理器：二维导航（`Alt+H/L` 切组、`Alt+J/K` 组内切换、`Alt+.` 开合管理窗口），chips 组栏与短按/长按拖动排序
- 书签与密码管理器：WebCrypto 加解密、密钥不持久化、`Alt+P` 打开管理页；拼音首拼/全拼检索
- 标签组管理页：chips 排序、组编辑/删除（页面内确认弹窗）、新建组打开即聚焦，与浏览器 `tabGroups` 双向同步
- 备份：全量恢复（主密码确认、兼容 v1 备份）、浏览器原生书签追加导入、备份手风琴面板
- 文档与安装：中文/英文 README、Hyprland 窗口规则与快捷键绑定手册
