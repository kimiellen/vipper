/**
 * wui 管理页：书签 + 密码管理器主界面。
 *
 * - 顶行：active/archived seg（切谁就搜谁）· 搜索（title/remarks/url，title/remarks 支持拼音首拼与全拼）· TAGS/LINS 多选过滤（AND）· 新增书签
 * - results：favicon 首列、lastUsedAt 降序、点击/键盘选中
 * - contents：展示态（password/secret 遮蔽，⧉ 复制真实值）↔ 编辑态（原地切换，字段顺序一致，只读时间置底）
 * - Settings：常规（语言/配色/用户名与密码生成器/超时锁定/自动归档）、tags、linkedInfos、备份（导入导出）
 * - 解锁门控：覆盖层三态路由（创建/解锁/直达），角落主题/语言切换（锁定态可用且持久化）
 * - 主题 dark/light/system 与语言 zh/en 持久化到 meta:settings
 */

import * as keychain from '../../utils/keychain';
import * as vault from '../../utils/vault';
import { filterIndex } from '../../utils/search';
import { genPassword, genUsername } from '../../utils/generator';
import type { Bookmark, IndexEntry, LinkedInfo, Tag, TagColor, VaultRecord } from '../../utils/vault';
import type { VaultSettings } from '../../utils/keychain';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---------- i18n ----------

let lang: 'zh' | 'en' = 'zh';

const T = {
  pick: { zh: '＋ 添加', en: '＋ Add' },
  addUrl: { zh: '＋ 添加 URL', en: '＋ Add URL' },
  addAccount: { zh: '＋ 添加账号', en: '＋ Add account' },
  addRecord: { zh: '＋ 添加记录', en: '＋ Add record' },
  cancel: { zh: '取消', en: 'Cancel' },
  save: { zh: '保存', en: 'Save' },
  editBm: { zh: '编辑书签', en: 'Edit Bookmark' },
  newBm: { zh: '新增书签', en: 'New Bookmark' },
  contents: { zh: '详情', en: 'Contents' },
  delConfirm: { zh: '确认删除该书签？不可恢复。', en: 'Delete this bookmark? This cannot be undone.' },
  emptySel: { zh: '← 选择一条书签', en: '← Select a bookmark' },
  titleRequired: { zh: '书签名不能为空', en: 'Title is required' },
  username: { zh: '用户名', en: 'Username' },
  password: { zh: '密码', en: 'Password' },
  name: { zh: '名称', en: 'Name' },
  content: { zh: '内容', en: 'Content' },
  remarksPh: { zh: '备注（每条书签仅一个）', en: 'Remarks (one per bookmark)' },
  addTagPh: { zh: '标签名称', en: 'Tag name' },
  addLinkNamePh: { zh: '名称', en: 'Name' },
  addLinkValuePh: { zh: '内容', en: 'Content' },
  empty: { zh: '（空）', en: '(empty)' },
  language: { zh: '语言', en: 'Language' },
  colorScheme: { zh: '配色方案', en: 'Color Scheme' },
  wordLen: { zh: '单词长度', en: 'Word length' },
  digitLen: { zh: '数字长度', en: 'Digit length' },
  passLen: { zh: '密码长度', en: 'Password length' },
  passSymbols: { zh: '包含符号', en: 'Include symbols' },
  lockTimeout: { zh: '超时锁定', en: 'Auto-lock' },
  autoArchive: { zh: '自动归档', en: 'Auto-archive' },
  lockNow: { zh: '立即锁定', en: 'Lock now' },
  minute: { zh: '分钟', en: 'min' },
  day: { zh: '天', en: 'days' },
  off: { zh: '关闭', en: 'off' },
  add: { zh: '添加', en: 'Add' },
  list: { zh: '列表', en: 'List' },
  importBtn: { zh: '⇪ 导入数据', en: '⇪ Import' },
  exportBtn: { zh: '⇓ 导出数据', en: '⇓ Export' },
  exportPwPh: { zh: '输入主密码确认导出/导入', en: 'Master password to confirm export/import' },
  exportDone: { zh: (n: number) => `已导出 ${n} 条书签`, en: (n: number) => `Exported ${n} bookmarks` },
  importDone: {
    zh: (r: { added: number }) => `恢复完成：${r.added} 条书签（已全量替换本地数据）`,
    en: (r: { added: number }) => `Restore complete: ${r.added} bookmarks (local data fully replaced)`,
  },
  wrongPw: { zh: '主密码错误', en: 'Wrong master password' },
  backupDesc: {
    zh: '数据导出为明文 JSON 文件（用于本地 git 备份）。导入 = 全量恢复：清空本地数据后写入备份内容，需谨慎操作。',
    en: 'Export all data (bookmarks, tags, linkedInfos) as plain JSON for local git backup. Import = full restore: local data is replaced entirely.',
  },
} as const;

/** 纯文案键（值为 {zh,en} 字符串）；函数型文案直接用 T.key[lang](...) */
type TKey = { [K in keyof typeof T]: (typeof T)[K] extends { zh: string; en: string } ? K : never }[keyof typeof T];
const t = (k: TKey): string => (T[k] as { zh: string; en: string })[lang];

/** 全文档 i18n：静态 data-zh/data-en 属性 + 动态内容重渲染 */
function applyLangAll(): void {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll<HTMLElement>('[data-zh]').forEach((n) => {
    n.textContent = lang === 'zh' ? n.dataset.zh! : n.dataset.en!;
  });
  document.querySelectorAll<HTMLInputElement>('[data-zh-ph]').forEach((n) => {
    n.placeholder = lang === 'zh' ? n.dataset.zhPh! : n.dataset.enPh!;
  });
  if (mainReady) {
    renderSettings();
    renderResults();
    if (editing) renderEditForm();
    else void renderDetail();
  }
}

// ---------- 主题 ----------

const systemLight = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(theme: VaultSettings['theme']): void {
  const light = theme === 'light' || (theme === 'system' && systemLight.matches);
  if (light) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}
systemLight.addEventListener('change', () => {
  void keychain.getSettings().then((s) => { if (s.theme === 'system') applyTheme('system'); });
});

// ---------- 通用小件 ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const faviconUrl = (pageUrl: string): string =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=16`);

