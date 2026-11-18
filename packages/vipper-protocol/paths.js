/**
 * socket 路径解析（socket-access.md §4）。
 * Linux：$XDG_RUNTIME_DIR/vipper/host.sock（0700 tmpfs，重启即清）。
 * 无 $XDG_RUNTIME_DIR 的极简环境兜底到 $TMPDIR/vipper-<uid>（仍限本用户）。
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @returns {string} socket 目录（不保证已创建） */
export function socketDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, 'vipper');
  return join(tmpdir(), `vipper-${process.getuid()}`);
}

/** @returns {string} host 监听的 socket 文件路径 */
export function socketPath() {
  return join(socketDir(), 'host.sock');
}

/** 创建 socket 目录（0700，仅本用户可入）并返回其路径 */
export function ensureSocketDir() {
  const dir = socketDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
