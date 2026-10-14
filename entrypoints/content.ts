/**
 * Alt+P 填充的页面侧：表单探测/填充 + 浮层 UI（账号二级菜单 / 解锁 / 提示）。
 *
 * - 表单填充用原生 setter + input/change 事件，兼容 React/Vue 受控组件
 * - 浮层挂在 shadow DOM 内，避免页面 CSS 干扰
 * - 明文凭据只在 SW 解密后经消息传入本页面，填充即弃
 */

interface Candidate {
  bookmarkId: string;
  accountIndex: number;
  text: string; // "书签名 · username"
}

type Msg =
  | { type: 'vipper:fill'; username: string; password: string }
  | { type: 'vipper:picker'; candidates: Candidate[] }
  | { type: 'vipper:locked' }
  | { type: 'vipper:unlock-failed' }
  | { type: 'vipper:toast'; text: string };

// ---------- 表单填充 ----------

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findField(kind: 'username' | 'password'): HTMLInputElement | null {
  if (kind === 'password') {
    return document.querySelector<HTMLInputElement>('input[type="password"]:not([disabled])');
  }
  const byAutocomplete = document.querySelector<HTMLInputElement>(
    'input[autocomplete="username"], input[autocomplete="email"]',
  );
  if (byAutocomplete) return byAutocomplete;
  const candidates = document.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
  );
  const re = /user|email|login|account|phone|name/i;
  for (const el of candidates) {
    if (el.disabled || el.type === 'hidden') continue;
    if (re.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`)) return el;
  }
  return candidates[0] ?? null;
}

function fill(username: string, password: string): boolean {
  const u = findField('username');
  const p = findField('password');
  if (u) setNativeValue(u, username);
  if (p) setNativeValue(p, password);
  return !!(u || p);
}

// ---------- 浮层（shadow DOM） ----------

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

const CSS = `
  .panel {
    position: fixed; top: 20%; left: 50%; transform: translateX(-50%);
    min-width: 280px; max-width: 90vw; z-index: 2147483647;
    background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; border-radius: 10px;
    font: 14px/1.5 system-ui, sans-serif; padding: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5);
  }
  .item { padding: 8px 12px; border-radius: 6px; }
  .item.selected { background: #45475a; }
  .msg { padding: 8px 12px; }
  input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px;
    background: #313244; color: #cdd6f4; border: 2px solid #45475a; border-radius: 6px; outline: none;
  }
  .err { color: #f38ba8; padding: 4px 12px 0; font-size: 12px; }
`;

function ensureOverlay(): ShadowRoot {
  if (host && shadow) return shadow;
  host = document.createElement('div');
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);
  document.documentElement.append(host);
  return shadow;
}

function closeOverlay(): void {
  host?.remove();
  host = null;
  shadow = null;
}

function showToast(text: string): void {
  const s = ensureOverlay();
  s.querySelector('.panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="msg"></div>`;
  panel.querySelector('.msg')!.textContent = text;
  s.append(panel);
  setTimeout(closeOverlay, 2000);
}

/** 账号二级菜单：↑/↓ 选择，Enter 确认，Esc 关闭 */
function showPicker(candidates: Candidate[]): void {
  const s = ensureOverlay();
  s.querySelector('.panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'panel';
  let selected = 0;

  const render = () => {
    panel.innerHTML = '';
    candidates.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = `item${i === selected ? ' selected' : ''}`;
      div.textContent = c.text;
      panel.append(div);
    });
  };
  render();
  s.append(panel);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { selected = Math.min(selected + 1, candidates.length - 1); render(); }
    else if (e.key === 'ArrowUp') { selected = Math.max(selected - 1, 0); render(); }
    else if (e.key === 'Enter') {
      cleanup();
      const c = candidates[selected];
      if (!c) return;
      void chrome.runtime.sendMessage({
        type: 'vipper:fill-request', bookmarkId: c.bookmarkId, accountIndex: c.accountIndex,
      });
    } else if (e.key === 'Escape') { cleanup(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    closeOverlay();
  };
  document.addEventListener('keydown', onKey, true);
}

/** 锁定状态：浮层内输主密码解锁 */
function showUnlock(): void {
  const s = ensureOverlay();
  s.querySelector('.panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="msg">密码库已锁定，输入主密码解锁</div><input type="password" /><div class="err" hidden>密码错误</div>`;
  const input = panel.querySelector('input')!;
  const err = panel.querySelector<HTMLElement>('.err')!;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void chrome.runtime.sendMessage({ type: 'vipper:unlock', password: input.value });
      input.value = '';
    } else if (e.key === 'Escape') {
      closeOverlay();
    }
    e.stopPropagation();
  });
  s.append(panel);
  input.focus();
  panel.dataset.kind = 'unlock';
  err.id = 'unlock-err';
}

function showUnlockFailed(): void {
  const err = shadow?.querySelector<HTMLElement>('.err');
  if (err) err.hidden = false;
}

// ---------- 消息入口 ----------

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg) => {
      switch (msg.type) {
        case 'vipper:fill':
          if (!fill(msg.username, msg.password)) showToast('未找到登录表单');
          else closeOverlay();
          break;
        case 'vipper:picker':
          showPicker(msg.candidates);
          break;
        case 'vipper:locked':
          showUnlock();
          break;
        case 'vipper:unlock-failed':
          showUnlockFailed();
          break;
        case 'vipper:toast':
          showToast(msg.text);
          break;
      }
    });
  },
});