const tagById = (id: string) => tags.find((x) => x.id === id);
const linkById = (id: string) => links.find((x) => x.id === id);

/** tag 彩色 chip：底色 = 14% 主色透明，字色 = 主色 */
function tagChip(tag: Tag, withRemove?: () => void): HTMLSpanElement {
  const chip = el('span', 'tag', tag.name);
  chip.style.background = `color-mix(in srgb, var(--cat-${tag.color}) 14%, transparent)`;
  chip.style.color = `var(--cat-${tag.color})`;
  if (withRemove) {
    const x = el('button', 'tag-x', '✕');
    x.addEventListener('click', withRemove);
    chip.append(document.createTextNode(' '), x);
  }
  return chip;
}

function linkChip(link: LinkedInfo, withRemove?: () => void): HTMLSpanElement {
  const chip = el('span', 'tag tag-neutral', link.name);
  if (withRemove) {
    const x = el('button', 'tag-x', '✕');
    x.addEventListener('click', withRemove);
    chip.append(document.createTextNode(' '), x);
  }
  return chip;
}

function ghostBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', 'btn btn-ghost btn-sm', text);
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
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

// ---------- 状态 ----------

let settings: VaultSettings;
let idx: IndexEntry[] = [];
let tags: Tag[] = [];
let links: LinkedInfo[] = [];
let statusFilter: 'active' | 'archived' = 'active';
let query = '';
const selTags = new Set<string>();
const selLinks = new Set<string>();
let selectedId: string | null = null;
let filtered: IndexEntry[] = [];
let mainReady = false;
let editing: string | null | false = false; // false=展示态；null=新建；否则为条目 id

// ---------- 过滤与结果表 ----------

function applyFilters(): IndexEntry[] {
  return filterIndex(idx, query).filter(
    (e) =>
      e.status === statusFilter &&
      [...selTags].every((x) => e.tags.includes(x)) &&
      [...selLinks].every((x) => e.linkedInfos.includes(x)),
  );
}

function renderResults(): void {
  const entries = applyFilters();
  filtered = entries;
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
    // 基础信息列：单行裁切，完整内容放 title 悬停提示
    const tdTitle = document.createElement('td');
    tdTitle.title = e.title;
    tdTitle.append(el('span', 'cell-clip', e.title));
    const rowTags = e.tags.map(tagById).filter((x): x is Tag => !!x);
    const tdTags = document.createElement('td');
    const tagsCell = el('span', 'cell-clip chips');
    rowTags.forEach((x) => tagsCell.append(tagChip(x)));
    tdTags.append(tagsCell);
    if (rowTags.length) tdTags.title = rowTags.map((x) => x.name).join(', ');
    const rowLinks = e.linkedInfos.map(linkById).filter((x): x is LinkedInfo => !!x);
    const tdLinks = document.createElement('td');
    const linksCell = el('span', 'cell-clip chips');
    rowLinks.forEach((x) => linksCell.append(linkChip(x)));
    tdLinks.append(linksCell);
    if (rowLinks.length) tdLinks.title = rowLinks.map((x) => x.name).join(', ');
    const tdUrls = el('td', 'mono', String(e.urls.length));
    const tdAccounts = el('td', 'mono', String(e.accountCount ?? 0)); // ?? 兜底 M9c 前无该字段的 idx

    tr.append(tdFav, tdTitle, tdTags, tdLinks, tdUrls, tdAccounts);
    tr.addEventListener('click', () => {
      selectedId = e.id;
      exitEdit();
      renderResults();
      void renderDetail();
    });
    tbody.append(tr);
  }
}

// ---------- contents 展示态 ----------

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
    view.append(el('div', 'empty', t('emptySel')));
    return;
  }
  const b = await vault.getBookmarkDecrypted(selectedId);
  if (!b) {
    view.append(el('div', 'empty', '条目不存在'));
    return;
  }

  const head = el('div', 'detail-head');
  head.append(el('h3', '', b.title));
  const actions = el('div', 'detail-actions');
  actions.append(
    ghostBtn('✎', '编辑', () => enterEdit(b.id)),
    ghostBtn('✕', '删除', () => void removeBookmark(b.id)),
  );
  actions.lastElementChild!.setAttribute('style', 'color: var(--danger);');
  head.append(actions);
  view.append(head);

  const tagSpan = el('span');
  b.tags.map(tagById).filter((x): x is Tag => !!x).forEach((x) => tagSpan.append(tagChip(x), ' '));
  view.append(kvRow('tags', tagSpan));
  const linkSpan = el('span');
  b.linkedInfos.map(linkById).filter((x): x is LinkedInfo => !!x).forEach((x) => linkSpan.append(linkChip(x), ' '));
  view.append(kvRow('linkedInfos', linkSpan));

  const urlBox = el('div', 'box mono');
  b.urls.forEach((u, i) => {
    if (i > 0) urlBox.append(document.createElement('br'));
    urlBox.append(u.url);
  });
  view.append(kvBlock('urls', urlBox));

  const accBox = el('div', 'box mono');
  b.accounts.forEach((a, i) => {
    if (i > 0) accBox.append(el('hr'));
    const uRow = el('div', 'copy-row');
    uRow.append(el('span', 'txt', `user: ${a.username}`), copyBtn(a.username));
    const pRow = el('div', 'copy-row');
    pRow.append(el('span', 'txt', 'pass: ••••••••'), copyBtn(a.password));
    accBox.append(uRow, pRow);
  });
  if (b.accounts.length > 0) view.append(kvBlock('Accounts', accBox));

  const recBox = el('div', 'box mono');
  b.records.forEach((r) => {
    const row = el('div', 'copy-row');
    row.append(el('span', 'txt', `${r.name}: ${r.template === 'secret' ? '********' : r.content}`), copyBtn(r.content));
    recBox.append(row);
  });
  if (b.records.length > 0) view.append(kvBlock('records', recBox));

  if (b.remarks) view.append(kvBlock('remarks', el('div', 'box', b.remarks)));

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

// ---------- contents 编辑态 ----------

/** 编辑草稿（操作 DOM 行，保存时收集） */
let draft: Bookmark | null = null;

