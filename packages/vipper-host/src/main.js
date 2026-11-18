/**
 * vipper-host 主程序：愚蠢管道（socket-access.md §3）。
 * 只做三件事：校验对端 UID（transport 层）、逐帧原样转发、记录连接元数据。
 * 不持有密钥、不做策略决策、不解析业务载荷（浅读 `id` 仅用于路由，§4.3）。
 *
 * 数据通路：vipper-cli ──unix socket──▶ host ──stdio──▶ vipper 扩展
 * 两个方向同构一种帧格式，因此 socket 帧可以原样写进 stdout（反之亦然）。
 *
 * 生命周期：Chrome 在扩展 connectNative() 时拉起本进程；stdin EOF（SW 回收/
 * 浏览器退出）即清理退出——无常驻守护进程（§10.2）。
 */

import { encodeFrame, createFrameParser } from '../../vipper-protocol/frame.js';
import { socketPath } from '../../vipper-protocol/paths.js';
import { UnixSocketTransport } from './transport.js';

/** 待路由请求上限：防异常客户端刷爆内存（正常每条响应到达即删） */
const MAX_PENDING = 1024;

/** 连接元数据日志：JSON 行写 stderr（Chrome 侧可在扩展日志页看到；stdout 是协议专用） */
function log(event, data = {}) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n');
}

export async function main() {
  let nextConnId = 1;
  /** @type {Map<number, import('./transport.js').UnixConnection>} */
  const conns = new Map();
  /** 请求 id → 连接（多 socket 连接复用同一 native 端口的路由表，§4.3） */
  const idToConn = new Map();

  const toExt = (msg) => process.stdout.write(encodeFrame(msg));

  const track = (msg, connId) => {
    // 浅读 id 做路由登记；载荷不解析（愚蠢管道）
    const id = msg?.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    if (idToConn.size >= MAX_PENDING) idToConn.delete(idToConn.keys().next().value);
    idToConn.set(id, connId);
  };

  const transport = new UnixSocketTransport();
  await transport.listen(socketPath(), {
    log,
    onConnection(conn) {
      const connId = nextConnId++;
      conns.set(connId, conn);
      log('conn.open', { connId, ...conn.peerInfo });
      toExt({ v: 1, type: '$host.conn', conn: { id: connId, ...conn.peerInfo, at: Date.now() } });

      conn.onFrame((msg, raw) => {
        track(msg, connId);
        process.stdout.write(raw); // 帧格式同构，原样转发（§4.3）
      });
      conn.onClose(() => {
        conns.delete(connId);
        for (const [id, owner] of idToConn) if (owner === connId) idToConn.delete(id);
        log('conn.close', { connId });
        toExt({ v: 1, type: '$host.disc', conn: { id: connId } });
      });
    },
  });

  // 扩展 → cli：按 id 查路由表，原样写回对应连接
  const fromExt = createFrameParser(
    (msg, raw) => {
      const connId = msg?.id !== undefined ? idToConn.get(msg.id) : undefined;
      const conn = connId !== undefined ? conns.get(connId) : undefined;
      if (!conn) {
        log('route.miss', { id: msg?.id ?? null });
        return;
      }
      idToConn.delete(msg.id); // 一请求一响应，响应到达即释放路由
      conn.send(raw);
    },
    (err) => log('native.frame-error', { detail: err.message }),
  );
  process.stdin.on('data', (chunk) => fromExt.push(chunk));
  process.stdin.on('end', () => shutdown(0));

  async function shutdown(code) {
    log('host.shutdown', { code });
    for (const conn of conns.values()) conn.close();
    await transport.close().catch(() => {});
    process.exit(code);
  }

  log('host.ready', { pid: process.pid, socket: socketPath() });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    log('host.fatal', { detail: err.message });
    process.exit(1);
  });
}
