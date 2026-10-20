/**
 * Alt+P 填充的页面侧：表单探测/填充 + 浮层 UI（账号二级菜单 / 解锁 / 提示）。
 *
 * - 表单填充用原生 setter + input/change 事件，兼容 React/Vue 受控组件
 * - 填充后给字段加 200ms 弹跳类（assets/fill-animation.css，系统减少动效时自动禁用）
 * - 浮层挂在 shadow DOM 内，避免页面 CSS 干扰
 * - 明文凭据只在 SW 解密后经消息传入本页面，填充即弃
 */

import tokensCss from '../design-system/tokens.css?inline';
import '../assets/fill-animation.css';
import { PASSWORD_SELECTOR, USERNAME_AUTOCOMPLETE_SELECTOR, USERNAME_CANDIDATE_SELECTOR, USERNAME_HINT_RE } from '../utils/loginForm';
import { hostnameOf } from '../utils/matchUrl';

interface Candidate {
  bookmarkId: string;
  accountIndex: number;
  text: string; // "书签名 · username"
}

interface PromptTag { id: string; name: string; color: string }
interface PromptLink { id: string; name: string; value: string }

/** M22 只有新建态；M23 追加态在此扩展 */
interface SavePrompt {
  kind: 'new';
  title: string;
  url: string;
  username: string;
  tags: PromptTag[];
  links: PromptLink[];
  lang: 'zh' | 'en';
  theme: 'dark' | 'light' | 'system';
}

type Msg =
  | { type: 'vipper:fill'; username: string; password: string }
  | { type: 'vipper:picker'; candidates: Candidate[] }
  | { type: 'vipper:toast'; text: string }
  | ({ type: 'vipper:save-prompt' } & SavePrompt)
  | { type: 'vipper:save-result'; ok: boolean; message?: string };

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

/** 本 frame 最近一次 vipper 自动填充的值：提交时原样未改动则不再捕获（spec 2026-10-20） */
let lastAutofill: { username: string; password: string } | null = null;

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
    if (!p) {
      lastAutofill = { username, password };
      return !!u;
    }

    // 账号弹跳结束后再填密码，形成先后节奏；减少动效或定时器已被节流时不再等待
    if (u && !reduced && !timersClamped) {
      if (await waitWithClampCheck(FILL_ANIM_MS)) timersClamped = true;
    }

    // 站点可能在用户名输入后替换密码框，重新探测后再写入
    const target = findPassword() ?? p;
    if (reduced) setNativeValue(target, password);
    else await typeInto(target, password);
    animateFill(target);
    lastAutofill = { username, password };
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
    outline: none; /* 程序化聚焦用于接住键盘，不需要焦点环 */
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
  // 登录表单可能在跨域 iframe 内，焦点也在那边；不转移焦点的话键盘事件不会到达顶层 document。
  // 先把焦点收进菜单，关闭时再还给原来的元素（通常是 iframe，浏览器会恢复其内部焦点）。
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const s = ensureOverlay();
  s.querySelector('.panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.tabIndex = -1;
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
  panel.focus({ preventScroll: true });

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
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  document.addEventListener('keydown', onKey, true);
}

// ---------- 登录提交自动保存：浮卡 ----------

/**
 * shadow DOM 不继承页面 :root 的 token，只能把 tokens.css 注入 shadow。
 * `?inline` 让 Vite 返回 CSS 字符串而不注入文档；`:root` 改写成 `:host` 后
 * 双主题（Mocha / Latte）在浮卡内同样生效，且不硬编码任何色值。
 */
const SHADOW_TOKENS = tokensCss
  // Vite 会压缩 `[data-theme="light"]` 为 `[data-theme=light]`，两种写法都要匹配；
  // 且必须转成函数式 `:host([...])`——`:host[...]` 在 Chrome 里不匹配 host。
  .replace(/:root\[data-theme=(?:"light"|'light'|light)\]/g, ':host([data-theme="light"])')
  .replace(/:root/g, ':host');

