/**
 * vipper-cli 的 socket 客户端：连接 host、发请求、等响应（M43 的四模式共用此层）。
 * 帧格式见 vipper-protocol（§4.3）；M41 起业务请求走配对 + 加密信封（§5，crypto.js）。
 *
 * 两条通道：
 * - request()       明文诊断通道（仅 ping；host 连通性排查用，不触及 vault）
 * - secureRequest() 配对握手（未配对时等用户确认窗决定）→ X25519 会话密钥 → 加密业务
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { encodeFrame, createFrameParser } from '../../vipper-protocol/frame.js';
import { socketPath } from '../../vipper-protocol/paths.js';
import { deriveSessionKey, exportIdentityPub, generateSessionKeypair, open, seal } from '../../vipper-protocol/crypto.js';
import { ensureIdentity } from './identity.js';

const PEER_HELLO_TYPE = '$peer.hello';
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 配对需等用户在扩展确认窗亲手点选（扩展侧 60s 默认拒绝），客户端多留 5s 余量 */
export const PAIR_TIMEOUT_MS = 65_000;

export class VipperUnavailableError extends Error {
  constructor(detail) {
    super(`vipper 服务不可用：${detail}（浏览器是否在运行？host 是否已安装？见 scripts/install-host.sh）`);
    this.code = 'VIPPER_UNAVAILABLE';
  }
}

/** 扩展拒绝（配对被拒/超时/未配对）：code 原样透传，便于上层按码处理 */
export class VipperRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 明文诊断请求（不配对、不加密；扩展侧只响应 ping，业务请求一律 unpaired）。
 * @param {object} payload 业务消息（不带 v/id，由本层补齐）
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>} 响应消息
 */
export function request(payload, { timeoutMs = 10_000 } = {}) {
  return connect((sock, send, onFrame) => {
    const id = randomUUID();
    onFrame((msg) => (msg?.id === id ? msg : undefined));
    send({ v: 1, type: PEER_HELLO_TYPE, pid: process.pid });
    send({ v: 1, id, ...payload });
  }, timeoutMs);
}

/**
 * 配对 + 加密业务请求：每连接一次握手（身份复用无弹窗），会话密钥随连接生灭。
 * @param {object} payload 业务消息（明文，仅活在加密信封内）
 * @param {{ timeoutMs?: number, onWaitingConfirm?: (info: { name: string, fingerprint: string }) => void }} [opts]
 *   onWaitingConfirm：2s 未收到 paired 即回调一次（cli 可提示用户去浏览器确认）
 * @returns {Promise<object>} 解密后的业务响应
 */
export function secureRequest(payload, { timeoutMs = PAIR_TIMEOUT_MS, onWaitingConfirm } = {}) {
  return (async () => {
    const identity = await ensureIdentity();
    const sessionPair = await generateSessionKeypair();
    const sessionPub = await exportIdentityPub(sessionPair.publicKey);
    const name = `vipper-cli@${hostname()}`;

    return connect((sock, send, onFrame, fail) => {
      const pairId = randomUUID();
      const reqId = randomUUID();
      /** @type {CryptoKey | null} */
      let sessionKey = null;
      const waitingTimer = setTimeout(() => {
        onWaitingConfirm?.({ name, fingerprint: identity.fingerprint });
      }, 2000);

      onFrame(async (msg) => {
        if (msg?.id === pairId) {
          if (msg.type === 'error') throw new VipperRequestError(msg.error?.code ?? 'pair_failed', msg.error?.message ?? '配对失败');
          if (msg.type !== 'paired') return undefined;
          sessionKey = await deriveSessionKey(sessionPair.privateKey, msg.payload.sessionPub, sessionPub);
          const envelope = await seal(sessionKey, payload, { id: reqId, session: pairId });
          send({ v: 1, id: reqId, session: pairId, ...envelope });
          return undefined; // 等加密响应
        }
        if (msg?.id === reqId && sessionKey) {
          const inner = await open(sessionKey, msg, { id: reqId, session: pairId });
          if (inner?.type === 'error') throw new VipperRequestError(inner.error?.code ?? 'error', inner.error?.message ?? '请求失败');
          return inner;
        }
        return undefined;
      });

      send({ v: 1, type: PEER_HELLO_TYPE, pid: process.pid });
      send({
        v: 1,
        id: pairId,
        type: 'pair',
        payload: {
          name, version: PKG.version, pid: process.pid,
          identityPub: identity.identityPub, sessionPub,
        },
      });
      return () => clearTimeout(waitingTimer);
    }, timeoutMs);
  })();
}

/**
 * 连接 host 并跑一段协议交互。setup 里注册帧处理器、发首帧；
 * 帧处理器返回非 undefined（或抛错）即结束；返回清理函数则在结束时调用。
 */
function connect(setup, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    let settled = false;
    let cleanup = null;
    const timer = setTimeout(() => {
      fail(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const done = (err, msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { cleanup?.(); } catch { /* 忽略 */ }
      sock.destroy();
      if (err) reject(err);
      else resolve(msg);
    };
    const fail = (err) => done(err);

    /** @type {Array<(msg: object) => Promise<object|undefined>|object|undefined>} */
    let handler = null;
    const parser = createFrameParser(
      (msg) => {
        if (!handler) return;
        Promise.resolve()
          .then(() => handler(msg))
          .then((result) => { if (result !== undefined) done(null, result); })
          .catch((err) => done(err));
      },
      (err) => done(err),
    );

    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') done(new VipperUnavailableError(err.code));
      else done(err);
    });
    sock.on('data', (chunk) => parser.push(chunk));
    sock.on('connect', () => {
      const send = (msg) => sock.write(encodeFrame(msg));
      const onFrame = (fn) => { handler = fn; };
      cleanup = setup(sock, send, onFrame, fail) ?? null;
    });
  });
}
