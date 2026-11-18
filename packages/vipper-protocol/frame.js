/**
 * 帧编解码（socket-access.md §4.3）：socket 与 Native Messaging 同构。
 *
 *   ┌────────────────────┬──────────────────────────┐
 *   │ uint32 LE 帧长度    │ JSON 消息体（UTF-8）       │
 *   └────────────────────┴──────────────────────────┘
 *
 * 消息约定：每条消息带 `id`（请求/响应配对）与 `v: 1`（协议版本）。
 * 配对完成后业务体加密为信封（{"$enc":"v1",...}），id/v 保持明文供 host 路由（M41 落地）。
 */

/** Native Messaging 单帧上限 1MB，对齐之；超过即视为对端异常 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * 编码一帧：JSON 序列化 + 4 字节小端长度前缀。
 * @param {unknown} msg 可 JSON 序列化的消息
 * @returns {Buffer}
 */
export function encodeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error(`帧过大：${body.length} 字节（上限 ${MAX_FRAME_BYTES}）`);
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * 流式帧解析器：任意碎片喂入，攒够一帧回调一次。
 * @param {(msg: object, raw: Buffer) => void} onFrame 解出的消息对象与**完整原始帧**
 *        （含 4 字节长度前缀——host 愚蠢管道原样转发用 raw，见 §4.3）
 * @param {(err: Error) => void} [onError] 帧格式非法（超长/JSON 损坏）
 */
export function createFrameParser(onFrame, onError = () => {}) {
  let buf = Buffer.alloc(0);
  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (len > MAX_FRAME_BYTES) {
          onError(new Error(`帧长度越界：${len}（上限 ${MAX_FRAME_BYTES}）`));
          buf = Buffer.alloc(0);
          return;
        }
        if (buf.length < 4 + len) return;
        const raw = buf.subarray(0, 4 + len);
        buf = buf.subarray(4 + len);
        let msg;
        try {
          msg = JSON.parse(raw.subarray(4).toString('utf8'));
        } catch (err) {
          onError(new Error(`帧 JSON 损坏：${err.message}`));
          continue;
        }
        onFrame(msg, raw);
      }
    },
  };
}