const SAVE_CSS = `
:host { all: initial; }
${SHADOW_TOKENS}
:host {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  width: 360px; max-width: calc(100vw - 32px);
  font-family: var(--font-family); font-size: var(--text-base); color: var(--fg);
  line-height: 1.5; text-align: left;
}
*, *::before, *::after { box-sizing: border-box; }
.card {
  background: var(--bg-raised); color: var(--fg);
  border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg); overflow: visible;
  animation: vipper-save-in 150ms ease-out;
}
.head {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--bg); border-bottom: 1px solid var(--border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
.icon { color: var(--accent); display: flex; flex: none; }
.head-title { flex: 1; font-size: var(--text-base); font-weight: var(--weight-semibold); }
.x {
  background: none; border: 0; padding: 0 var(--space-1); cursor: pointer;
  color: var(--fg-muted); font: inherit; font-size: var(--text-lg); line-height: 1;
}
.x:hover { color: var(--fg); }
.body { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4); }
.row { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: center; gap: var(--space-2); min-height: 30px; }
.k { color: var(--fg-muted); font-size: var(--text-sm); }
.v { color: var(--fg); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--font-mono); letter-spacing: 1px; }
.input {
  width: 100%; padding: var(--space-1) var(--space-2);
  background: var(--bg-subtle); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  color: var(--fg); font: inherit; font-size: var(--text-sm);
}
.input:focus { outline: none; border-color: var(--accent); }
.msel { position: relative; min-width: 0; }
.msel summary {
  list-style: none; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-subtle); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  color: var(--fg-secondary); font-size: var(--text-sm);
}
.msel summary::-webkit-details-marker { display: none; }
.msel[open] summary { border-color: var(--accent); color: var(--fg); }
.msel-pop {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 2;
  min-width: 200px; max-width: 280px; max-height: 220px; overflow: auto;
  display: grid; gap: 2px; padding: var(--space-2);
  background: var(--bg-raised); border: 1px solid var(--border-strong);
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
}
.msel-pop label {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 4px 6px; border-radius: var(--radius-sm);
  color: var(--fg-secondary); font-size: var(--text-sm); cursor: pointer;
}
.msel-pop label:hover { background: var(--bg-subtle); }
.msel-pop input { margin: 0; accent-color: var(--accent); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--cat-mauve); }
.none { color: var(--fg-muted); font-size: var(--text-sm); }
.foot {
  display: flex; justify-content: flex-end; gap: var(--space-2);
  padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border);
}
.btn {
  font: inherit; font-size: var(--text-sm); cursor: pointer;
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-md);
  border: 1px solid transparent;
}
.btn.ghost { background: transparent; color: var(--fg-secondary); border-color: var(--border-strong); }
.btn.ghost:hover { background: var(--bg-subtle); color: var(--fg); }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { background: var(--accent-hover); }
.btn:disabled { opacity: .6; cursor: default; }
@keyframes vipper-save-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
`;

interface SaveText {
  saveTitle: string;
  title: string;
  url: string;
  username: string;
  password: string;
  tags: string;
  lins: string;
  save: string;
  cancel: string;
  saved: string;
  saveFailed: string;
  close: string;
  noTags: string;
  noLinks: string;
  none: string;
  selected: (n: number) => string;
}

const SAVE_TEXT: Record<'zh' | 'en', SaveText> = {
  zh: {
    saveTitle: '保存到 vipper', title: '标题', url: '网址', username: '账号', password: '密码',
    tags: 'TAGS', lins: 'LINS', save: '保存', cancel: '不保存',
    saved: '已保存到 vipper', saveFailed: '保存失败', close: '关闭',
    noTags: '暂无 tag，去 Alt+. → Settings 添加', noLinks: '暂无关联信息',
    none: '未选', selected: (n) => `已选 ${n}`,
  },
  en: {
    saveTitle: 'Save to vipper', title: 'Title', url: 'URL', username: 'Account', password: 'Password',
    tags: 'TAGS', lins: 'LINS', save: 'Save', cancel: 'Not now',
    saved: 'Saved to vipper', saveFailed: 'Save failed', close: 'Close',
    noTags: 'No tags yet — add them in Alt+. → Settings', noLinks: 'No linked info yet',
    none: 'None', selected: (n) => `${n} selected`,
  },
};

