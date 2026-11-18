/**
 * vipper-cli 的 socket 客户端：连接 host、发请求、等响应（M43 的四模式共用此层）。
 * 帧格式与握手见 vipper-protocol（§4.3）与 host 的 peercred（§4）。
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeFrame, createFrameParser } from '../../vipper-protocol/frame.js';
import { socketPath } from '../../vipper-protocol/paths.js';

const PEER_HELLO_TYPE = '$peer.hello';

export class VipperUnavailableError extends Error {
  constructor(detail) {
    super(`vipper 服务不可用：${detail}（浏览器是否在运行？host 是否已安装？见 scripts/install-host.sh）`);
    this.code = 'VIPPER_UNAVAILABLE';
  }
}

/**
 * 发送一条请求并等待同 id 响应。
 * @param {object} payload 业务消息（不带 v/id，由本层补齐）
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>} 响应消息
 */
export function request(payload, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const done = (err, msg) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(msg);
    };

    const id = randomUUID();
    const parser = createFrameParser(
      (msg) => {
        if (msg?.id === id) done(null, msg);
        // 不匹配的帧（理论上 M40 不会发生）：忽略，继续等
      },
      (err) => done(err),
    );

    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') done(new VipperUnavailableError(err.code));
      else done(err);
    });
    sock.on('data', (chunk) => parser.push(chunk));
    sock.on('connect', () => {
      // transport 层握手：自报 pid（host 从 /proc 读回真实 uid/exe 校验）
      sock.write(encodeFrame({ v: 1, type: PEER_HELLO_TYPE, pid: process.pid }));
      sock.write(encodeFrame({ v: 1, id, ...payload }));
    });
  });
}
