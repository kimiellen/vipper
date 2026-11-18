/**
 * socket 外部访问的扩展端点（socket-access.md §3/§5/§10.2）。
 *
 * SW 启动即 connectNative('com.vipper.host')；host 由 Chrome 拉起，
 * stdin EOF（SW 回收 / 浏览器退出）即退出——无常驻守护进程。
 * 断开按指数退避重连（host 未安装时静默重试，下次 SW 唤醒从头再来）。
 *
 * M40 协议面：ping/pong 字节互通 + host 连接元数据登记（保留为明文诊断通道）。
 * M41 协议面（配对层，§5）：
 * - pair 握手：未配对身份 → 待确认请求落 chrome.storage.session（SW 回收不丢）
 *   + chrome.windows.create 确认窗亲手决定；已配对 → 直接签发会话密钥。
 * - 配对存储：chrome.storage.local 的 `socket.clients`（指纹 → 名称/公钥/配对时间）。
 * - 加密通道：X25519 临时会话密钥 + HKDF-SHA256 + AES-GCM 信封（vipper-protocol/crypto），
 *   AAD 绑定帧头 { id, session }；会话密钥只在 SW 内存，随连接生灭。
 * - 未配对的一切请求统一回 `unpaired`，不泄露 vault 状态（§11）。
 * 授权层（M42）落地前，加密通道内仅回显 ping 供通道验收。
 */

import {
  b64ToU8, deriveSessionKey, exportIdentityPub, fingerprint, generateSessionKeypair, open, seal,
} from '../packages/vipper-protocol/crypto';

export interface HostConnMeta {
  id: number;
  uid: number;
  pid: number;
  exePath: string;
  at: number;
}

/** chrome.storage.local `socket.clients` 的一条配对记录（§5.1 步骤 4） */
interface PairedClient {
  name: string;        // 用户起的名字（M41 先存自报名，重命名/撤销属 M43 管理页）
  identityPub: string; // X25519 身份公钥（raw base64）
  pairedAt: number;
}

/** chrome.storage.session `socket.pending.<id>` 的待确认配对请求（§7 要点 3：SW 回收不丢） */
interface PendingPair {
  pendingId: string;
  name: string;
  version: string;
  pid: number | null;      // cli 自报，用于在 host 校验过的连接元数据里找回 exePath
  exePath: string | null;  // 来自 host /proc 读回（§5.3：仅展示辅助，不作安全锚点）
  identityPub: string;
  sessionPub: string;
  fingerprint: string;
  at: number;
}

interface Session {
  key: CryptoKey;
  fingerprint: string;
  at: number;
}

const HOST_NAME = 'com.vipper.host';
const STORAGE_CLIENTS = 'socket.clients';
const PENDING_PREFIX = 'socket.pending.';
const PAIR_TIMEOUT_MS = 60_000; // §6.2 同款：弹窗等待超时默认拒绝
const MAX_PEERS = 32;
const MAX_SESSIONS = 64; // 会话密钥随连接生灭；上限防异常客户端刷内存（LRU 逐出）
const RETRY_INIT_MS = 1000;
const RETRY_MAX_MS = 60_000;

let port: chrome.runtime.Port | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = RETRY_INIT_MS;
let lastDisconnectReason = '';
const peers: HostConnMeta[] = [];
const sessions = new Map<string, Session>();
/** pendingId → 确认窗 windowId（窗被直接关掉 = 拒绝，见 windows.onRemoved） */
const pendingWindows = new Map<string, number>();

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
    sessions.clear(); // 连接全断，会话密钥一并作废
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

function postToHost(msg: Record<string, unknown>): void {
  port?.postMessage(msg);
}

function postError(id: string | number, code: string, message: string): void {
  postToHost({ v: 1, id, type: 'error', error: { code, message } });
}

interface HostMessage {
  v?: number;
  id?: string | number;
  type?: string;
  session?: string;
  $enc?: string;
  payload?: Record<string, unknown> & { msg?: string };
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
  if (msg.type === '$host.disc') return; // 会话密钥按 LRU 上限自然逐出，无需按连接清理
  if (msg.id === undefined) return;