interface MultiItem { id: string; text: string; color?: string }
interface SaveCardPatch { title?: string; tagIds?: string[]; linkIds?: string[] }

interface SaveRoot {
  prompt: SavePrompt;
  text: SaveText;
  host: HTMLDivElement;
  card: HTMLDivElement;
  titleInput: HTMLInputElement | null;
  tagSet: Set<string>;
  linkSet: Set<string>;
  syncTags: () => void;
  syncLinks: () => void;
  saveBtn: HTMLButtonElement;
  saving: boolean;
}

let saveRoot: SaveRoot | null = null;
let saveEscHandler: ((e: KeyboardEvent) => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function resolveTheme(theme: SavePrompt['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

/** 多选下拉：与 wui 顶栏 TAGS/LINS 同款 details + checkbox 弹层 */
function buildMulti(
  label: string,
  items: MultiItem[],
  text: SaveText,
  emptyText: string,
  selected: Set<string>,
): { row: HTMLElement; sync: () => void } {
  const row = el('div', 'row');
  const key = el('span', 'k');
  key.textContent = label;
  row.append(key);

  if (items.length === 0) {
    const empty = el('span', 'none');
    empty.textContent = emptyText;
    row.append(empty);
    return { row, sync: () => {} };
  }

  const details = el('details', 'msel');
  const summary = el('summary');
  const pop = el('div', 'msel-pop');
  details.append(summary, pop);

  const sync = (): void => {
    summary.textContent = `${selected.size > 0 ? text.selected(selected.size) : text.none} ▾`;
    pop.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(cb.value);
    });
  };

  for (const item of items) {
    const lab = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = item.id;
    cb.checked = selected.has(item.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(item.id);
      else selected.delete(item.id);
      sync();
    });
    lab.append(cb);
    if (item.color) {
      const dot = el('span', 'dot');
      dot.style.background = `var(--cat-${item.color})`;
      lab.append(dot);
    }
    const name = el('span');
    name.textContent = item.text;
    lab.append(name);
    pop.append(lab);
  }
  sync();
  row.append(details);
  return { row, sync };
}

function infoRow(key: string, value: string, cls?: string): HTMLElement {
  const row = el('div', 'row');
  const k = el('span', 'k');
  k.textContent = key;
  const v = el('span', cls ? `v ${cls}` : 'v');
  v.textContent = value;
  v.title = value;
  row.append(k, v);
  return row;
}

function closeSaveCardDom(): void {
  if (saveEscHandler) {
    document.removeEventListener('keydown', saveEscHandler, true);
    saveEscHandler = null;
  }
  saveRoot?.host.remove();
  saveRoot = null;
}

/** notify=true 时同步丢弃 SW pending；替换/保存成功时只移除 DOM，避免误清新 pending */
function dismissSaveCard(notify: boolean): void {
  const had = saveRoot !== null;
  closeSaveCardDom();
  if (notify && had) {
    void chrome.runtime.sendMessage({ type: 'vipper:login-save', action: 'discard' }).catch(() => {});
  }
}

function confirmSave(): void {
  const root = saveRoot;
  if (!root || root.saving) return;
  root.saving = true;
  root.saveBtn.disabled = true;
  void chrome.runtime
    .sendMessage({
      type: 'vipper:login-save',
      action: 'save',
      title: root.titleInput?.value ?? '',
      tags: [...root.tagSet],
      linkedInfos: [...root.linkSet],
    })
    .catch(() => {
      if (!saveRoot) return;
      saveRoot.saving = false;
      saveRoot.saveBtn.disabled = false;
      showToast(saveRoot.text.saveFailed);
    });
}

function onSaveResult(msg: Extract<Msg, { type: 'vipper:save-result' }>): void {
  const text = saveRoot?.text ?? SAVE_TEXT.zh;
  if (msg.ok) {
    closeSaveCardDom();
    showToast(text.saved);
    return;
  }
  if (saveRoot) {
    saveRoot.saving = false;
    saveRoot.saveBtn.disabled = false;
  }
  showToast(`${text.saveFailed}: ${msg.message ?? ''}`);
}

