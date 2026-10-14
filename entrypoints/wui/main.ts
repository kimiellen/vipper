/**
 * wui 管理页（M9c：三栏骨架 + results/contents 只读接通真实数据）。
 *
 * - 顶行：active/archived seg（切谁就搜谁）· 搜索（title/remark/url）· TAGS/LINS 多选过滤（AND 语义）
 * - results：favicon 首列、lastUsedAt 降序（filterIndex 内排好）、点击行选中
 * - contents：只读详情；password/secret 遮蔽展示，⧉ 复制解密后的真实值
 * - Settings 手风琴：骨架 + 真实数据只读列表（交互在 M9e 接线）
 * - 编辑态与「新增书签」在 M9e 实现；键盘打开（回车入来源组）在 M9d 移植
 */

import * as keychain from '../../utils/keychain';
import * as vault from '../../utils/vault';
import type { Bookmark, IndexEntry, LinkedInfo, Tag } from '../../utils/vault';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---------- 状态 ----------

let idx: IndexEntry[] = [];
let tags: Tag[] = [];
let links: LinkedInfo[] = [];
let statusFilter: 'active' | 'archived' = 'active';
let query = '';
const selTags = new Set<string>();
const selLinks = new Set<string>();
let selectedId: string | null = null;

// ---------- 工具 ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const fmtTime = (t: number): string => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const faviconUrl = (pageUrl: string): string =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=16`);

const tagById = (id: string) => tags.find((t) => t.id === id);
const linkById = (id: string) => links.find((l) => l.id === id);

/** tag 彩色 chip：底色 = 14% 主色透明，字色 = 主色 */
function tagChip(tag: Tag): HTMLSpanElement {
  const chip = el('span', 'tag', tag.name);
  chip.style.background = `color-mix(in srgb, var(--cat-${tag.color}) 14%, transparent)`;
  chip.style.color = `var(--cat-${tag.color})`;
  return chip;
}

function linkChip(link: LinkedInfo): HTMLSpanElement {
  return el('span', 'tag tag-neutral', link.name);
}

function copyBtn(text: string): HTMLButtonElement {
  const btn = el('button', 'btn btn-ghost btn-sm', '⧉');
  btn.title = '复制';
  btn.addEventListener('click', () => void navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 800);
  }));
  return btn;
}

// ---------- 过滤与结果表 ----------

function applyFilters(): IndexEntry[] {
  return vault
    .filterIndex(idx, query)
    .filter(
      (e) =>
        e.status === statusFilter &&
        [...selTags].every((t) => e.tags.includes(t)) &&
        [...selLinks].every((l) => e.linkedInfos.includes(l)),
    );
}

function renderResults(): void {
  const entries = applyFilters();
  const tbody = $('#results-body');
  tbody.innerHTML = '';
  $('#results-empty').hidden = entries.length > 0;

  if (selectedId && !entries.some((e) => e.id === selectedId)) selectedId = null;
  if (!selectedId && entries.length > 0) selectedId = entries[0]!.id;

  for (const e of entries) {
    const tr = document.createElement('tr');
    if (e.id === selectedId) tr.className = 'row-selected';

    const tdFav = document.createElement('td');
    if (e.urls[0]) {
      const img = el('img', 'favicon');
      img.src = faviconUrl(e.urls[0].url);
      img.alt = '';
      tdFav.append(img);
    }
    const tdTitle = document.createElement('td');
    tdTitle.textContent = e.title;
    const tdTags = document.createElement('td');
    e.tags.map(tagById).filter((t): t is Tag => !!t).forEach((t) => tdTags.append(tagChip(t), ' '));
    const tdLinks = document.createElement('td');
    e.linkedInfos.map(linkById).filter((l): l is LinkedInfo => !!l).forEach((l) => tdLinks.append(linkChip(l), ' '));
    const tdUrls = el('td', 'mono', String(e.urls.length));
    const tdAccounts = el('td', 'mono', String(e.accountCount ?? 0)); // ?? 兜底 M9c 前无该字段的 idx

    tr.append(tdFav, tdTitle, tdTags, tdLinks, tdUrls, tdAccounts);
    tr.addEventListener('click', () => {
      selectedId = e.id;
      renderResults();
      void renderDetail();
    });
    tbody.append(tr);
  }
}

// ---------- contents 只读详情 ----------

function kvRow(key: string, ...values: Node[]): HTMLDivElement {
  const row = el('div', 'kv');
  row.append(el('span', 'k', key), ...values);
  return row;
}

function kvBlock(key: string, box: HTMLElement): HTMLDivElement {
  const wrap = el('div', 'kv-block');
  const head = el('div', 'box-head');
  head.append(el('span', 'k', key));
  wrap.append(head, box);
  return wrap;
}