async function enterEdit(id: string | null): Promise<void> {
  editing = id;
  draft = id
    ? await vault.getBookmarkDecrypted(id)
    : {
        id: '', title: '', remarks: '', tags: [], linkedInfos: [],
        urls: [{ url: '', match: 'host' }], accounts: [], records: [],
        status: statusFilter, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
      };
  if (!draft) return;
  $('#contents-view').hidden = true;
  $('#contents-edit').hidden = false;
  const head = $('#contents-head');
  head.dataset.zh = id ? t('editBm') : t('newBm');
  head.dataset.en = id ? 'Edit Bookmark' : 'New Bookmark';
  head.textContent = head.dataset[lang === 'zh' ? 'zh' : 'en']!;
  renderEditForm();
}

function exitEdit(): void {
  if (editing === false) return;
  editing = false;
  draft = null;
  $('#contents-edit').hidden = true;
  $('#contents-view').hidden = false;
  const head = $('#contents-head');
  head.dataset.zh = '详情';
  head.dataset.en = 'Contents';
  head.textContent = t('contents');
}

function editRowDelete(btn: HTMLButtonElement): void {
  btn.addEventListener('click', () => btn.closest('.frow')?.remove());
}

function pwEye(btn: HTMLButtonElement): void {
  btn.addEventListener('click', () => {
    const input = btn.parentElement!.querySelector('input')!;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

function pwGen(btn: HTMLButtonElement): void {
  btn.addEventListener('click', () => {
    const input = btn.parentElement!.querySelector('input')!;
    input.type = 'text';
    input.value = genPassword(settings.genPassLen, settings.genPassSymbols);
  });
}

function renderEditForm(): void {
  const d = draft!;
  const box = $('#contents-edit');
  box.innerHTML = '';

  // title
  const titleInput = el('input', 'input') as HTMLInputElement;
  titleInput.id = 'edit-title';
  titleInput.value = d.title;
  titleInput.placeholder = lang === 'zh' ? '书签名' : 'Bookmark title';
  box.append(kvBlock('title', titleInput));

  // tags / linkedInfos：已选 chips（✕ 移除）+ 下拉添加（先建后选）
  const mkPicker = <T extends Tag | LinkedInfo>(
    selected: string[],
    all: T[],
    chipOf: (x: T, rm: () => void) => HTMLSpanElement,
  ): HTMLDivElement => {
    const wrap = el('div', 'chip-row');
    const rerender = (): void => {
      wrap.innerHTML = '';
      for (const id of selected) {
        const item = all.find((x) => x.id === id);
        if (!item) continue;
        wrap.append(chipOf(item as never, () => {
          selected.splice(selected.indexOf(id), 1);
          rerender();
        }));
      }
      const det = document.createElement('details');
      det.className = 'msel';
      const sum = document.createElement('summary');
      sum.textContent = t('pick');
      const pop = el('div', 'msel-pop');
      for (const item of all) {
        if (selected.includes(item.id)) continue;
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          if (cb.checked) selected.push(item.id);
          det.removeAttribute('open');
          rerender();
        });
        label.append(cb, document.createTextNode(item.name));
        pop.append(label);
      }
      det.append(sum, pop);
      wrap.append(det);
    };
    rerender();
    return wrap;
  };
  box.append(kvBlock('tags', mkPicker(d.tags, tags, (x: Tag, rm) => tagChip(x, rm))));
  box.append(kvBlock('linkedInfos', mkPicker(d.linkedInfos, links, (x: LinkedInfo, rm) => linkChip(x, rm))));

  // urls（match 只在编辑态可选）
  const urlBox = el('div');
  const addUrlRow = (u: { url: string; match: string }, first = false): void => {
    const row = el('div', 'frow');
    const input = el('input', 'input mono grow') as HTMLInputElement;
    input.value = u.url;
    input.placeholder = 'https://…';
    const sel = el('select', 'select mono') as HTMLSelectElement;
    for (const m of ['host', 'exact', 'prefix']) sel.append(new Option(m, m, false, m === u.match));
    const tail = el('span', 'tail');
    tail.append(sel);
    if (!first) {
      const del = ghostBtn('✕', '删除', () => {});
      del.style.color = 'var(--danger)';
      editRowDelete(del);
      tail.append(del);
    }
    row.append(input, tail);
    urlBox.append(row);
  };
  d.urls.forEach((u, i) => addUrlRow(u, i === 0));
  const addUrl = el('button', 'btn btn-ghost btn-sm', t('addUrl')) as HTMLButtonElement;
  addUrl.addEventListener('click', () => addUrlRow({ url: '', match: 'host' }));
  const urlAddWrap = el('div', 'edit-add');
  urlAddWrap.append(addUrl);
  urlBox.append(urlAddWrap);
  box.append(kvBlock('urls', urlBox));

  // accounts
  const accBox = el('div');
  const addAccRow = (a: { username: string; password: string }, first = false): void => {
    const row = el('div', 'frow');
    const u = el('input', 'input mono grow') as HTMLInputElement;
    u.value = a.username;
    u.placeholder = t('username');
    const grp = el('div', 'pw-group');
    const p = el('input', 'input mono') as HTMLInputElement;
    p.type = 'password';
    p.value = a.password;
    p.placeholder = t('password');
    const eye = ghostBtn('👁', '显示/隐藏', () => {});
    pwEye(eye);
    const gen = ghostBtn('⟳', '生成', () => {});
    pwGen(gen);
    grp.append(p, eye, gen);
    if (!first) {
      const del = ghostBtn('✕', '删除', () => {});
      del.style.color = 'var(--danger)';
      editRowDelete(del);
      grp.append(del);
    }
    row.append(u, grp);
    accBox.append(row);
  };
  if (d.accounts.length === 0) addAccRow({ username: '', password: '' }, true);
  else d.accounts.forEach((a, i) => addAccRow(a, i === 0));
  const addAcc = el('button', 'btn btn-ghost btn-sm', t('addAccount')) as HTMLButtonElement;
  addAcc.addEventListener('click', () => addAccRow({ username: '', password: '' }));
  const accAddWrap = el('div', 'edit-add');
  accAddWrap.append(addAcc);
  accBox.append(accAddWrap);
  box.append(kvBlock('Accounts', accBox));

  // records
  const recBox = el('div');
  const addRecRow = (r: VaultRecord): void => {
    const row = el('div', 'frow');
    const tpl = el('select', 'select fixed-sm') as HTMLSelectElement;
    tpl.append(new Option('note', 'note', false, r.template === 'note'), new Option('secret', 'secret', false, r.template === 'secret'));
    const name = el('input', 'input fixed-sm') as HTMLInputElement;
    name.value = r.name;
    name.placeholder = t('name');
    const grp = el('div', 'pw-group');
    const content = el('input', 'input mono') as HTMLInputElement;
    content.type = r.template === 'secret' ? 'password' : 'text';
    content.value = r.content;
    content.placeholder = t('content');
    tpl.addEventListener('change', () => { content.type = tpl.value === 'secret' ? 'password' : 'text'; });
    grp.append(content);
    const eye = ghostBtn('👁', '显示/隐藏', () => {});
    pwEye(eye);
    const del = ghostBtn('✕', '删除', () => {});
    del.style.color = 'var(--danger)';
    editRowDelete(del);
    grp.append(eye, del);
    row.append(tpl, name, grp);
    recBox.append(row);
  };
  d.records.forEach((r) => addRecRow(r));
  const addRec = el('button', 'btn btn-ghost btn-sm', t('addRecord')) as HTMLButtonElement;
  addRec.addEventListener('click', () => addRecRow({ template: 'note', name: '', content: '' }));
  const recAddWrap = el('div', 'edit-add');
  recAddWrap.append(addRec);
  recBox.append(recAddWrap);
  box.append(kvBlock('records', recBox));

  // remarks
  const remarks = el('textarea', 'textarea') as HTMLTextAreaElement;
  remarks.id = 'edit-remarks';
  remarks.value = d.remarks;
  remarks.placeholder = t('remarksPh');
  box.append(kvBlock('remarks', remarks));

  // status
  const statusSeg = el('span', 'seg');
  statusSeg.id = 'edit-status-seg';
  for (const s of ['active', 'archived'] as const) {
    const b = el('button', `seg-btn${d.status === s ? ' active' : ''}`, s);
    b.dataset.status = s;
    b.addEventListener('click', () => {
      statusSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
    statusSeg.append(b);
  }
  box.append(kvRow('status', statusSeg));

  // 只读时间：置底（新建时无）
  if (d.id) {
    box.append(
      kvRow('createdAt', el('span', 'mono', fmtTime(d.createdAt))),
      kvRow('updatedAt', el('span', 'mono', fmtTime(d.updatedAt))),
      kvRow('lastUsedAt', el('span', 'mono', fmtTime(d.lastUsedAt))),
    );
  }

  // 操作
  const actions = el('div', 'edit-actions');
  const cancelBtn = el('button', 'btn btn-ghost btn-sm', t('cancel')) as HTMLButtonElement;
  cancelBtn.id = 'edit-cancel';
  cancelBtn.addEventListener('click', () => {
    exitEdit();
    void renderDetail();
  });
  const saveBtn = el('button', 'btn btn-primary btn-sm', t('save')) as HTMLButtonElement;
  saveBtn.id = 'edit-save';
  saveBtn.addEventListener('click', () => void saveEdit());
  actions.append(cancelBtn, saveBtn);
  box.append(actions);
}

async function saveEdit(): Promise<void> {
  const d = draft!;
  const title = ($('#edit-title') as HTMLInputElement).value.trim();
  if (!title) {
    ($('#edit-title') as HTMLInputElement).focus();
    return;
  }
  const box = $('#contents-edit');
  const kvBlocks = box.querySelectorAll(':scope > .kv-block');
  // 顺序固定：title(0) tags(1) linkedInfos(2) urls(3) accounts(4) records(5) remarks(6)
  const urlRows = kvBlocks[3]!.querySelectorAll('.frow');
  const urls = [...urlRows]
    .map((row) => {
      const input = row.querySelector('input')!;
      const sel = row.querySelector('select')!;
      return { url: input.value.trim(), match: sel.value as vault.UrlMatch };
    })
    .filter((u) => u.url !== '');
  if (urls.length === 0) urls.push({ url: 'about:blank', match: 'host' });

  const accRows = kvBlocks[4]!.querySelectorAll('.frow');
  const accounts = [...accRows]
    .map((row) => {
      const [u, p] = [...row.querySelectorAll('input')] as [HTMLInputElement, HTMLInputElement];
      return { username: u!.value.trim(), password: p!.value };
    })
    .filter((a) => a.username !== '' || a.password !== '');

  const recRows = kvBlocks[5]!.querySelectorAll('.frow');
  const records: VaultRecord[] = [...recRows]
    .map((row) => {
      const tpl = row.querySelector('select')!.value as 'note' | 'secret';
      const [name, content] = [...row.querySelectorAll('input')] as [HTMLInputElement, HTMLInputElement];
      return { template: tpl, name: name!.value.trim(), content: content!.value };
    })
    .filter((r) => r.name !== '' || r.content !== '');

  const status = (box.querySelector('#edit-status-seg .seg-btn.active') as HTMLElement).dataset.status as 'active' | 'archived';
  const remarks = ($('#edit-remarks') as HTMLTextAreaElement).value;

  if (d.id) {
    await vault.saveBookmark({
      ...d, title, urls, accounts, records, remarks, status,
      tags: d.tags, linkedInfos: d.linkedInfos,
    });
    selectedId = d.id;
  } else {
    const created = await vault.addBookmark({
      title, urls, accounts, records, remarks, status,
      tags: d.tags, linkedInfos: d.linkedInfos,
    });
    selectedId = created.id;
  }
  // status 变更后顶行 seg 联动（归档的条目在 archived 视图才可见）
  statusFilter = status;
  document.querySelectorAll('#status-seg .seg-btn').forEach((x) =>
    x.classList.toggle('active', (x as HTMLElement).dataset.status === status),
  );
  await reloadData();
  exitEdit();
  renderResults();
  void renderDetail();
}

async function removeBookmark(id: string): Promise<void> {
  if (!window.confirm(t('delConfirm'))) return;
  await vault.deleteBookmark(id);
  if (selectedId === id) selectedId = null;
  await reloadData();
  renderResults();
  void renderDetail();
}

// ---------- Settings ----------

function setRow(label: string, ctrl: HTMLElement): HTMLDivElement {
  const row = el('div', 'inline-field');
  row.append(el('label', '', label), ctrl);
  return row;
}

function divider(): HTMLDivElement {
  return el('div', 'divider-strong');
}

function segOf(options: string[], current: string, onPick: (v: string) => void, id?: string): HTMLDivElement {
  const seg = el('div', 'seg');
  if (id) seg.id = id;
  for (const o of options) {
    const b = el('button', `seg-btn${o === current ? ' active' : ''}`, o);
    b.dataset.value = o;
    b.addEventListener('click', () => {
      seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      onPick(o);
    });
    seg.append(b);
  }
  return seg;
}

function renderSettings(): void {
  // ---- general ----
  const g = $('#settings-general');
  g.innerHTML = '';

  g.append(setRow(t('language'), segOf(['简体中文', 'english'], lang === 'zh' ? '简体中文' : 'english', (v) => {
    void setLang(v === 'english' ? 'en' : 'zh');
  }, 'lang-seg')));

  g.append(divider());

  g.append(setRow(t('colorScheme'), segOf(['dark', 'light', 'system'], settings.theme, (v) => {
    void setTheme(v as VaultSettings['theme']);
  }, 'scheme-seg')));

  g.append(divider());

  // 用户名生成器
  const userOut = el('input', 'input mono') as HTMLInputElement;
  userOut.id = 'gen-user-out';
  userOut.readOnly = true;
  const genUserRow = el('div', 'gen-row');
  genUserRow.append(
    userOut,
    ghostBtn('⟳', '生成', () => { userOut.value = genUsername(settings.genWordLen, settings.genDigitLen); }),
    copyBtnLive(() => userOut.value),
  );
  g.append(genUserRow);
  g.append(numSetting(t('wordLen'), settings.genWordLen, (v) => { settings.genWordLen = v; void keychain.setSettings({ genWordLen: v }); }, 'gen-word-len'));
  g.append(numSetting(t('digitLen'), settings.genDigitLen, (v) => { settings.genDigitLen = v; void keychain.setSettings({ genDigitLen: v }); }, 'gen-digit-len'));

  g.append(divider());

  // 密码生成器
  const passOut = el('input', 'input mono') as HTMLInputElement;
  passOut.id = 'gen-pass-out';
  passOut.readOnly = true;
  const genPassRow = el('div', 'gen-row');
  genPassRow.append(
    passOut,
    ghostBtn('⟳', '生成', () => { passOut.value = genPassword(settings.genPassLen, settings.genPassSymbols); }),
    copyBtnLive(() => passOut.value),
  );
  g.append(genPassRow);
  g.append(numSetting(t('passLen'), settings.genPassLen, (v) => { settings.genPassLen = v; void keychain.setSettings({ genPassLen: v }); }, 'gen-pass-len'));
  const symRow = el('div', 'inline-field');
  const symCb = document.createElement('input');
  symCb.type = 'checkbox';
  symCb.id = 'gen-pass-symbols';
  symCb.checked = settings.genPassSymbols;
  symCb.addEventListener('change', () => {
    settings.genPassSymbols = symCb.checked;
    void keychain.setSettings({ genPassSymbols: symCb.checked });
  });
  symRow.append(el('label', '', t('passSymbols')), symCb);
  g.append(symRow);

  g.append(divider());

  g.append(numSetting(t('lockTimeout'), settings.lockTimeoutMin, (v) => { settings.lockTimeoutMin = v; void keychain.setSettings({ lockTimeoutMin: v }); }, 'set-lock-timeout', t('minute')));
  g.append(numSetting(t('autoArchive'), settings.autoArchiveDays, (v) => { settings.autoArchiveDays = v; void keychain.setSettings({ autoArchiveDays: v }); }, 'set-auto-archive', t('day')));

  g.append(divider());

  // 手动锁定：立即清除会话密钥并回到解锁页（重载走门控路由）
  const lockBtn = el('button', 'btn btn-ghost btn-sm', t('lockNow')) as HTMLButtonElement;
  lockBtn.id = 'lock-btn';
  lockBtn.style.color = 'var(--warning)';
  lockBtn.addEventListener('click', () => void keychain.lock().then(() => location.reload()));
  g.append(lockBtn);

  // ---- tags ----
  renderSettingsTags();

  // ---- linkedInfos ----
  renderSettingsLinks();

  // ---- backup ----
  renderSettingsBackup();
}

function copyBtnLive(getText: () => string): HTMLButtonElement {
  const btn = el('button', 'btn btn-ghost btn-sm', '⧉');
  btn.title = '复制';
  btn.addEventListener('click', () => void navigator.clipboard.writeText(getText()).then(() => {
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 800);
  }));
  return btn;
}

function numSetting(label: string, value: number, onSave: (v: number) => void, id: string, unit = ''): HTMLDivElement {
  const row = el('div', 'inline-field');
  const ctrl = el('div', 'inline-ctrl');
  const input = el('input', 'input') as HTMLInputElement;
  input.type = 'number';
  input.min = '0';
  input.value = String(value);
  input.id = id;
  const save = ghostBtn('✓', '保存修改', () => {
    const v = Math.max(0, Math.floor(Number(input.value) || 0));
    input.value = String(v);
    onSave(v);
  });
  ctrl.append(input);
  if (unit) ctrl.append(document.createTextNode(unit));
  ctrl.append(save);
  row.append(el('label', '', label), ctrl);
  return row;
}

function errLine(id: string): HTMLDivElement {
  const err = el('div', 'err-text');
  err.id = id;
  err.hidden = true;
  return err;
}

/** 颜色下拉选项：圆形色块 + 名称（base-select 支持 option 内任意内容） */
function colorOption(c: TagColor, selected: boolean): HTMLOptionElement {
  const opt = new Option(c, c, false, selected);
  const sw = el('span', 'swatch');
  sw.style.background = `var(--cat-${c})`;
  opt.prepend(sw);
  return opt;
}

function renderSettingsTags(): void {  const box = $('#settings-tags');
  box.innerHTML = '';
  box.append(el('div', 'sub-title', t('add')));

  // 添加行：名称 + 颜色选择 + ＋
  const row = el('div', 'gen-row');
  const name = el('input', 'input') as HTMLInputElement;
  name.id = 'new-tag-name';
  name.placeholder = t('addTagPh');
  const color = el('select', 'select') as HTMLSelectElement;
  color.id = 'new-tag-color';
  for (const c of vault.TAG_COLORS) color.append(colorOption(c, c === 'mauve'));
  const add = el('button', 'btn btn-primary btn-sm', '＋') as HTMLButtonElement;
  add.id = 'add-tag-btn';
  add.addEventListener('click', () => void (async () => {
    const err = $('#tag-err');
    try {
      await vault.addTag(name.value.trim(), color.value as TagColor);
      name.value = '';
      err.hidden = true;
      await reloadData();
      renderSettingsTags();
      renderFilterPops();
      renderResults();
    } catch (e) {
      err.textContent = String(e);
      err.hidden = false;
    }
  })());
  row.append(name, color, add);
  box.append(row, errLine('tag-err'));

  box.append(el('div', 'sub-title', t('list')));
  const list = el('div', 'rlist');
  list.id = 'settings-tag-list';
  if (tags.length === 0) list.append(el('div', 'none', t('empty')));
  for (const tag of tags) {
    const rowEl = el('div', 'rlist-row');
    rowEl.append(tagChip(tag));
    const actions = el('span', 'rlist-actions');
    actions.append(
      ghostBtn('✎', '编辑', () => void (async () => {
        // 行内编辑：名称 + 颜色 + ✓
        rowEl.innerHTML = '';
        const nameIn = el('input', 'input') as HTMLInputElement;
        nameIn.value = tag.name;
        nameIn.style.maxWidth = '100px';
        const colorIn = el('select', 'select') as HTMLSelectElement;
        for (const c of vault.TAG_COLORS) colorIn.append(colorOption(c, c === tag.color));
        const ok = ghostBtn('✓', '保存', () => void (async () => {
          await vault.updateTag(tag.id, { name: nameIn.value.trim(), color: colorIn.value as TagColor });
          await reloadData();
          renderSettingsTags();
          renderFilterPops();
          renderResults();
          void renderDetail();
        })());
        rowEl.append(nameIn, colorIn, ok);
      })()),
      ghostBtn('✕', '删除', () => void (async () => {
        const err = $('#tag-err');
        try {
          await vault.deleteTag(tag.id);
          err.hidden = true;
          await reloadData();
          renderSettingsTags();
          renderFilterPops();
          renderResults();
        } catch (e) {
          err.textContent = String(e); // 被引用时拒绝并提示
          err.hidden = false;
        }
      })()),
    );
    actions.lastElementChild!.setAttribute('style', 'color: var(--danger);');
    rowEl.append(actions);
    list.append(rowEl);
  }
  box.append(list);
}

function renderSettingsLinks(): void {
  const box = $('#settings-links');
  box.innerHTML = '';
  box.append(el('div', 'sub-title', t('add')));

  const row = el('div', 'gen-row');
  const name = el('input', 'input') as HTMLInputElement;
  name.id = 'new-link-name';
  name.placeholder = t('addLinkNamePh');
  name.style.maxWidth = '100px';
  const value = el('input', 'input') as HTMLInputElement;
  value.id = 'new-link-value';
  value.placeholder = t('addLinkValuePh');
  const add = el('button', 'btn btn-primary btn-sm', '＋') as HTMLButtonElement;
  add.id = 'add-link-btn';
  add.addEventListener('click', () => void (async () => {
    const err = $('#link-err');
    try {
      await vault.addLinkedInfo(name.value.trim(), value.value.trim());
      name.value = '';
      value.value = '';
      err.hidden = true;
      await reloadData();
      renderSettingsLinks();
      renderFilterPops();
      renderResults();
    } catch (e) {
      err.textContent = String(e);
      err.hidden = false;
    }
  })());
  row.append(name, value, add);
  box.append(row, errLine('link-err'));

  box.append(el('div', 'sub-title', t('list')));
  const list = el('div', 'rlist');
  list.id = 'settings-link-list';
  if (links.length === 0) list.append(el('div', 'none', t('empty')));
  for (const l of links) {
    const rowEl = el('div', 'rlist-row');
    const main = el('span', 'rlist-main');
    main.append(el('span', '', l.name), el('span', 'sub mono', l.value));
    rowEl.append(main);
    const actions = el('span', 'rlist-actions');
    actions.append(
      ghostBtn('✎', '编辑', () => void (async () => {
        rowEl.innerHTML = '';
        const nameIn = el('input', 'input') as HTMLInputElement;
        nameIn.value = l.name;
        nameIn.style.maxWidth = '90px';
        const valueIn = el('input', 'input') as HTMLInputElement;
        valueIn.value = l.value;
        const ok = ghostBtn('✓', '保存', () => void (async () => {
          await vault.updateLinkedInfo(l.id, { name: nameIn.value.trim(), value: valueIn.value.trim() });
          await reloadData();
          renderSettingsLinks();
          renderFilterPops();
          renderResults();
          void renderDetail();
        })());
        rowEl.append(nameIn, valueIn, ok);
      })()),
      ghostBtn('✕', '删除', () => void (async () => {
        const err = $('#link-err');
        try {
          await vault.deleteLinkedInfo(l.id);
          err.hidden = true;
          await reloadData();
          renderSettingsLinks();
          renderFilterPops();
          renderResults();
        } catch (e) {
          err.textContent = String(e);
          err.hidden = false;
        }
      })()),
    );
    actions.lastElementChild!.setAttribute('style', 'color: var(--danger);');
    rowEl.append(actions);
    list.append(rowEl);
  }
  box.append(list);
}

function renderSettingsBackup(): void {
  const box = $('#settings-backup');
  box.innerHTML = '';
  box.append(el('p', 'none', t('backupDesc')));

  const pw = el('input', 'input') as HTMLInputElement;
  pw.type = 'password';
  pw.id = 'backup-pw';
  pw.placeholder = t('exportPwPh');

  const btns = el('div', 'gen-row');
  const importBtn = el('button', 'btn btn-ghost btn-sm', t('importBtn')) as HTMLButtonElement;
  importBtn.id = 'import-btn';
  const file = el('input') as HTMLInputElement;
  file.type = 'file';
  file.accept = 'application/json';
  file.id = 'import-file';
  file.hidden = true;
  importBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => void (async () => {
    const f = file.files?.[0];
    if (!f) return;
    const status = $('#backup-status');
    try {
      // 导入 = 全量恢复（spec 2026-10-15），先验证主密码防恶意覆盖
      if (!(await keychain.unlock(pw.value))) {
        status.textContent = t('wrongPw');
        status.hidden = false;
        return;
      }
      pw.value = '';
      const result = await vault.importAll(JSON.parse(await f.text()));
      status.textContent = T.importDone[lang](result);
      status.hidden = false;
      await reloadData();
      renderFilterPops();
      renderResults();
      void renderDetail();
    } catch (e) {
      status.textContent = String(e);
      status.hidden = false;
    } finally {
      file.value = '';
    }
  })());

  const exportBtn = el('button', 'btn btn-primary btn-sm', t('exportBtn')) as HTMLButtonElement;
  exportBtn.id = 'export-btn';
  exportBtn.addEventListener('click', () => void (async () => {
    const status = $('#backup-status');
    if (!(await keychain.unlock(pw.value))) { // 当场验证主密码（spec: 导出需确认）
      status.textContent = t('wrongPw');
      status.hidden = false;
      return;
    }
    pw.value = '';
    const data = await vault.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vipper-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    status.textContent = T.exportDone[lang](data.bookmarks.length);
    status.hidden = false;
  })());

  btns.append(importBtn, exportBtn);
  const status = el('div', 'err-text');
  status.id = 'backup-status';
  status.hidden = true;
  box.append(pw, btns, file, status);
}

// ---------- 主题 / 语言切换（含持久化，解锁页角落与 Settings 共用） ----------

async function setTheme(theme: VaultSettings['theme']): Promise<void> {
  settings.theme = theme;
  applyTheme(theme);
  await keychain.setSettings({ theme });
  syncSeg('#scheme-seg', theme);
  syncSeg('#ov-scheme-seg', theme === 'system' ? 'dark' : theme);
}

async function setLang(l: 'zh' | 'en'): Promise<void> {
  lang = l;
  settings.lang = l;
  applyLangAll();
  await keychain.setSettings({ lang: l });
  syncSeg('#ov-lang-seg', l);
}

function syncSeg(sel: string, value: string): void {
  document.querySelectorAll(`${sel} .seg-btn`).forEach((x) => {
    const elx = x as HTMLElement;
    x.classList.toggle('active', elx.dataset.value === value || elx.dataset.scheme === value || elx.dataset.lang === value);
  });
}

// ---------- 过滤下拉 ----------

function renderFilterPops(): void {
  const tagPop = $('#tag-filter-pop');
  tagPop.innerHTML = '';
  if (tags.length === 0) tagPop.append(el('div', 'none', t('empty')));
  for (const tag of tags) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selTags.has(tag.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selTags.add(tag.id);
      else selTags.delete(tag.id);
      renderResults();
      void renderDetail();
    });
    label.append(cb, tagChip(tag));
    tagPop.append(label);
  }

  const linkPop = $('#link-filter-pop');
  linkPop.innerHTML = '';
  if (links.length === 0) linkPop.append(el('div', 'none', t('empty')));
  for (const l of links) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selLinks.has(l.id);
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