function renderSaveCard(prompt: SavePrompt): void {
  closeSaveCardDom(); // 新捕获覆盖旧浮卡；不发送 discard，避免清掉新 pending
  if (prompt.kind !== 'new') return; // M23 追加态
  captureStats.prompts++;

  const text = SAVE_TEXT[prompt.lang] ?? SAVE_TEXT.zh;
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = SAVE_CSS;
  shadow.append(style);
  host.dataset.theme = resolveTheme(prompt.theme);

  const card = el('div', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', text.saveTitle);

  const head = el('div', 'head');
  const icon = el('span', 'icon');
  icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const headTitle = el('span', 'head-title');
  headTitle.textContent = text.saveTitle;
  const closeBtn = el('button', 'x');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', text.close);
  closeBtn.addEventListener('click', () => dismissSaveCard(true));
  head.append(icon, headTitle, closeBtn);

  const body = el('div', 'body');

  const titleRow = el('label', 'row');
  const titleKey = el('span', 'k');
  titleKey.textContent = text.title;
  const titleInput = el('input', 'input');
  titleInput.type = 'text';
  titleInput.value = prompt.title;
  titleInput.spellcheck = false;
  titleRow.append(titleKey, titleInput);

  const tagSet = new Set<string>();
  const linkSet = new Set<string>();
  const tagsUi = buildMulti(
    text.tags,
    prompt.tags.map((t) => ({ id: t.id, text: t.name, color: t.color })),
    text,
    text.noTags,
    tagSet,
  );
  const linksUi = buildMulti(
    text.lins,
    prompt.links.map((l) => ({ id: l.id, text: `${l.name} · ${l.value}` })),
    text,
    text.noLinks,
    linkSet,
  );

  body.append(
    titleRow,
    infoRow(text.url, hostnameOf(prompt.url)),
    infoRow(text.username, prompt.username),
    infoRow(text.password, '••••••••', 'mono'),
    tagsUi.row,
    linksUi.row,
  );

  const foot = el('div', 'foot');
  const cancelBtn = el('button', 'btn ghost');
  cancelBtn.type = 'button';
  cancelBtn.textContent = text.cancel;
  cancelBtn.addEventListener('click', () => dismissSaveCard(true));
  const saveBtn = el('button', 'btn primary');
  saveBtn.type = 'button';
  saveBtn.textContent = text.save;
  saveBtn.addEventListener('click', () => confirmSave());
  foot.append(cancelBtn, saveBtn);

  card.append(head, body, foot);
  shadow.append(card);
  document.documentElement.append(host);

  saveRoot = {
    prompt, text, host, card, titleInput, tagSet, linkSet,
    syncTags: tagsUi.sync, syncLinks: linksUi.sync, saveBtn, saving: false,
  };

  // Esc 丢弃但不拦截事件，页面自身的 Esc 行为不受影响
  saveEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismissSaveCard(true);
  };
  document.addEventListener('keydown', saveEscHandler, true);
}

function saveCardState(): Record<string, unknown> {
  const root = saveRoot;
  if (!root) return { visible: false };
  return {
    visible: true,
    kind: root.prompt.kind,
    lang: root.prompt.lang,
    theme: root.host.dataset.theme,
    bg: getComputedStyle(root.card).backgroundColor,
    title: root.titleInput?.value ?? '',
    url: root.prompt.url,
    username: root.prompt.username,
    tags: root.prompt.tags.map((t) => ({ id: t.id, name: t.name, checked: root.tagSet.has(t.id) })),
    links: root.prompt.links.map((l) => ({
      id: l.id, name: l.name, value: l.value, checked: root.linkSet.has(l.id),
    })),
  };
}

function setSaveCard(patch: SaveCardPatch): boolean {
  const root = saveRoot;
  if (!root) return false;
  if (typeof patch.title === 'string' && root.titleInput) root.titleInput.value = patch.title;
  if (Array.isArray(patch.tagIds)) {
    root.tagSet.clear();
    patch.tagIds.filter((id): id is string => typeof id === 'string').forEach((id) => root.tagSet.add(id));
    root.syncTags();
  }
  if (Array.isArray(patch.linkIds)) {
    root.linkSet.clear();
    patch.linkIds.filter((id): id is string => typeof id === 'string').forEach((id) => root.linkSet.add(id));
    root.syncLinks();
  }
  return true;
}

