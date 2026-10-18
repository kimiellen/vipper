/**
 * Alt+P 填充的页面侧：表单探测/填充 + 浮层 UI（账号二级菜单 / 解锁 / 提示）。
 *
 * - 表单填充用原生 setter + input/change 事件，兼容 React/Vue 受控组件
 * - 填充后给字段加 200ms 弹跳类（assets/fill-animation.css，系统减少动效时自动禁用）
 * - 浮层挂在 shadow DOM 内，避免页面 CSS 干扰
 * - 明文凭据只在 SW 解密后经消息传入本页面，填充即弃
 */

import '../assets/fill-animation.css';

interface Candidate {
  bookmarkId: string;
  accountIndex: number;
  text: string; // "书签名 · username"
}

type Msg =
  | { type: 'vipper:fill'; username: string; password: string }
  | { type: 'vipper:picker'; candidates: Candidate[] }
  | { type: 'vipper:toast'; text: string };

// ---------- 表单填充 ----------

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

/** 写值并派发 input；change 只在最终提交时派发 */
function writeValue(el: HTMLInputElement, value: string, change = false): void {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (change) el.dispatchEvent(new Event('change', { bubbles: true }));
}

const TYPE_INTERVAL_MS = 20;
const TYPE_BUDGET_MS = 1000;

/** 逐字写入：每字派发 input，结束时补一次完整值与 change（受控组件可能回滚中间态） */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  if (el.value) writeValue(el, '');
  const interval = Math.max(8, Math.min(TYPE_INTERVAL_MS, Math.floor(TYPE_BUDGET_MS / Math.max(value.length, 1))));
  for (let i = 1; i <= value.length; i++) {
    writeValue(el, value.slice(0, i));
    if (i < value.length) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  writeValue(el, value, true);
}

/** 一次性写入（减少动效时跳过逐字） */
function setNativeValue(el: HTMLInputElement, value: string): void {
  writeValue(el, value, true);
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

/** 填充反馈：加类触发 assets/fill-animation.css 的 200ms 弹跳；定时清理（减少动效下 animationend 不触发） */
const FILL_ANIM_CLASS = 'vipper-animated-fill';
const FILL_ANIM_MS = 200;

function animateFill(el: HTMLInputElement): void {
  el.classList.add(FILL_ANIM_CLASS);
  setTimeout(() => el.classList.remove(FILL_ANIM_CLASS), FILL_ANIM_MS);
}

const reduceMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

let filling = false;

async function fill(username: string, password: string): Promise<boolean> {
  // 逐字输入耗时较长，避免连按 Alt+P 时两轮写入互相覆盖
  if (filling) return true;
  filling = true;
  try {
    const reduced = reduceMotion();
    const u = findField('username');
    if (u) {
      if (reduced) setNativeValue(u, username);
      else await typeInto(u, username);
      animateFill(u);
    }

    const p = findField('password');
    if (!p) return !!u;

    // 账号弹跳结束后再填密码，形成先后节奏；减少动效时无动画可等，直接一起填
    if (u && !reduced) {
      await new Promise((resolve) => setTimeout(resolve, FILL_ANIM_MS));
    }

    // 站点可能在用户名输入后替换密码框，重新探测后再写入
    const target = findField('password') ?? p;
    if (reduced) setNativeValue(target, password);
    else await typeInto(target, password);
    animateFill(target);
    return true;
  } finally {
    filling = false;
  }
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

// ---------- 消息入口 ----------

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // safeSend 补注入与正常注入可能重叠，避免重复注册消息监听
    const g = globalThis as typeof globalThis & { __vipperContentLoaded?: boolean };
    if (g.__vipperContentLoaded) return;
    g.__vipperContentLoaded = true;

    chrome.runtime.onMessage.addListener((msg: Msg) => {
      switch (msg.type) {
        case 'vipper:fill':
          closeOverlay(); // 先收起解锁框/菜单，避免盖住逐字过程
          void fill(msg.username, msg.password).then((ok) => {
            if (!ok) showToast('未找到登录表单');
          });
          break;
        case 'vipper:picker':
          showPicker(msg.candidates);
          break;
        case 'vipper:toast':
          showToast(msg.text);
          break;
      }
    });
  },
});
