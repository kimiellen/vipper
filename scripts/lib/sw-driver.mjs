/**
 * CDP 共享驱动：连接 Chromium（端口 9333）并附加到 vipper 的 service worker。
 * 供 scripts/ 下各里程碑验收脚本复用。启动方式见 AGENTS.md「自动化测试回路」。
 */

export async function connectSW(port = 9333) {
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  function raw(method, params = {}, sessionId) {
    return new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  let swTarget = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    const t = m.params?.targetInfo;
    if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged')
      && t?.type === 'service_worker' && t.url.includes('background')) swTarget = t;
  };
  await raw('Target.setDiscoverTargets', { discover: true });
  // MV3 SW 事件驱动，启动后 30s 休眠；休眠则等 targetCreated 重新出现
  for (let i = 0; i < 60 && !swTarget; i++) await new Promise((r) => setTimeout(r, 500));
  if (!swTarget) throw new Error('service worker not found（扩展未加载？）');

  const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });

  /** 在 SW 上下文执行表达式，返回 by-value 结果；SW 内异常会抛出 */
  async function sw(expression) {
    const r = await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error('SW eval error: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }

  return { sw, close: () => ws.close() };
}

/** 断言收集器：结束时打印汇总并按结果设置退出码 */
export function createChecker() {
  const results = [];
  return {
    check(name, cond, actual) {
      results.push(cond);
      console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' 实际: ' + JSON.stringify(actual)}`);
    },
    summary() {
      const failed = results.filter((r) => !r).length;
      console.log(`\n${results.length - failed}/${results.length} 通过`);
      process.exitCode = failed ? 1 : 0;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
