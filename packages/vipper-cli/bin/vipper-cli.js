#!/usr/bin/env node
/**
 * vipper-cli 入口。M40 仅含 ping（连通性诊断）；get / run / fd 四模式见 M43（§9）。
 */
import { request } from '../src/client.js';

const [, , cmd, ...rest] = process.argv;

const USAGE = `用法：
  vipper-cli ping [消息]   验证 cli→host→扩展链路（返回扩展回显）
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
  console.error(USAGE);
  process.exitCode = cmd ? 2 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
