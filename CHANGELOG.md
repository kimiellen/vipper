# Changelog

本项目所有值得注意的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

从 `0.2.0` 起，本文件由 [release-please](https://github.com/googleapis/release-please) 依据
Conventional Commits 自动维护，**不要手写版本段落**；`0.1.0` 及以下为人工基线。

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
