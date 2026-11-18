/**
 * 配对确认窗（socket-access.md §7）：chrome.windows.create 拉起的独立小窗。
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

const TIMEOUT_MS = 60_000; // 与 SW 侧 PAIR_TIMEOUT_MS 同口径：超时默认拒绝
const PENDING_PREFIX = 'socket.pending.';

const pendingId = new URLSearchParams(location.search).get('req');

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 不存在`);
  return el;
}

function showExpired(reason: string): void {
  $('panel').hidden = true;
  $('expired').hidden = false;
  $('expired-reason').textContent = reason;
}

async function readPending(): Promise<PendingPair | null> {
  if (!pendingId) return null;
  const got = (await chrome.storage.session.get(PENDING_PREFIX + pendingId)) as Record<string, PendingPair>;
  return got[PENDING_PREFIX + pendingId] ?? null;
}

function render(p: PendingPair): void {
  $('f-name-lead').textContent = p.name;
  $('f-name').textContent = p.name;
  $('f-version').textContent = p.version || '未知';
  $('f-exe').textContent = p.exePath ?? '未知';
  $('f-pid').textContent = p.pid === null ? '未知' : String(p.pid);
  $('f-fp').textContent = `${p.fingerprint.slice(0, 16)}…`;
}

async function decide(approve: boolean): Promise<void> {
  if (!pendingId) return;
  const res = (await chrome.runtime.sendMessage({
    type: 'socket.pair.decide',
    pendingId,
    approve,
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
  render(pending);
  $('btn-allow').addEventListener('click', () => void decide(true));
  $('btn-deny').addEventListener('click', () => void decide(false));

  // 倒计时 + pending 存活轮询：超时/他处结案即时反映（SW 侧 60s 默认拒绝）
  setInterval(() => {
    const remain = Math.ceil((pending.at + TIMEOUT_MS - Date.now()) / 1000);
    if (remain <= 0) {
      showExpired('请求已超时（60s 未决定，默认拒绝）。');
      return;
    }
    $('countdown').textContent = `${remain}s 后自动拒绝`;
    void readPending().then((p) => {
      if (!p) showExpired('该请求已被处理。');
    });
  }, 1000);
}

void main();