// ---------- 数据重载 ----------

async function reloadData(): Promise<void> {
  [idx, tags, links] = await Promise.all([vault.listIndex(), vault.listTags(), vault.listLinkedInfos()]);
}

// ---------- 打开书签（回车 → 经 background 在来源组打开并关窗） ----------

let submenu: { urls: vault.BookmarkUrl[]; idx: number; bookmarkId: string } | null = null;

function openUrl(url: string, bookmarkId: string): void {
  void chrome.runtime.sendMessage({ type: 'vipper:open', url, bookmarkId });
  // 窗口由 background 收到消息后关闭
}

function showSubmenu(entry: IndexEntry): void {
  submenu = { urls: entry.urls, idx: 0, bookmarkId: entry.id };
  const card = $('#url-menu-card');
  card.innerHTML = '';
  entry.urls.forEach((u, i) => {
    card.append(el('div', `menu-item${i === 0 ? ' on' : ''}`, u.url));
  });
  $('#url-menu').hidden = false;
}

function hideSubmenu(): void {
  submenu = null;
  $('#url-menu').hidden = true;
}

function moveSubmenu(delta: number): void {
  if (!submenu) return;
  submenu.idx = Math.min(submenu.urls.length - 1, Math.max(0, submenu.idx + delta));
  document.querySelectorAll('#url-menu-card .menu-item').forEach((x, i) =>
    x.classList.toggle('on', i === submenu!.idx),
  );
}

