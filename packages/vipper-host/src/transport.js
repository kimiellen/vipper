/**
 * 传输层（socket-access.md §4）：平台无关接口 + Linux unix-socket 实现。
 * 协议层建立在接口之上，不感知平台差异；macOS 复用本实现（凭据 API 两行差异，M5 待定）。
 *
 * Transport 接口：
 *   listen(path, { onConnection, log }) → Promise<Transport>
 *   close() → 停止监听并清理 socket 文件
 * Connection 接口：
 *   peerInfo   —— { uid, pid, exePath }（/proc 读回，见 peercred.js）
 *   send(raw)  —— 写入一条完整帧（含 4 字节长度前缀的原始字节）
 *   onFrame(cb) —— 收到一条完整帧（raw Buffer，host 原样转发，不解析载荷）
 *   onClose(cb)
 *   close()
 */

import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import { createFrameParser } from '../../vipper-protocol/frame.js';
import { ensureSocketDir } from '../../vipper-protocol/paths.js';
import { PEER_HELLO_TYPE, isPeerAcceptable, readPeerInfo } from './peercred.js';

/** 等首帧（$peer.hello）的超时：超时按不可信处理，拒连 */
const HELLO_TIMEOUT_MS = 5000;

export class UnixSocketTransport {
  #server = null;
  #path = '';

  /**
   * @param {string} path socket 文件路径
   * @param {{ onConnection: (conn: UnixConnection) => void, log?: (event: string, data?: object) => void }} hooks
   */
  listen(path, { onConnection, log = () => {} }) {
    this.#path = path;
    ensureSocketDir();
    rmSync(path, { force: true }); // 上次异常退出的残留 socket 文件
    this.#server = net.createServer((socket) => {
      let conn = null;
      const helloTimer = setTimeout(() => {
        if (!conn) {
          log('transport.hello-timeout', {});
          socket.destroy();
        }
      }, HELLO_TIMEOUT_MS);
      const parser = createFrameParser(
        (msg, raw) => {
          if (conn) {
            conn.dispatch(msg, raw);
            return;
          }
          // 首帧必须是 $peer.hello：自报 pid → /proc 读回 → UID 校验（§4 规则 1）
          conn = this.#handshake(msg, socket, log) ?? null;
          clearTimeout(helloTimer);
          if (conn) onConnection(conn);
        },
        (err) => {
          log('transport.frame-error', { detail: err.message });
          socket.destroy();
        },
      );
      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('error', () => socket.destroy());
    });
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(path, () => {
        chmodSync(path, 0o600); // §11：socket 文件 0600，仅本用户可连
        log('transport.listen', { path });
        resolve(this);
      });
    });
  }

  /** @returns {UnixConnection | undefined} 校验不过则拒连并返回 undefined */
  #handshake(msg, socket, log) {
    const reject = (reason, data = {}) => {
      log('transport.reject', { reason, ...data });
      socket.destroy();
      return undefined;
    };
    if (msg?.type !== PEER_HELLO_TYPE) return reject('first-frame-not-hello');
    let peerInfo;
    try {
      peerInfo = readPeerInfo(msg.pid);
    } catch (err) {
      return reject('peercred-unreadable', { detail: err.message, pid: msg.pid });
    }
    if (!isPeerAcceptable(peerInfo, process.getuid())) {
      return reject('uid-mismatch', { uid: peerInfo.uid, pid: peerInfo.pid });
    }
    log('transport.accept', peerInfo);
    const conn = new UnixConnection(socket);
    conn.peerInfo = peerInfo;
    return conn;
  }

  async close() {
    if (!this.#server) return;
    await new Promise((r) => this.#server.close(r));
    rmSync(this.#path, { force: true });
  }
}

class UnixConnection {
  /** @type {{ uid: number, pid: number, exePath: string }} */
  peerInfo = null;
  #socket;
  #frameCb = () => {};
  #closeCb = () => {};

  constructor(socket) {
    this.#socket = socket;
    socket.on('close', () => this.#closeCb());
  }

  /** transport 内部：投递一条完整原始帧 */
  dispatch(msg, raw) {
    this.#frameCb(msg, raw);
  }

  /**
   * @param {(msg: object, raw: Buffer) => void} cb
   * msg 仅供浅读路由字段（id），raw 是完整帧（含长度前缀）供原样转发——
   * 愚蠢管道不触碰业务载荷（§3/§4.3）
   */
  onFrame(cb) {
    this.#frameCb = cb;
  }

  /** @param {() => void} cb */
  onClose(cb) {
    this.#closeCb = cb;
  }

  /** @param {Buffer} raw 完整帧原始字节 */
  send(raw) {
    this.#socket.write(raw);
  }

  close() {
    this.#socket.destroy();
  }
}
