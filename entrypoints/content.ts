/**
 * Alt+P 填充的页面侧：表单探测/填充 + 浮层 UI（账号二级菜单 / 解锁 / 提示）。
 *
 * - 表单填充用原生 setter + input/change 事件，兼容 React/Vue 受控组件
 * - 填充后给字段加 200ms 弹跳类（assets/fill-animation.css，系统减少动效时自动禁用）
 * - 浮层挂在 shadow DOM 内，避免页面 CSS 干扰
 * - 明文凭据只在 SW 解密后经消息传入本页面，填充即弃
 */

import '../assets/fill-animation.css';
import {
  PASSWORD_SELECTOR,
  USERNAME_AUTOCOMPLETE_SELECTOR,
  USERNAME_CANDIDATE_SELECTOR,
  USERNAME_HINT_RE,
} from '../utils/loginForm';

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

/** 定时器节流判定余量：正常 20ms/200ms 定时器不会超过「设定值 + 该余量」 */
const TIMER_CLAMP_SLACK_MS = 120;

/** 本轮填充是否已确认定时器被浏览器节流（跨域 iframe 不可见时 setTimeout 会被钳到 ~1s） */
let timersClamped = false;

/** 等待 ms；返回 true 表示实际耗时明显超标，即定时器被节流 */
async function waitWithClampCheck(ms: number): Promise<boolean> {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return performance.now() - start > ms + TIMER_CLAMP_SLACK_MS;
}

/** 逐字写入：每字派发 input，结束时补一次完整值与 change（受控组件可能回滚中间态） */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  if (el.value) writeValue(el, '');
  // 定时器被节流时逐字等待会变成 1 秒/字，直接整段写入
  if (timersClamped) {
    writeValue(el, value, true);
    return;
  }
  const interval = Math.max(8, Math.min(TYPE_INTERVAL_MS, Math.floor(TYPE_BUDGET_MS / Math.max(value.length, 1))));
  for (let i = 1; i <= value.length; i++) {
    writeValue(el, value.slice(0, i));
    if (i === value.length) break;
    if (await waitWithClampCheck(interval)) {
      timersClamped = true;
      writeValue(el, value, true);
      return;
    }
  }
  writeValue(el, value, true);
}

/** 一次性写入（减少动效时跳过逐字） */
function setNativeValue(el: HTMLInputElement, value: string): void {
  writeValue(el, value, true);
}

/** 部分站点会放 0 尺寸的隐藏密码框作诱饵（如 163 邮箱），填充只认可见字段 */
function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function usernameHinted(el: HTMLInputElement): boolean {
  return USERNAME_HINT_RE.test(
    `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`,
  );
}

/** 账号框候选：优先可见字段；全部不可见时退回全量候选，兼容布局尚未完成的页面 */
function usernameCandidates(): HTMLInputElement[] {
  const all = [...document.querySelectorAll<HTMLInputElement>(USERNAME_CANDIDATE_SELECTOR)]
    .filter((el) => !el.disabled && el.type !== 'hidden');
  const shown = all.filter(isVisible);
  return shown.length > 0 ? shown : all;
}

function findPassword(): HTMLInputElement | null {
  return [...document.querySelectorAll<HTMLInputElement>(PASSWORD_SELECTOR)].find(isVisible) ?? null;
}

/** 同一作用域内离密码框最近的账号框：优先 DOM 中紧邻密码框之前的文本框 */
function nearestToPassword(pool: HTMLInputElement[], password: HTMLInputElement): HTMLInputElement | null {
  const before = pool.filter(
    (el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  if (before.length > 0) return before[before.length - 1]!;
  const after = pool.filter(
    (el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_PRECEDING,
  );
  return after[0] ?? pool[0] ?? null;
}

/**
 * 账号框探测：有密码框时以它锚定——优先同一 form 内、紧邻密码框之前的可见文本框。
 * 很多站点（如 Steam）不给账号框任何 name/id/placeholder 语义，旧逻辑会回落到页面
 * 第一个文本框（页头搜索框）；用密码框的上下文才能把它和搜索框区分开。
 */
function findUsername(password: HTMLInputElement | null): HTMLInputElement | null {
  const candidates = usernameCandidates();
  const byAutocomplete = candidates.find((el) => el.matches(USERNAME_AUTOCOMPLETE_SELECTOR));
  if (byAutocomplete) return byAutocomplete;

  if (!password) return candidates.find(usernameHinted) ?? candidates[0] ?? null;

  // 优先在密码框所在 form 内找；账号框在 form 外（不规范标记）时退回全页
  const inForm = password.form ? candidates.filter((el) => el.form === password.form) : [];
  const pool = inForm.length > 0 ? inForm : candidates;
  return pool.find(usernameHinted) ?? nearestToPassword(pool, password);
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
  timersClamped = false; // 每次填充重新测量，页面可能已经回到可见状态
  try {
    const reduced = reduceMotion();
    const p0 = findPassword(); // 仅用于给账号框定位提供上下文；填密码前会重新探测
    const u = findUsername(p0);
    if (u) {
      if (reduced) setNativeValue(u, username);
      else await typeInto(u, username);
      animateFill(u);
    }

    const p = findPassword();
    if (!p) return !!u;

    // 账号弹跳结束后再填密码，形成先后节奏；减少动效或定时器已被节流时不再等待
    if (u && !reduced && !timersClamped) {
      if (await waitWithClampCheck(FILL_ANIM_MS)) timersClamped = true;
    }

    // 站点可能在用户名输入后替换密码框，重新探测后再写入
    const target = findPassword() ?? p;
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
  // 登录表单常被放在跨域 iframe 内（如 163 邮箱），顶层脚本无法访问其 DOM。
  // 每个 frame 都注入，填充由 SW 探测后定向发送；菜单/toast 只发往顶层 frame。
  allFrames: true,
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