  // M41：配对握手
  if (msg.type === 'pair') {
    void handlePair(msg);
    return;
  }
  // M41：加密信封（配对后的业务消息）
  if (msg.$enc === 'v1' && typeof msg.session === 'string') {
    void handleSecure(msg);
    return;
  }
  // M40 明文诊断保留：ping/pong 字节互通
  if (msg.type === 'ping') {
    postToHost({
      v: 1,
      id: msg.id,
      type: 'pong',
      payload: { echo: msg.payload?.msg ?? null, from: 'vipper-extension', at: Date.now() },
    });
    return;
  }
  // 其余一切明文请求：未配对统一回绝（§11：不泄露 vault 状态）
  postError(msg.id, 'unpaired', '客户端未配对：请先执行 vipper-cli pair 并在浏览器确认窗允许');
}

/* ---------- 配对握手（§5.1） ---------- */

async function handlePair(msg: HostMessage): Promise<void> {
  const id = msg.id as string | number;
  const p = msg.payload ?? {};
  const { name, version, identityPub, sessionPub } = p as {
    name?: unknown; version?: unknown; identityPub?: unknown; sessionPub?: unknown;
  };
  const pid = typeof p.pid === 'number' ? p.pid : null;
  // 公钥形态校验：raw X25519 公钥 = 32 字节 base64（atob 对非法串抛错，兜住）
  const validPub = (v: unknown): v is string => {
    if (typeof v !== 'string') return false;
    try {
      return b64ToU8(v).length === 32;
    } catch {
      return false;
    }
  };
  if (typeof name !== 'string' || !name || !validPub(identityPub) || !validPub(sessionPub)) {
    postError(id, 'pair_invalid', 'pair 请求格式非法（需要 name / identityPub / sessionPub）');
    return;
  }

  const fp = await fingerprint(identityPub);
  const clients = await readClients();
  const known = clients[fp];
  if (known) {
    await grantPair(id, fp, known.name, sessionPub);
    return;
  }

  // 未配对身份：待确认请求落 storage.session（SW 回收不丢，§7 要点 3）+ 弹确认窗
  const pendingId = String(id);
  const peer = [...peers].reverse().find((m) => m.pid === pid); // host /proc 校验过的元数据
  const pending: PendingPair = {
    pendingId,
    name,
    version: typeof version === 'string' ? version : '',
    pid,
    exePath: peer?.exePath ?? null,
    identityPub,
    sessionPub,
    fingerprint: fp,
    at: Date.now(),
  };
  await chrome.storage.session.set({ [PENDING_PREFIX + pendingId]: pending });
  openConfirmWindow(pendingId);
  // 超时默认拒绝（窗口侧也有同口径倒计时；decide 时按 at 再兜底一次，防 SW 回收丢定时器）
  setTimeout(() => void expirePair(pendingId), PAIR_TIMEOUT_MS);
}

/** 签发会话：双方临时 X25519 协商会话密钥，应答 paired（§5.1 步骤 5） */
async function grantPair(
  id: string | number,
  fp: string,
  name: string,
  clientSessionPub: string,
): Promise<void> {
  const sessionPair = await generateSessionKeypair();
  const extSessionPub = await exportIdentityPub(sessionPair.publicKey);
  const key = await deriveSessionKey(sessionPair.privateKey, clientSessionPub, extSessionPub);
  const sessionId = String(id);
  sessions.set(sessionId, { key, fingerprint: fp, at: Date.now() });
  // LRU 逐出最旧会话
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  postToHost({
    v: 1,
    id,
    type: 'paired',
    payload: { session: sessionId, sessionPub: extSessionPub, fingerprint: fp, name },
  });
}

/** 超时默认拒绝：pending 还在即按超时结案（已被决定过的请求 pending 已删，空跑） */
async function expirePair(pendingId: string): Promise<void> {
  const key = PENDING_PREFIX + pendingId;
  const got = (await chrome.storage.session.get(key)) as Record<string, PendingPair>;
  if (!got[key]) return;
  await chrome.storage.session.remove(key);
  postError(pendingId, 'timeout', '配对确认超时（60s 未决定，默认拒绝）');
}

