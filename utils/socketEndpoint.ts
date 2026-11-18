/**
 * M40：socket 外部访问的扩展端点（socket-access.md §3/§10.2）。
 *
 * SW 启动即 connectNative('com.vipper.host')；host 由 Chrome 拉起，
 * stdin EOF（SW 回收 / 浏览器退出）即退出——无常驻守护进程。
 * 断开按指数退避重连（host 未安装时静默重试，下次 SW 唤醒从头再来）。
 *
 * M40 协议面：ping/pong 字节互通 + host 连接元数据登记；
 * 配对（M41）/ 授权（M42）落地前，其余业务请求一律统一回绝，不泄露 vault 状态（§11）。
 */

export interface HostConnMeta {
  id: number;
  uid: number;
  pid: number;
  exePath: string;
  at: number;
}

const HOST_NAME = 'com.vipper.host';
const MAX_PEERS = 32;
const RETRY_INIT_MS = 1000;
const RETRY_MAX_MS = 60_000;

let port: chrome.runtime.Port | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = RETRY_INIT_MS;
let lastDisconnectReason = '';
const peers: HostConnMeta[] = [];

export function connectSocketEndpoint(): void {
  if (port) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const p = chrome.runtime.connectNative(HOST_NAME);
  port = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    // host 未安装（"Specified native messaging host not found"）或 host 退出
    lastDisconnectReason = chrome.runtime.lastError?.message ?? '正常断开';
    console.log(`[vipper] socket host 断开：${lastDisconnectReason}`);
    if (port === p) port = null;
    scheduleReconnect();
  });
  retryMs = RETRY_INIT_MS; // 连上即重置退避
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectSocketEndpoint();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

interface HostMessage {
  v?: number;
  id?: string | number;
  type?: string;
  payload?: { msg?: string };
  conn?: HostConnMeta;
}

function onHostMessage(msg: HostMessage): void {
  if (!msg || typeof msg !== 'object') return;
  // host 自产元数据（§3：host 记录连接元数据）
  if (msg.type === '$host.conn' && msg.conn) {
    peers.push(msg.conn);
    if (peers.length > MAX_PEERS) peers.shift();
    console.log(`[vipper] socket 客户端连接：pid=${msg.conn.pid} exe=${msg.conn.exePath}`);
    return;
  }
  if (msg.type === '$host.disc') return; // M40 仅登记 open
  // M40 字节互通验证
  if (msg.type === 'ping' && msg.id !== undefined) {
    port?.postMessage({
      v: 1,
      id: msg.id,
      type: 'pong',
      payload: { echo: msg.payload?.msg ?? null, from: 'vipper-extension', at: Date.now() },
    });
    return;
  }
  // M41/M42 之前的一切业务请求：统一回绝（§11：不泄露 vault 状态）
  if (msg.id !== undefined) {
    port?.postMessage({
      v: 1,
      id: msg.id,
      type: 'error',
      error: { code: 'unsupported', message: '配对与授权尚未实现（M41/M42），当前仅支持 ping' },
    });
  }
}

/** 暴露给 background 接线与验收脚本的端点句柄 */
export const socketEndpoint = {
  connect: connectSocketEndpoint,
  status: () => ({ connected: port !== null, host: HOST_NAME, lastDisconnectReason }),
  /** 最近的客户端连接元数据（环形，诊断与 M40 验收用） */
  peers: (): HostConnMeta[] => [...peers],
};
