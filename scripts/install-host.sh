#!/usr/bin/env bash
# vipper host 一次性安装（socket-access.md §10.2）：
#   1. 检查 Node.js ≥ 22（crypto.webcrypto X25519 底线，§10.4）
#   2. 复制 host/cli/protocol 到 ~/.local/lib/vipper/
#   3. 写 Native Messaging manifest 到 Chrome 与 Chromium 两个路径，
#      allowed_origins 仅含钉死 key 的扩展 ID（§10.1）
# 安装一次即可；之后扩展 connectNative() 时浏览器自动拉起 host，无常驻进程。
set -euo pipefail

HOST_NAME="com.vipper.host"
EXT_ID="dmgfibpimmkihmkcdjhjnpnjbfobfbhn" # wxt.config.ts manifest.key 推导，改动需同步
INSTALL_LIB="${VIPPER_LIB_DIR:-$HOME/.local/lib/vipper}"

# packages/ 位置：仓库内（scripts/ 的上级）或 M43 tarball 内（与脚本同级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/../packages" ]]; then
  PACKAGES_DIR="$SCRIPT_DIR/../packages"
elif [[ -d "$SCRIPT_DIR/packages" ]]; then
  PACKAGES_DIR="$SCRIPT_DIR/packages"
else
  echo "错误：找不到 packages/ 目录（在仓库根或 tarball 根运行）" >&2
  exit 1
fi

# 1) Node.js ≥ 22
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。vipper-host 需要 Node.js ≥ 22（§10.4）" >&2
  exit 1
fi
NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 22 ]]; then
  echo "错误：vipper-host 需要 Node.js ≥ 22，当前 $(node --version)（§10.4）" >&2
  exit 1
fi

# 2) 复制程序（纯 JS 零依赖，整包复制即可运行）
mkdir -p "$INSTALL_LIB"
rm -rf "$INSTALL_LIB/packages"
cp -R "$PACKAGES_DIR" "$INSTALL_LIB/packages"
chmod +x "$INSTALL_LIB/packages/vipper-host/bin/vipper-host.js" \
         "$INSTALL_LIB/packages/vipper-cli/bin/vipper-cli.js"
HOST_BIN="$INSTALL_LIB/packages/vipper-host/bin/vipper-host.js"

# 3) Native Messaging manifest：Chrome 与 Chromium 各一份（§10.2）
write_manifest() {
  local manifest_dir="$1"
  mkdir -p "$manifest_dir"
  cat > "$manifest_dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "vipper 外部访问 host（愚蠢管道，socket-access.md §3）",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "已写入 $manifest_dir/$HOST_NAME.json"
}

write_manifest "$HOME/.config/google-chrome/NativeMessagingHosts"
write_manifest "$HOME/.config/chromium/NativeMessagingHosts"
# 验收回路：浏览器以独立 --user-data-dir 启动时，用户级 manifest 目录是
# <user-data-dir>/NativeMessagingHosts 且仅启动时扫描，需提前装进测试 profile
if [[ -n "${VIPPER_NMH_EXTRA_DIR:-}" ]]; then
  write_manifest "$VIPPER_NMH_EXTRA_DIR"
fi

echo "完成：vipper-host 已安装到 $INSTALL_LIB（Node $(node --version)）"
echo "提示：重新加载扩展后生效；vipper-cli 位于 $INSTALL_LIB/packages/vipper-cli/bin/vipper-cli.js"