function openSelected(): void {
  const entry = filtered.find((e) => e.id === selectedId);
  if (!entry) return;
  if (entry.urls.length <= 1) {
    openUrl(entry.urls[0]?.url ?? 'about:blank', entry.id);
  } else {
    showSubmenu(entry);
  }
}

// ---------- 键盘导航（↓ 进列表、↑/↓ 移动、回车打开、Esc 取消/关闭） ----------

function moveSelection(delta: number): void {
  if (filtered.length === 0) return;
  const cur = filtered.findIndex((e) => e.id === selectedId);
  const next = Math.min(filtered.length - 1, Math.max(0, (cur === -1 ? 0 : cur) + delta));
  selectedId = filtered[next]!.id;
  exitEdit();
  renderResults();
  void renderDetail();
  ensureSelectionVisible();
}

/**
 * 让选中行完整落在 results 滚动视口内。
 * 不用 scrollIntoView({block:'nearest'})：它把行顶对齐到视口顶边，忽略吸顶表头，
 * 导致 ↑ 回到首行时选中行被表头盖住（需重开或把滚动条拖到最上才恢复）。
 */
function ensureSelectionVisible(): void {
  const tr = document.querySelector<HTMLElement>('#results-body tr.row-selected');
  const body = document.querySelector<HTMLElement>('.results-body');
  if (!tr || !body) return;
  const view = body.getBoundingClientRect();
  const row = tr.getBoundingClientRect();
  const top = view.top + (body.querySelector('thead')?.getBoundingClientRect().height ?? 0);
  if (row.top < top) body.scrollTop += row.top - top;
  else if (row.bottom > view.bottom) body.scrollTop += row.bottom - view.bottom;
}

