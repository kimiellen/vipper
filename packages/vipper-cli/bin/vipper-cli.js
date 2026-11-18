#!/usr/bin/env node
/**
 * vipper-cli 入口。
 * M40：ping（明文连通性诊断）。
 * M41：pair（配对握手，触发扩展确认窗）/ sping（加密通道回显，验收配对层）。
 * M43 将提供 get / run / fd 四模式（socket-access.md §9）。
 */
import { request, secureRequest } from '../src/client.js';

const [, , cmd, ...rest] = process.argv;

const USAGE = `用法：
  vipper-cli ping [消息]   明文诊断：验证 cli→host→扩展链路（不配对、不触及 vault）
  vipper-cli pair          配对握手：未配对时浏览器弹确认窗，亲手允许后登记身份
  vipper-cli sping [消息]  加密诊断：配对后经 X25519 会话密钥加密往返
  （M43 将提供：vipper-cli get <条目路径> / vipper-cli run -- <cmd> / fd 模式，见 socket-access.md §9）`;

async function main() {
  if (cmd === 'ping') {
    const msg = rest.join(' ') || 'ping';
    const res = await request({ type: 'ping', payload: { msg } });
    if (res.type === 'pong') {
      console.log(`pong: ${JSON.stringify(res.payload)}`);
      return;
    }
    console.error(`未预期响应：${JSON.stringify(res)}`);
    process.exitCode = 1;
    return;
  }
  if (cmd === 'pair') {
    const res = await secureRequest(
      { type: 'ping', payload: { msg: 'pair-only' } },
      { onWaitingConfirm: ({ name, fingerprint }) =>
        console.error(`等待浏览器确认窗允许配对：${name}（指纹 ${fingerprint.slice(0, 16)}…）`) },
    );
    console.log(`已配对：${res.payload?.from ?? 'vipper-extension'}（通道加密可用）`);
    return;
  }
  if (cmd === 'sping') {
    const msg = rest.join(' ') || 'sping';
    const res = await secureRequest(
      { type: 'ping', payload: { msg } },
      { onWaitingConfirm: ({ name }) => console.error(`等待浏览器确认窗允许配对：${name}`) },
    );
    if (res.type === 'pong') {
      console.log(`secure-pong: ${JSON.stringify(res.payload)}`);
      return;
    }
    console.error(`未预期响应：${JSON.stringify(res)}`);
    process.exitCode = 1;
    return;
  }
  console.error(USAGE);
  process.exitCode = cmd ? 2 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
