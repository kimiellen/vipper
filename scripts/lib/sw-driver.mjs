/**
 * CDP 共享驱动：连接 Chromium（端口 9333），附加到 vipper 的 service worker 或扩展页面。
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

  // 维护全量 target 清单（发现 + 变更 + 销毁）
  const targets = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    const t = m.params?.targetInfo;
    if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') targets.set(t.targetId, t);
    if (m.method === 'Target.targetDestroyed') targets.delete(m.params.targetId);
  };
  await raw('Target.setDiscoverTargets', { discover: true });

  async function waitTarget(pred, desc) {
    for (let i = 0; i < 40; i++) {
      const hit = [...targets.values()].find(pred);
      if (hit) return hit;
      await sleep(250);
    }
    throw new Error(`target not found: ${desc}`);
  }

  async function attachEval(targetId) {
    const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const fn = async (expression) => {
      const r = await raw('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.result?.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    // 暴露 session 级原语（Input.dispatchKeyEvent 等可信输入事件）
    fn.send = (method, params = {}) => raw(method, params, sessionId);
    return fn;
  }

  // MV3 SW 事件驱动，启动后 30s 休眠；休眠则等 targetCreated 重新出现
  const swTarget = await waitTarget(
    (t) => t.type === 'service_worker' && t.url.includes('background'),
    'service worker（扩展未加载？）',
  );
  const sw = await attachEval(swTarget.targetId);

  /** 等待并附加到 URL 包含 urlPart 的页面（如扩展弹窗），返回页面内 eval 函数 */
  async function attachPage(urlPart) {
    const t = await waitTarget((x) => x.type === 'page' && x.url.includes(urlPart), `page:${urlPart}`);
    return attachEval(t.targetId);
  }

  /** 当前是否存在 URL 含 urlPart 的页面（用于断言弹窗已关闭） */
  function hasPage(urlPart) {
    return [...targets.values()].some((x) => x.type === 'page' && x.url.includes(urlPart));
  }

  return { sw, attachPage, hasPage, close: () => ws.close() };
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