/** 确认窗决定：允许则登记配对存储并签发会话；拒绝/过期统一回绝 */
async function decidePair(pendingId: string, approve: boolean): Promise<{ ok: boolean; reason?: string }> {
  const key = PENDING_PREFIX + pendingId;
  const got = (await chrome.storage.session.get(key)) as Record<string, PendingPair>;
  const pending = got[key];
  if (!pending) return { ok: false, reason: 'gone' };
  await chrome.storage.session.remove(key);

  if (Date.now() - pending.at > PAIR_TIMEOUT_MS) {
    postError(pendingId, 'timeout', '配对确认超时（60s 未决定，默认拒绝）');
    return { ok: true };
  }
  if (!approve) {
    postError(pendingId, 'pair_denied', '用户在确认窗拒绝了配对请求');
    return { ok: true };
  }
  const clients = await readClients();
  clients[pending.fingerprint] = {
    name: pending.name,
    identityPub: pending.identityPub,
    pairedAt: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_CLIENTS]: clients });
  await grantPair(pendingId, pending.fingerprint, pending.name, pending.sessionPub);
  return { ok: true };
}

/* ---------- 加密通道（§5.1 步骤 5 / §4.3 信封） ---------- */

async function handleSecure(msg: HostMessage): Promise<void> {
  const id = msg.id as string | number;
  const sessionId = msg.session as string;
  const session = sessions.get(sessionId);
  const aad = { id, session: sessionId };

  // 未知会话（未配对/连接已断重建）与解密失败统一回 unpaired：不区分失败原因（§11）
  type InnerMessage = { type?: string; payload?: { msg?: string } };
  let inner: InnerMessage | null = null;
  if (session) {
    try {
      inner = (await open(session.key, msg, aad)) as InnerMessage;
    } catch {
      inner = null;
    }
  }
  if (!session || !inner) {
    postError(id, 'unpaired', '会话无效或信封校验失败：请重新配对连接');
    return;
  }

  // M42 授权层落地前，加密通道内仅 ping 回显（配对层通道验收）
  const respond = async (body: Record<string, unknown>) => {
    const envelope = await seal(session.key, body, aad);
    postToHost({ v: 1, id, session: sessionId, ...envelope });
  };
  if (inner.type === 'ping') {
    await respond({
      type: 'pong',
      payload: { echo: inner.payload?.msg ?? null, from: 'vipper-extension', at: Date.now() },
    });
    return;
  }
  await respond({ type: 'error', error: { code: 'unsupported', message: '授权层尚未实现（M42），当前仅支持 ping' } });
}

/* ---------- 确认窗（§7） ---------- */

function openConfirmWindow(pendingId: string): void {
  if (pendingWindows.has(pendingId)) return;
  const url = chrome.runtime.getURL(`confirm.html?req=${encodeURIComponent(pendingId)}`);
  void chrome.windows
    .create({ url, type: 'popup', width: 440, height: 380, focused: true })
    .then((win) => {
      if (win?.id !== undefined) pendingWindows.set(pendingId, win.id);
    })
    .catch(() => { /* 创建失败：pending 仍在，超时默认拒绝兜底 */ });
}

// 确认窗决定（页面按钮 → runtime message）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'socket.pair.decide' || typeof msg.pendingId !== 'string') return undefined;
  void decidePair(msg.pendingId, msg.approve === true).then(sendResponse);
  return true; // 异步 sendResponse
});

// 确认窗被直接关闭 = 拒绝（MetaMask 同款语义；安全问题必须得到真实回答才放行）
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [pendingId, winId] of pendingWindows) {
    if (winId === windowId) {
      pendingWindows.delete(pendingId);
      void decidePair(pendingId, false);
    }
  }
});

/* ---------- 存储 ---------- */

async function readClients(): Promise<Record<string, PairedClient>> {
  const got = (await chrome.storage.local.get(STORAGE_CLIENTS)) as {
    [STORAGE_CLIENTS]?: Record<string, PairedClient>;
  };
  return got[STORAGE_CLIENTS] ?? {};
}

/** 暴露给 background 接线与验收脚本的端点句柄 */
export const socketEndpoint = {
  connect: connectSocketEndpoint,
  status: () => ({ connected: port !== null, host: HOST_NAME, lastDisconnectReason }),
  /** 最近的客户端连接元数据（环形，诊断与验收用） */
  peers: (): HostConnMeta[] => [...peers],
  /** 已配对客户端（配对存储快照，M41 验收；重命名/撤销属 M43 管理页） */
  pairedClients: readClients,
  /** 待确认配对请求（验收用；确认窗从 storage.session 自行读取） */
  pendingPairs: async (): Promise<PendingPair[]> => {
    const all = (await chrome.storage.session.get(null)) as Record<string, unknown>;
    return Object.entries(all)
      .filter(([k]) => k.startsWith(PENDING_PREFIX))
      .map(([, v]) => v as PendingPair);
  },
};
