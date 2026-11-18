/**
 * 确认窗（socket-access.md §7）：chrome.windows.create 拉起的独立小窗，两种请求共用：
 * - kind=pair  配对确认（M41）：新客户端登记，允许后建立加密通道
 * - kind=authz 授权确认（M42 §6.1 🔔）：按条目读取私密记录，仅此一次 / 记住此客户端 / 拒绝
 * 待确认请求由 SW 落在 chrome.storage.session（SW 回收不丢），本页按 ?req=<pendingId> 读取渲染；
 * 决定经 runtime message 回 SW 统一收口（允许/拒绝/超时三种结案都在 SW 侧落终态）。
 */

interface PendingPair {
  pendingId: string;
  name: string;
  version: string;
  pid: number | null;
  exePath: string | null;
  identityPub: string;
  sessionPub: string;
  fingerprint: string;
  at: number;
}

interface PendingAuthz {
  pendingId: string;
  sessionId: string;
  path: string;
  fingerprint: string;
  clientName: string;
  pid: number | null;
  exePath: string | null;
  at: number;
}

const TIMEOUT_MS = 60_000; // 与 SW 侧 PAIR/ASK_TIMEOUT_MS 同口径：超时默认拒绝
const PENDING_PREFIX = 'socket.pending.';
const AUTHZ_PREFIX = 'socket.authz.';

const params = new URLSearchParams(location.search);
const pendingId = params.get('req');
const kind = params.get('kind') === 'authz' ? 'authz' : 'pair';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 不存在`);
  return el;
}

function showExpired(reason: string): void {
  $('panel').hidden = true;
  $('panel-authz').hidden = true;
  $('expired').hidden = false;
  $('expired-reason').textContent = reason;
}

function storageKey(): string {
  return (kind === 'authz' ? AUTHZ_PREFIX : PENDING_PREFIX) + pendingId;
}

async function readPending(): Promise<PendingPair | PendingAuthz | null> {
  if (!pendingId) return null;
  const got = (await chrome.storage.session.get(storageKey())) as Record<string, PendingPair & PendingAuthz>;
  return got[storageKey()] ?? null;
}

function renderPair(p: PendingPair): void {
  $('f-name-lead').textContent = p.name;
  $('f-name').textContent = p.name;
  $('f-version').textContent = p.version || '未知';
  $('f-exe').textContent = p.exePath ?? '未知';
  $('f-pid').textContent = p.pid === null ? '未知' : String(p.pid);
  $('f-fp').textContent = `${p.fingerprint.slice(0, 16)}…`;
}

function renderAuthz(p: PendingAuthz): void {
  $('panel-authz').hidden = false;
  $('a-name-lead').textContent = p.clientName;
  $('a-path').textContent = p.path;
  $('a-name').textContent = p.clientName;
  $('a-exe').textContent = p.exePath ?? '未知';
  $('a-pid').textContent = p.pid === null ? '未知' : String(p.pid);
  $('a-fp').textContent = `${p.fingerprint.slice(0, 16)}…`;
}

async function decidePair(approve: boolean): Promise<void> {
  if (!pendingId) return;
  const res = (await chrome.runtime.sendMessage({
    type: 'socket.pair.decide',
    pendingId,
    approve,
  })) as { ok: boolean; reason?: string } | undefined;
  if (res?.ok) window.close();
  else showExpired('该请求已被处理或超时（默认拒绝）。');
}

async function decideAuthz(decision: 'once' | 'remember' | 'deny'): Promise<void> {
  if (!pendingId) return;
  const res = (await chrome.runtime.sendMessage({
    type: 'socket.authz.decide',
    pendingId,
    decision,
  })) as { ok: boolean; reason?: string } | undefined;
  if (res?.ok) window.close();
  else showExpired('该请求已被处理或超时（默认拒绝）。');
}

async function main(): Promise<void> {
  const pending = await readPending();
  if (!pending) {
    showExpired('该请求已失效（可能已被处理、超时或浏览器重启）。');
    return;
  }
  if (kind === 'authz') {
    $('panel').hidden = true;
    renderAuthz(pending as PendingAuthz);
    $('a-btn-once').addEventListener('click', () => void decideAuthz('once'));
    $('a-btn-remember').addEventListener('click', () => void decideAuthz('remember'));
    $('a-btn-deny').addEventListener('click', () => void decideAuthz('deny'));
  } else {
    renderPair(pending as PendingPair);
    $('btn-allow').addEventListener('click', () => void decidePair(true));
    $('btn-deny').addEventListener('click', () => void decidePair(false));
  }
  const countdownEl = kind === 'authz' ? $('a-countdown') : $('countdown');

  // 倒计时 + pending 存活轮询：超时/他处结案即时反映（SW 侧 60s 默认拒绝）
  setInterval(() => {
    const remain = Math.ceil((pending.at + TIMEOUT_MS - Date.now()) / 1000);
    if (remain <= 0) {
      showExpired('请求已超时（60s 未决定，默认拒绝）。');
      return;
    }
    countdownEl.textContent = `${remain}s 后自动拒绝`;
    void readPending().then((p) => {
      if (!p) showExpired('该请求已被处理。');
    });
  }, 1000);
}

void main();
