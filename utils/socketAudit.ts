/**
 * socket 访问审计（socket-access.md §8）：每个 get 请求记录一条，只增不改。
 * 存 chrome.storage.local `socket.audit`（锁库保留审计，§6.4/§8），
 * 滚动上限可配（meta:settings.socketAuditMax，默认 1000）。
 */

import { getSettings } from './keychain';

export const SOCKET_AUDIT_KEY = 'socket.audit';

/** §8 字段：时间、客户端身份（指纹+名字）、exe 路径、PID、条目路径、结果 */
export interface AuditEntry {
  at: number;
  fingerprint: string;
  clientName: string;
  exePath: string | null;
  pid: number | null;
  path: string;
  /** granted / denied / locked / timeout / not_found / ambiguous / bad_request */
  result: string;
  /** result=granted 时的放行途径：token / allowed / ask-once / ask-remember */
  via?: string;
}

/**
 * append 串行化队列：read-modify-write 并发会互相覆盖丢条目，
 * 审计"只增不改"不能丢，所有写入经此队列排队。
 */
let queue: Promise<void> = Promise.resolve();

/** 记录一条审计（fire-and-forget；写失败只告警，不阻断请求处理） */
export function recordAudit(entry: Omit<AuditEntry, 'at'>): void {
  queue = queue.then(async () => {
    const got = await chrome.storage.local.get(SOCKET_AUDIT_KEY);
    const list = (got[SOCKET_AUDIT_KEY] as AuditEntry[] | undefined) ?? [];
    list.push({ ...entry, at: Date.now() });
    const max = Math.max(1, (await getSettings()).socketAuditMax);
    while (list.length > max) list.shift(); // 滚动：最旧的先出
    await chrome.storage.local.set({ [SOCKET_AUDIT_KEY]: list });
  }).catch((err) => console.warn('[vipper] 审计写入失败', err));
}

/** 读取全部审计（管理页回放 / 验收） */
export async function readAudit(): Promise<AuditEntry[]> {
  const got = await chrome.storage.local.get(SOCKET_AUDIT_KEY);
  return (got[SOCKET_AUDIT_KEY] as AuditEntry[] | undefined) ?? [];
}

/** 等待写入队列排空（验收用：断言前确保 fire-and-forget 已落盘） */
export async function flushAudit(): Promise<void> {
  await queue;
}