async function renderDetail(): Promise<void> {
  const view = $('#contents-view');
  view.innerHTML = '';
  if (!selectedId) {
    view.append(el('div', 'empty', '← 选择一条书签'));
    return;
  }

  let b: Bookmark | null;
  try {
    b = await vault.getBookmarkDecrypted(selectedId);
  } catch {
    view.append(el('div', 'empty', '已锁定（解锁门控在 M9d 接入）'));
    return;
  }
  if (!b) {
    view.append(el('div', 'empty', '条目不存在'));
    return;
  }

  const head = el('div', 'detail-head');
  head.append(el('h3', '', b.title));
  view.append(head);

  // tags / linkedInfos
  const tagSpan = el('span');
  b.tags.map(tagById).filter((t): t is Tag => !!t).forEach((t) => tagSpan.append(tagChip(t), ' '));
  view.append(kvRow('tags', tagSpan));
  const linkSpan = el('span');
  b.linkedInfos.map(linkById).filter((l): l is LinkedInfo => !!l).forEach((l) => linkSpan.append(linkChip(l), ' '));
  view.append(kvRow('linkedInfos', linkSpan));

  // urls
  const urlBox = el('div', 'box mono');
  b.urls.forEach((u, i) => {
    if (i > 0) urlBox.append(document.createElement('br'));
    urlBox.append(u.url);
  });
  view.append(kvBlock('urls', urlBox));

  // accounts：密码遮蔽，⧉ 复制真实值
  const accBox = el('div', 'box mono');
  b.accounts.forEach((a, i) => {
    if (i > 0) accBox.append(el('hr'));
    const uRow = el('div', 'copy-row');
    const uTxt = el('span', 'txt', `user: ${a.username}`);
    uRow.append(uTxt, copyBtn(a.username));
    const pRow = el('div', 'copy-row');
    pRow.append(el('span', 'txt', 'pass: ••••••••'), copyBtn(a.password));
    accBox.append(uRow, pRow);
  });
  if (b.accounts.length > 0) view.append(kvBlock('Accounts', accBox));

  // records：note 明文 / secret 遮蔽，⧉ 复制真实值
  const recBox = el('div', 'box mono');
  b.records.forEach((r) => {
    const row = el('div', 'copy-row');
    const masked = r.template === 'secret' ? '********' : r.content;
    const txt = el('span', 'txt', `${r.name}: ${masked}`);
    row.append(txt, copyBtn(r.content));
    recBox.append(row);
  });
  if (b.records.length > 0) view.append(kvBlock('records', recBox));

  // remark
  if (b.remark) view.append(kvBlock('remark', el('div', 'box', b.remark)));

  // status
  const statusTag = el('span', 'tag', b.status);
  if (b.status === 'active') {
    statusTag.style.background = 'var(--success-soft)';
    statusTag.style.color = 'var(--success)';
  } else {
    statusTag.style.background = 'var(--warning-soft)';
    statusTag.style.color = 'var(--warning)';
  }
  view.append(kvRow('status', statusTag));

  // 只读时间：置底（spec 2026-10-14）
  view.append(
    kvRow('createdAt', el('span', 'mono', fmtTime(b.createdAt))),
    kvRow('updatedAt', el('span', 'mono', fmtTime(b.updatedAt))),
    kvRow('lastUsedAt', el('span', 'mono', fmtTime(b.lastUsedAt))),
  );
}

// ---------- 过滤下拉 ----------

function renderFilterPops(): void {
  const tagPop = $('#tag-filter-pop');
  tagPop.innerHTML = '';
  if (tags.length === 0) tagPop.append(el('div', 'none', '（空）'));
  for (const t of tags) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      if (cb.checked) selTags.add(t.id);
      else selTags.delete(t.id);
      renderResults();
      void renderDetail();
    });
    label.append(cb, tagChip(t));
    tagPop.append(label);
  }

  const linkPop = $('#link-filter-pop');
  linkPop.innerHTML = '';
  if (links.length === 0) linkPop.append(el('div', 'none', '（空）'));
  for (const l of links) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      if (cb.checked) selLinks.add(l.id);
      else selLinks.delete(l.id);
      renderResults();
      void renderDetail();
    });
    label.append(cb, document.createTextNode(l.name));
    linkPop.append(label);
  }
}

// ---------- Settings 骨架（只读真实数据；交互 M9e） ----------

async function renderSettings(): Promise<void> {
  const s = await keychain.getSettings();
  const general = $('#settings-general');
  general.innerHTML = '';
  general.append(
    kvRow('超时锁定', el('span', 'mono', s.lockTimeoutMin === 0 ? '关闭' : `${s.lockTimeoutMin} 分钟`)),
    kvRow('自动归档', el('span', 'mono', s.autoArchiveDays === 0 ? '关闭' : `${s.autoArchiveDays} 天`)),
  );
  general.append(el('div', 'none', '生成器 / 主题 / 语言在 M9e 接线'));

  const tagBox = $('#settings-tags');
  tagBox.innerHTML = '';
  if (tags.length === 0) tagBox.append(el('div', 'none', '（空）'));
  const tagRow = el('div');
  tags.forEach((t) => tagRow.append(tagChip(t), ' '));
  tagBox.append(tagRow);

  const linkBox = $('#settings-links');
  linkBox.innerHTML = '';
  if (links.length === 0) linkBox.append(el('div', 'none', '（空）'));
  for (const l of links) linkBox.append(kvRow(l.name, el('span', 'mono', l.value)));

  const backup = $('#settings-backup');
  backup.innerHTML = '';
  backup.append(el('div', 'none', '导入导出在 M9e 接线'));
}

// ---------- 事件接线 ----------

$('#status-seg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('#status-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === btn));
  statusFilter = btn.dataset.status as 'active' | 'archived';
  selectedId = null;
  renderResults();
  void renderDetail();
});

$('#search').addEventListener('input', (e) => {
  query = (e.target as HTMLInputElement).value;
  renderResults();
  void renderDetail();
});

// Settings 手风琴：展开一个，折叠其他
document.querySelectorAll('.set-head').forEach((h) => {
  h.addEventListener('click', () => {
    const g = h.parentElement!;
    const wasOpen = g.classList.contains('open');
    document.querySelectorAll('.set-group.open').forEach((x) => x.classList.remove('open'));
    if (!wasOpen) g.classList.add('open');
  });
});

// ---------- 初始化 ----------

[idx, tags, links] = await Promise.all([vault.listIndex(), vault.listTags(), vault.listLinkedInfos()]);
renderFilterPops();
renderResults();
void renderDetail();
void renderSettings();
