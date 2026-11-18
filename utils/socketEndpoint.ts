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
 * M42 协议面（授权层，§6）：
 * - 寻址：`get(条目路径)`，路径 = `<书签title>/<secret记录name>`（§6.2）；
 *   只扫 active 书签，0 匹配 not_found、多匹配 ambiguous（防御分支）、1 匹配进三态策略。
 * - 三态：缺省/⛔ 与 ✅ 非白名单统一 not_found（不泄露条目存在性）；✅ 白名单直接放行；
 *   🔔 弹窗询问（仅此一次 / 记住此客户端 / 拒绝），60s 超时默认拒绝。
 * - 令牌（§6.4）：放行后签发 `{ 客户端指纹, 条目路径, 过期时间 }`，存 chrome.storage.session
 *   （SW 回收不丢、浏览器退出即清）；TTL 默认 8h（meta:settings.socketTokenTtlHours）；
 *   锁库即清空全部令牌（keychain.lock 按 SOCKET_TOKEN_PREFIX 前缀清除）。
 * - vault 锁定时所有 get 返回 `locked`，不泄露任何元数据。
 */

import {
  b64ToU8, deriveSessionKey, exportIdentityPub, fingerprint, generateSessionKeypair, open, seal,
} from '../packages/vipper-protocol/crypto';
import { decryptString } from './crypto';
import { getKey, getSettings, SOCKET_TOKEN_PREFIX } from './keychain';
import { getBookmark, listIndex, saveBookmark } from './vault';
import type { Bookmark, SecretRecord } from './vault';

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

/** chrome.storage.session `socket.authz.<id>` 的待确认授权请求（§6.1 🔔 / §7 要点 3） */
interface PendingAuthz {
  pendingId: string;     // = get 请求 id
  sessionId: string;     // 应答时定位会话密钥
  path: string;          // 条目路径 <书签title>/<secret记录name>
  fingerprint: string;
  clientName: string;
  pid: number | null;
  exePath: string | null;
  at: number;
}

interface Session {
  key: CryptoKey;
  fingerprint: string;
  pid: number | null;     // 配对握手时自报，用于授权弹窗展示（§5.3：展示辅助）
  exePath: string | null; // 来自 host /proc 读回
  at: number;
}

const HOST_NAME = 'com.vipper.host';
const STORAGE_CLIENTS = 'socket.clients';
const PENDING_PREFIX = 'socket.pending.';
const AUTHZ_PREFIX = 'socket.authz.';
const PAIR_TIMEOUT_MS = 60_000; // §6.2 同款：弹窗等待超时默认拒绝
const ASK_TIMEOUT_MS = 60_000; // §6.2：每次请求弹窗/响应等待 60 秒超时，默认拒绝
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
/** pendingId → 确认窗（窗被直接关掉 = 拒绝，见 windows.onRemoved） */
const pendingWindows = new Map<string, { windowId: number; kind: 'pair' | 'authz' }>();

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
    const peer = [...peers].reverse().find((m) => m.pid === pid);
    await grantPair(id, fp, known.name, sessionPub, pid, peer?.exePath ?? null);
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
  pid: number | null,
  exePath: string | null,
): Promise<void> {
  const sessionPair = await generateSessionKeypair();
  const extSessionPub = await exportIdentityPub(sessionPair.publicKey);
  const key = await deriveSessionKey(sessionPair.privateKey, clientSessionPub, extSessionPub);
  const sessionId = String(id);
  sessions.set(sessionId, { key, fingerprint: fp, pid, exePath, at: Date.now() });
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
  await grantPair(pendingId, pending.fingerprint, pending.name, pending.sessionPub, pending.pid, pending.exePath);
  return { ok: true };
}

/* ---------- 加密通道（§5.1 步骤 5 / §4.3 信封） ---------- */

async function handleSecure(msg: HostMessage): Promise<void> {
  const id = msg.id as string | number;
  const sessionId = msg.session as string;
  const session = sessions.get(sessionId);
  const aad = { id, session: sessionId };

  // 未知会话（未配对/连接已断重建）与解密失败统一回 unpaired：不区分失败原因（§11）
  type InnerMessage = { type?: string; payload?: { msg?: string; path?: string } };
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
  // M42：授权层（§6）——每个 get 都过寻址 + 三态策略 + 令牌
  if (inner.type === 'get') {
    await handleGet(id, sessionId, session, inner.payload?.path, respond);
    return;
  }
  await respond({ type: 'error', error: { code: 'unsupported', message: '仅支持 ping / get' } });
}

/* ---------- 授权层（§6） ---------- */

type ResolveResult =
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'found'; bookmark: Bookmark; record: SecretRecord };

