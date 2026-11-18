#!/usr/bin/env node
/**
 * vipper-cli 入口。
 * M40：ping（明文连通性诊断）。
 * M41：pair（配对握手，触发扩展确认窗）/ sping（加密通道回显，验收配对层）。
 * M43：get / run（socket-access.md §9 四模式中的模式 2 与模式 4；
 *      模式 1 是应用直接调 socket 协议、模式 3 是进程替换 `<(vipper-cli get x)`，均无需新命令）。
 */
import { spawn } from 'node:child_process';
import { request, secureRequest } from '../src/client.js';

const [, , cmd, ...rest] = process.argv;

const USAGE = `用法（按安全优先级，详见 docs/specs/vipper/socket-access.md §9）：
  vipper-cli get <条目路径>            取私密记录写 stdout（模式 2 密码命令 / 模式 3 fd 注入共用）
                                       条目路径格式：<书签title>/<secret记录name>，如 git/github
  vipper-cli run -e VAR=<条目路径> -- <cmd> [args...]
                                       取密钥注入子进程环境变量后启动（模式 4，兜底）
  vipper-cli ping [消息]   明文诊断：验证 cli→host→扩展链路（不配对、不触及 vault）
  vipper-cli pair          配对握手：未配对时浏览器弹确认窗，亲手允许后登记身份
  vipper-cli sping [消息]  加密诊断：配对后经 X25519 会话密钥加密往返`;

/** 等待浏览器确认时的用户提示（配对或 🔔 授权都可能走到） */
const waitingHint = ({ name, fingerprint }) =>
  console.error(`等待浏览器确认：${name}（指纹 ${fingerprint.slice(0, 16)}…）——请在弹窗中允许`);

/**
 * 取一条私密记录（§6.2 寻址）。成功返回明文内容；失败抛错（code 原样透传）。
 * 调用方负责"用完即弃"：JS 字符串不可真正清零（V8 可能保留副本），
 * 只能尽快切断引用——明文不落盘、不明文显示的保证由链路设计承担（§11）。
 */
async function getSecret(path) {
  const res = await secureRequest(
    { type: 'get', payload: { path } },
    { onWaitingConfirm: waitingHint },
  );
  if (res.type !== 'result' || typeof res.payload?.content !== 'string') {
    throw new Error(`未预期响应：${JSON.stringify(res)}`);
  }
  return res.payload.content;
}

async function main() {
  if (cmd === 'get') {
    const path = rest[0];
    if (!path || rest.length !== 1) {
      console.error('用法：vipper-cli get <条目路径>（格式 <书签title>/<secret记录name>）');
      process.exitCode = 2;
      return;
    }
    let content = await getSecret(path);
    process.stdout.write(`${content}\n`); // 密码命令 / 进程替换消费 stdout 第一行
    content = null; // 写完即切断引用（尽力而为，见 getSecret 注释）
    return;
  }
  if (cmd === 'run') {
    // 解析：-e/--env VAR=path 可重复，-- 之后为子进程命令
    const injections = [];
    let i = 0;
    while (i < rest.length && rest[i] !== '--') {
      if (rest[i] === '-e' || rest[i] === '--env') {
        const spec = rest[i + 1];
        const eq = spec?.indexOf('=') ?? -1;
        if (eq === undefined || eq <= 0) {
          console.error(`-e 参数格式应为 VAR=<条目路径>，收到：${spec ?? '(缺失)'}`);
          process.exitCode = 2;
          return;
        }
        injections.push({ name: spec.slice(0, eq), path: spec.slice(eq + 1) });
        i += 2;
      } else {
        console.error(`未知参数：${rest[i]}（run 只接受 -e VAR=<条目路径>，-- 之后为命令）`);
        process.exitCode = 2;
        return;
      }
    }
    const childCmd = rest[i + 1];
    const childArgs = rest.slice(i + 2);
    if (rest[i] !== '--' || !childCmd || injections.length === 0) {
      console.error('用法：vipper-cli run -e VAR=<条目路径> [-e …] -- <cmd> [args...]');
      process.exitCode = 2;
      return;
    }
    // 串行取密钥：任一失败即整体中止（不带着半套环境变量启动子进程）
    const env = { ...process.env };
    for (const { name, path } of injections) {
      env[name] = await getSecret(path);
    }
    const child = spawn(childCmd, childArgs, { stdio: 'inherit', env });
    for (const { name } of injections) delete env[name]; // 切断引用（尽力而为）
    child.on('error', (err) => {
      console.error(`启动子进程失败：${err.message}`);
      process.exitCode = 1;
    });
    child.on('close', (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
    });
    return;
  }
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
      { onWaitingConfirm: waitingHint },
    );
    console.log(`已配对：${res.payload?.from ?? 'vipper-extension'}（通道加密可用）`);
    return;
  }
  if (cmd === 'sping') {
    const msg = rest.join(' ') || 'sping';
    const res = await secureRequest(
      { type: 'ping', payload: { msg } },
      { onWaitingConfirm: waitingHint },
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