document.addEventListener('keydown', (e) => {
  if (!mainReady) return;
  if (submenu) {
    if (e.key === 'ArrowDown') moveSubmenu(1);
    else if (e.key === 'ArrowUp') moveSubmenu(-1);
    else if (e.key === 'Enter') openUrl(submenu.urls[submenu.idx]!.url, submenu.bookmarkId);
    else if (e.key === 'Escape') hideSubmenu();
    else return;
    e.preventDefault();
    return;
  }
  if (editing !== false) {
    if (e.key === 'Escape') {
      exitEdit();
      void renderDetail();
    }
    return; // 编辑态不劫持其他按键（输入框正常输入）
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    e.preventDefault();
  } else if (e.key === 'Enter' && document.activeElement?.id === 'search') {
    openSelected();
  } else if (e.key === 'Enter' && document.activeElement === document.body) {
    openSelected();
  } else if (e.key === 'Escape') {
    window.close();
  }
});

// ---------- 解锁门控（spec 安全模型：三态自动路由） ----------

const overlay = $('#unlock-overlay');

const GATE_TEXT = {
  wrong: { zh: '密码错误，请重试', en: 'Wrong password, try again' },
  mismatch: { zh: '两次输入不一致', en: 'Passwords do not match' },
  empty: { zh: '密码不能为空', en: 'Password must not be empty' },
} as const;