/**
 * 寻址（§6.2）：路径 = `<书签title>/<secret记录name>`。
 * 只扫 active 书签（归档不参与，与 Alt+P 一致）；title 含 `/` 也能正确解析
 * （按 `title + '/'` 前缀匹配而不是固定切分点）。0 匹配 not_found；
 * 多于 1 个匹配 ambiguous（纯防御分支——M39 唯一性约束生效后不应出现，拒绝服务不猜）。
 */
async function resolveSecretPath(path: string): Promise<ResolveResult> {
  const idx = await listIndex();
  const matches: { bookmark: Bookmark; record: SecretRecord }[] = [];
  for (const e of idx) {
    if (e.status !== 'active' || !path.startsWith(`${e.title}/`)) continue;
    const name = path.slice(e.title.length + 1);
    const b = await getBookmark(e.id);
    const record = b?.records.find(
      (r): r is SecretRecord => r.template === 'secret' && r.name === name,
    );
    if (b && record) matches.push({ bookmark: b, record });
  }
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'found', ...matches[0]! };
}

const tokenKey = (fp: string, path: string) => `${SOCKET_TOKEN_PREFIX}${fp}|${path}`;

/** TTL 内同客户端取同一条目免重复授权（§6.4） */
async function validToken(fp: string, path: string): Promise<boolean> {
  const got = await chrome.storage.session.get(tokenKey(fp, path));
  const expiresAt = got[tokenKey(fp, path)] as number | undefined;
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

/** 签发令牌：{ 客户端指纹, 条目路径, 过期时间 }，存 storage.session（SW 回收不丢） */
async function issueToken(fp: string, path: string): Promise<void> {
  const { socketTokenTtlHours } = await getSettings();
  await chrome.storage.session.set({
    [tokenKey(fp, path)]: Date.now() + socketTokenTtlHours * 3_600_000,
  });
}

type SecureRespond = (body: Record<string, unknown>) => Promise<void>;

async function handleGet(
  id: string | number,
  sessionId: string,
  session: Session,
  path: unknown,
  respond: SecureRespond,
): Promise<void> {
  const fail = (code: string, message: string) => respond({ type: 'error', error: { code, message } });
  if (typeof path !== 'string' || !path.includes('/')) {
    await fail('bad_request', 'get 需要 payload.path（格式 <书签title>/<secret记录name>）');
    return;
  }
  // vault 锁定时所有请求返回 locked，不泄露任何元数据（§6.2）
  const key = await getKey();
  if (!key) {
    await fail('locked', '保管库已锁定');
    return;
  }
  const resolved = await resolveSecretPath(path);
  if (resolved.kind === 'ambiguous') {
    await fail('ambiguous', `路径命中多条记录（旧数据重名，请先在管理页改名）: ${path}`);
    return;
  }
  // ⛔ disabled（含缺省）与 ✅ 非白名单统一 not_found：不泄露条目存在性（§6.1/§11）
  const exposure = resolved.kind === 'found' ? resolved.record.socketExposure : undefined;
  const fp = session.fingerprint;
  if (resolved.kind === 'not_found' || !exposure
    || (exposure.mode === 'allowed' && !exposure.clients.includes(fp))) {
    await fail('not_found', `条目不可见: ${path}`);
    return;
  }
  // 令牌命中：免重复弹窗直接放行
  if (await validToken(fp, path)) {
    await grantGet(path, resolved.record, key, respond);
    return;
  }
  // ✅ 白名单命中：直接放行并签发令牌
  if (exposure.mode === 'allowed') {
    await issueToken(fp, path);
    await grantGet(path, resolved.record, key, respond);
    return;
  }
  // 🔔 ask：待确认请求落 storage.session（SW 回收不丢）+ 弹确认窗，60s 超时默认拒绝
  const clients = await readClients();
  const pendingId = String(id);
  const pending: PendingAuthz = {
    pendingId,
    sessionId,
    path,
    fingerprint: fp,
    clientName: clients[fp]?.name ?? fp.slice(0, 16),
    pid: session.pid,
    exePath: session.exePath,
    at: Date.now(),
  };
  await chrome.storage.session.set({ [AUTHZ_PREFIX + pendingId]: pending });
  openConfirmWindow(pendingId, 'authz');
  setTimeout(() => void expireAuthz(pendingId), ASK_TIMEOUT_MS);
}

/** 放行：解密 content 并应答（明文只活在加密信封内，§3） */
async function grantGet(
  path: string,
  record: SecretRecord,
  key: CryptoKey,
  respond: SecureRespond,
): Promise<void> {
  const content = await decryptString(key, record.content);
  await respond({ type: 'result', payload: { path, content } });
}

/** 🔔 超时默认拒绝：pending 还在即按超时结案 */
async function expireAuthz(pendingId: string): Promise<void> {
  const key = AUTHZ_PREFIX + pendingId;
  const got = (await chrome.storage.session.get(key)) as Record<string, PendingAuthz>;
  if (!got[key]) return;
  await chrome.storage.session.remove(key);
  await respondAuthz(got[key], { type: 'error', error: { code: 'timeout', message: '授权确认超时（60s 未决定，默认拒绝）' } });
}

/** 用 pending 里的会话密钥应答（SW 回收后会话密钥已蒸发时静默放弃——客户端会按超时结案） */
async function respondAuthz(pending: PendingAuthz, body: Record<string, unknown>): Promise<void> {
  const session = sessions.get(pending.sessionId);
  if (!session) return;
  const aad = { id: pending.pendingId, session: pending.sessionId };
  const envelope = await seal(session.key, body, aad);
  postToHost({ v: 1, id: pending.pendingId, session: pending.sessionId, ...envelope });
}

/** 确认窗授权决定：仅此一次 / 记住此客户端（转 ✅ 白名单）/ 拒绝 */
async function decideAuthz(
  pendingId: string,
  decision: 'once' | 'remember' | 'deny',
): Promise<{ ok: boolean; reason?: string }> {
  const key = AUTHZ_PREFIX + pendingId;
  const got = (await chrome.storage.session.get(key)) as Record<string, PendingAuthz>;
  const pending = got[key];
  if (!pending) return { ok: false, reason: 'gone' };
  await chrome.storage.session.remove(key);

  const fail = async (code: string, message: string) => {
    await respondAuthz(pending, { type: 'error', error: { code, message } });
    return { ok: true };
  };
  if (Date.now() - pending.at > ASK_TIMEOUT_MS) return fail('timeout', '授权确认超时（60s 未决定，默认拒绝）');
  if (decision === 'deny') return fail('denied', '用户在确认窗拒绝了访问请求');

  // 决定时刻重新检查：vault 可能已锁定、条目可能已变更
  const vaultKey = await getKey();
  if (!vaultKey) return fail('locked', '保管库已锁定');
  const resolved = await resolveSecretPath(pending.path);
  if (resolved.kind !== 'found') {
    return fail(resolved.kind === 'ambiguous' ? 'ambiguous' : 'not_found', `条目不可见: ${pending.path}`);
  }

  // 「记住此客户端」：条目转 ✅ 并把该身份写入白名单（§6.1）
  if (decision === 'remember') {
    const b = await getBookmark(resolved.bookmark.id);
    const rec = b?.records.find(
      (r): r is SecretRecord => r.template === 'secret' && r.name === resolved.record.name,
    );
    if (b && rec) {
      const clients = [...new Set([...(rec.socketExposure?.clients ?? []), pending.fingerprint])];
      rec.socketExposure = { mode: 'allowed', clients };
      await saveBookmark(b); // content 已是密文，saveBookmark 无需解锁
    }
  }

  await issueToken(pending.fingerprint, pending.path);
  await respondAuthz(pending, {
    type: 'result',
    payload: { path: pending.path, content: await decryptString(vaultKey, resolved.record.content) },
  });
  return { ok: true };
}

/* ---------- 确认窗（§7） ---------- */

function openConfirmWindow(pendingId: string, kind: 'pair' | 'authz' = 'pair'): void {
  if (pendingWindows.has(pendingId)) return;
  const url = chrome.runtime.getURL(`confirm.html?req=${encodeURIComponent(pendingId)}&kind=${kind}`);
  void chrome.windows
    .create({ url, type: 'popup', width: 440, height: 380, focused: true })
    .then((win) => {
      if (win?.id !== undefined) pendingWindows.set(pendingId, { windowId: win.id, kind });
    })
    .catch(() => { /* 创建失败：pending 仍在，超时默认拒绝兜底 */ });
}

// 确认窗决定（页面按钮 → runtime message）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'socket.pair.decide' && typeof msg.pendingId === 'string') {
    void decidePair(msg.pendingId, msg.approve === true).then(sendResponse);
    return true; // 异步 sendResponse
  }
  if (msg?.type === 'socket.authz.decide' && typeof msg.pendingId === 'string') {
    const decision = msg.decision === 'remember' || msg.decision === 'deny' ? msg.decision : 'once';
    void decideAuthz(msg.pendingId, decision).then(sendResponse);
    return true;
  }
  return undefined;
});

// 确认窗被直接关闭 = 拒绝（MetaMask 同款语义；安全问题必须得到真实回答才放行）
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [pendingId, w] of pendingWindows) {
    if (w.windowId === windowId) {
      pendingWindows.delete(pendingId);
      if (w.kind === 'pair') void decidePair(pendingId, false);
      else void decideAuthz(pendingId, 'deny');
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
  /** 待确认授权请求（M42 验收用） */
  pendingAuthz: async (): Promise<PendingAuthz[]> => {
    const all = (await chrome.storage.session.get(null)) as Record<string, unknown>;
    return Object.entries(all)
      .filter(([k]) => k.startsWith(AUTHZ_PREFIX))
      .map(([, v]) => v as PendingAuthz);
  },
};