// ---------- 登录提交自动保存：捕获 ----------

interface CaptureStats {
  captures: number;
  skippedMultiPassword: number;
  skippedAutofill: number;
  duplicates: number;
  prompts: number;
}

const captureStats: CaptureStats = {
  captures: 0, skippedMultiPassword: 0, skippedAutofill: 0, duplicates: 0, prompts: 0,
};

let lastCaptureKey = '';
let lastCaptureAt = 0;

function visiblePasswordFields(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(PASSWORD_SELECTOR)]
    .filter((el) => !el.disabled && isVisible(el));
}

const SUBMIT_TEXT_RE = /登录|登陆|log\s*in|sign\s*in|login|submit|continue|next|确认|确定|立即登录/i;
const NON_SUBMIT_TEXT_RE = /显示|隐藏|show|hide|visible|eye|眼睛/i;

/** 提交类按钮判定：排除"显示/隐藏密码"的眼睛图标按钮 */
function isSubmitLike(target: Element): boolean {
  if (target instanceof HTMLInputElement) {
    if (target.type === 'submit') return true;
    return target.type === 'button' && SUBMIT_TEXT_RE.test(target.value);
  }
  const text = `${target.textContent ?? ''} ${target.getAttribute('aria-label') ?? ''} ${target.getAttribute('title') ?? ''}`;
  if (NON_SUBMIT_TEXT_RE.test(text)) return false;
  return SUBMIT_TEXT_RE.test(text);
}

/**
 * 读取本次提交的账号密码并发给 SW（明文只过境一次，SW 内存暂存）。
 * 过滤：非 http(s)、空值、≥2 个可见密码框（注册/改密）、刚自动填充未修改、2s 内重复。
 */
function captureLogin(): void {
  if (!/^https?:$/.test(location.protocol)) return;

  const visible = visiblePasswordFields();
  if (visible.length === 0) return;
  if (visible.length > 1) {
    captureStats.skippedMultiPassword++;
    return;
  }

  const passwordEl = visible[0]!;
  const username = findUsername(passwordEl)?.value.trim() ?? '';
  const password = passwordEl.value;
  if (!username || !password) return;
  if (lastAutofill && lastAutofill.username === username && lastAutofill.password === password) {
    captureStats.skippedAutofill++;
    return;
  }

  const key = `${username}\u0000${password}`;
  const now = Date.now();
  if (key === lastCaptureKey && now - lastCaptureAt < 2000) {
    captureStats.duplicates++;
    return;
  }
  lastCaptureKey = key;
  lastCaptureAt = now;
  captureStats.captures++;

  void chrome.runtime
    .sendMessage({
      type: 'vipper:login-capture',
      username,
      password,
      pageUrl: location.href,
      title: document.title,
      top: window === window.top,
    })
    .catch(() => {});

  // 页面跳转会销毁本 document，由 SW 的 tabs.onUpdated 推送弹窗；
  // SPA 无导航时 1s 后主动请求推送。
  setTimeout(() => {
    void chrome.runtime.sendMessage({ type: 'vipper:save-prompt-request' }).catch(() => {});
  }, 1000);
}

function installCaptureListeners(): void {
  document.addEventListener('submit', (e) => {
    if (!(e.target instanceof HTMLFormElement)) return;
    const password = visiblePasswordFields()[0];
    if (!password || !e.target.contains(password)) return;
    captureLogin();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'password') return;
    captureLogin();
  }, true);

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const button = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
    if (!button || !isSubmitLike(button)) return;
    if (!findPassword()) return;
    captureLogin();
  }, true);
}

function installDebugApi(): void {
  (globalThis as typeof globalThis & { __vipperContent?: unknown }).__vipperContent = {
    stats: () => ({ ...captureStats }),
    saveCard: saveCardState,
    setSaveCard,
    save: confirmSave,
    cancel: () => dismissSaveCard(true),
  };
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

    installCaptureListeners();
    installDebugApi();

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
        case 'vipper:save-prompt':
          renderSaveCard(msg);
          break;
        case 'vipper:save-result':
          onSaveResult(msg);
          break;
      }
    });
  },
});