function gateApplyLang(): void {
  overlay.querySelectorAll<HTMLElement>('[data-zh]').forEach((n) => {
    n.textContent = lang === 'zh' ? n.dataset.zh! : n.dataset.en!;
  });
  overlay.querySelectorAll<HTMLInputElement>('[data-zh-ph]').forEach((n) => {
    n.placeholder = lang === 'zh' ? n.dataset.zhPh! : n.dataset.enPh!;
  });
}

function gateError(kind: keyof typeof GATE_TEXT): void {
  const err = $('#ov-error');
  err.textContent = GATE_TEXT[kind][lang];
  err.hidden = false;
  overlay.dataset.state = 'error';
  setTimeout(() => {
    overlay.dataset.state = 'idle';
    $('#ov-pw1').focus();
  }, 1200);
}

async function gateSubmit(): Promise<void> {
  if (overlay.dataset.state !== 'idle') return;
  const pw1 = ($('#ov-pw1') as HTMLInputElement).value;
  const pw2 = ($('#ov-pw2') as HTMLInputElement).value;
  const setup = overlay.dataset.mode === 'setup';
  if (!pw1 || (setup && pw1 !== pw2)) {
    gateError(!pw1 ? 'empty' : 'mismatch');
    return;
  }
  overlay.dataset.state = 'working';
  const ok = setup ? (await keychain.setupMasterPassword(pw1), true) : await keychain.unlock(pw1);
  if (!ok) {
    gateError('wrong');
    return;
  }
  // 成功动画：环闭合变绿 → 锁扣弹开 → 涟漪铺满 → 移除覆盖层进主界面
  overlay.dataset.state = 'success';
  await new Promise((r) => setTimeout(r, 1800));
  overlay.remove();
  await initMain();
}

