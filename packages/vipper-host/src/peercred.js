/**
 * 对端凭据（Linux，socket-access.md §4，2026-11-18 质询确认的调整）。
 *
 * 背景：Node 纯 JS 拿不到 SO_PEERCRED（uv handle 不暴露 getpeereid），
 * 而「tarball 纯 JS 零依赖」（§10.3）排除了原生 addon。
 * 落地机制：客户端连接后首帧自报 pid（$peer.hello），host 从 /proc 读回
 * **真实** uid 与 exe 路径；UID ≠ 当前用户 → 立即拒连（§4 规则 1）。
 *
 * 威胁模型对齐 §5.3：进程属性只是展示/审计辅助，不作安全锚点——
 * 跨 UID 的真实拦截由 socket 文件 0600 + 目录 0700（$XDG_RUNTIME_DIR tmpfs）完成；
 * 同 UID 进程谎报 pid 无收益（身份锚点是配对层的公钥指纹，M41）。
 */

import { readFileSync, readlinkSync } from 'node:fs';

/** 客户端连接后首帧：自报 pid（transport 层握手，不进协议载荷） */
export const PEER_HELLO_TYPE = '$peer.hello';

/** 自报 pid 的读回结果：/proc 维护的真实值，客户端无法伪造 */
export function readPeerInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`非法 pid：${pid}`);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8'); // 进程已退出则抛错 → 拒连
  const m = status.match(/^Uid:\s+(\d+)/m);
  if (!m) throw new Error(`/proc/${pid}/status 缺 Uid 行`);
  let exePath = '';
  try {
    exePath = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    exePath = '(不可读)';
  }
  return { uid: Number(m[1]), pid, exePath };
}

/** §4 规则 1：UID ≠ 当前用户 → 拒绝（纯函数，便于验收脚本直接断言） */
export function isPeerAcceptable(peerInfo, selfUid) {
  return peerInfo.uid === selfUid;
}