function showGate(mode: 'unlock' | 'setup'): void {
  overlay.dataset.mode = mode;
  const setup = mode === 'setup';
  $('#ov-pw2').hidden = !setup;
  $('#ov-warning').hidden = !setup;
  const title = $('#ov-title');
  title.dataset.zh = setup ? '创建主密码' : '解锁';
  title.dataset.en = setup ? 'Create Master Password' : 'Unlock';
  const desc = $('#ov-desc');
  desc.dataset.zh = setup ? '首次使用：设置用于加密所有凭据的主密码' : '输入主密码以解密书签库';
  desc.dataset.en = setup
    ? 'First run: set the master password that encrypts all credentials'
    : 'Enter your master password to decrypt the vault';
  const submit = $('#ov-submit');
  submit.dataset.zh = setup ? '创建并解锁' : '解锁';
  submit.dataset.en = setup ? 'Create & Unlock' : 'Unlock';
  gateApplyLang();
  overlay.hidden = false;
  ($('#ov-pw1') as HTMLInputElement).focus();
}

$('#ov-submit').addEventListener('click', () => void gateSubmit());
overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void gateSubmit();
});
$('#ov-scheme-seg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.seg-btn');
  if (btn?.dataset.scheme) void setTheme(btn.dataset.scheme as VaultSettings['theme']);
});
$('#ov-lang-seg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.seg-btn');
  if (btn?.dataset.lang) void setLang(btn.dataset.lang as 'zh' | 'en');
});

// ---------- 主界面事件接线 ----------

$('#status-seg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('#status-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === btn));
  statusFilter = btn.dataset.status as 'active' | 'archived';
  selectedId = null;
  exitEdit();
  renderResults();
  void renderDetail();
});

$('#search').addEventListener('input', (e) => {
  query = (e.target as HTMLInputElement).value;
  renderResults();
  void renderDetail();
});

$('#new-btn').addEventListener('click', () => void enterEdit(null));

// Settings 手风琴：展开一个，折叠其他
document.querySelectorAll('.set-head').forEach((h) => {
  h.addEventListener('click', () => {
    const g = h.parentElement!;
    const wasOpen = g.classList.contains('open');
    document.querySelectorAll('.set-group.open').forEach((x) => x.classList.remove('open'));
    if (!wasOpen) g.classList.add('open');
  });
});

// ---------- 启动：设置（主题/语言）→ 三态路由 ----------

async function initMain(): Promise<void> {
  await reloadData();
  renderFilterPops();
  renderResults();
  void renderDetail();
  renderSettings();
  mainReady = true;
  $('#search').focus();
}

settings = await keychain.getSettings();
lang = settings.lang;
applyTheme(settings.theme);
applyLangAll();

if (!(await keychain.isInitialized())) showGate('setup');
else if (!(await keychain.isUnlocked())) showGate('unlock');
else {
  overlay.remove(); // 已解锁：直接进主页面，无覆盖层闪烁
  await initMain();
}
