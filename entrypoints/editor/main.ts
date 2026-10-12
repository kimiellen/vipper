/**
 * 书签编辑页（launcher 中 Ctrl+E/Ctrl+N 打开）。
 * 分区布局见 spec 数据模型：基础信息 / Tag / 关联信息 / URL 区 / 账号区 / 记录区 / 备注。
 * 编辑前必须解锁（加载即解密敏感字段到表单）。
 */

import * as keychain from '../../utils/keychain';
import * as vault from '../../utils/vault';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const editId = new URLSearchParams(location.search).get('id');

let bookmark: vault.Bookmark;
let allTags: vault.Tag[] = [];
let allLinks: vault.LinkedInfo[] = [];
const selectedTags = new Set<string>();
const selectedLinks = new Set<string>();

function blankBookmark(): vault.Bookmark {
  const now = Date.now();
  return {
    id: '', title: '', remark: '', tags: [], linkedInfos: [],
    urls: [{ url: '', match: 'host' }],
    accounts: [{ username: '', password: '' }],
    records: [],
    status: 'active', createdAt: now, updatedAt: now, lastUsedAt: now,
  };
}

// ---------- 动态行 ----------

function rowEl(children: HTMLElement[], onRemove: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const del = document.createElement('button');
  del.textContent = '×';
  del.addEventListener('click', () => { row.remove(); onRemove(); });
  row.append(...children, del);
  return row;
}

function inputEl(value: string, placeholder: string, type = 'text'): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

function addUrlRow(u: vault.BookmarkUrl): void {
  const url = inputEl(u.url, 'https://…');
  const match = document.createElement('select');
  for (const m of ['host', 'exact', 'prefix'] as const) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    match.append(opt);
  }
  match.value = u.match;
  $('#url-rows').append(rowEl([url, match], () => {}));
}

function addAccountRow(a: vault.Account): void {
  const username = inputEl(a.username, '账号');
  const password = inputEl(a.password, '密码');
  const label = inputEl(a.label ?? '', '标签（可选，如：主号）');
  $('#account-rows').append(rowEl([username, password, label], () => {}));
}

function addRecordRow(r: vault.VaultRecord): void {
  const badge = document.createElement('span');
  badge.className = `badge${r.template === 'secret' ? ' secret' : ''}`;
  badge.textContent = r.template === 'secret' ? '私密' : '明文';
  badge.dataset.template = r.template;
  const name = inputEl(r.name, '名称');
  const content = inputEl(r.content, '内容');
  $('#record-rows').append(rowEl([badge, name, content], () => {}));
}

// ---------- chips ----------

function renderChips(): void {
  const tagBox = $('#tag-chips');
  tagBox.innerHTML = allTags.length ? '' : '<span class="meta">管理表为空（Ctrl+M 或管理页添加）</span>';
  for (const t of allTags) {
    const chip = document.createElement('button');
    chip.className = `chip${selectedTags.has(t.id) ? ' on' : ''}`;
    chip.textContent = t.name;
    chip.addEventListener('click', () => {
      if (selectedTags.has(t.id)) selectedTags.delete(t.id);
      else selectedTags.add(t.id);
      renderChips();
    });
    tagBox.append(chip);
  }
  const linkBox = $('#link-chips');
  linkBox.innerHTML = allLinks.length ? '' : '<span class="meta">管理表为空</span>';
  for (const l of allLinks) {
    const chip = document.createElement('button');
    chip.className = `chip${selectedLinks.has(l.id) ? ' on' : ''}`;
    chip.textContent = `${l.type}: ${l.value}`;
    chip.addEventListener('click', () => {
      if (selectedLinks.has(l.id)) selectedLinks.delete(l.id);
      else selectedLinks.add(l.id);
      renderChips();
    });
    linkBox.append(chip);
  }
}

// ---------- 加载 / 保存 ----------

function renderForm(): void {
  ($('#title-input') as HTMLInputElement).value = bookmark.title;
  const fmt = (t: number) => new Date(t).toLocaleString();
  $('#timestamps').textContent =
    `创建 ${fmt(bookmark.createdAt)} · 修改 ${fmt(bookmark.updatedAt)} · 最近使用 ${fmt(bookmark.lastUsedAt)}`;
  bookmark.urls.forEach(addUrlRow);
  bookmark.accounts.forEach(addAccountRow);
  bookmark.records.forEach(addRecordRow);
  ($('#remark-input') as HTMLTextAreaElement).value = bookmark.remark;
  renderChips();
  $('#form').hidden = false;
}

async function load(): Promise<void> {
  [allTags, allLinks] = await Promise.all([vault.listTags(), vault.listLinkedInfos()]);
  if (editId) {
    const b = await vault.getBookmarkDecrypted(editId);
    if (!b) throw new Error('书签不存在');
    bookmark = b;
  } else {
    bookmark = blankBookmark();
  }
  bookmark.tags.forEach((t) => selectedTags.add(t));
  bookmark.linkedInfos.forEach((l) => selectedLinks.add(l));
  ($('#archive-btn') as HTMLButtonElement).textContent = bookmark.status === 'archived' ? '恢复' : '归档';
  renderForm();
}

async function closeSelf(): Promise<void> {
  const w = await chrome.windows.getCurrent();
  if (w.id !== undefined) await chrome.windows.remove(w.id);
}

async function save(): Promise<void> {
  const urls = [...document.querySelectorAll('#url-rows .row')]
    .map((row) => {
      const [url, match] = [...row.querySelectorAll('input,select')] as [HTMLInputElement, HTMLSelectElement];
      return { url: url.value.trim(), match: match.value as vault.UrlMatch };
    })
    .filter((u) => u.url !== '');
  const accounts = [...document.querySelectorAll('#account-rows .row')]
    .map((row) => {
      const [username, password, label] = [...row.querySelectorAll('input')] as [
        HTMLInputElement, HTMLInputElement, HTMLInputElement,
      ];
      return { username: username!.value.trim(), password: password!.value, label: label!.value.trim() || undefined };
    })
    .filter((a) => a.username !== '' || a.password !== '');
  const records = [...document.querySelectorAll('#record-rows .row')]
    .map((row) => {
      const badge = row.querySelector<HTMLElement>('.badge')!;
      const [name, content] = [...row.querySelectorAll('input')] as [HTMLInputElement, HTMLInputElement];
      return { template: badge.dataset.template as 'note' | 'secret', name: name!.value.trim(), content: content!.value };
    })
    .filter((r) => r.name !== '' || r.content !== '');

  const data = {
    title: ($('#title-input') as HTMLInputElement).value.trim() || '未命名',
    remark: ($('#remark-input') as HTMLTextAreaElement).value,
    tags: [...selectedTags],
    linkedInfos: [...selectedLinks],
    urls, accounts, records,
  };
  if (editId) await vault.saveBookmark({ ...bookmark, ...data });
  else await vault.addBookmark({ ...blankBookmark(), ...data, urls: urls.length ? urls : [{ url: 'about:blank', match: 'host' }] });
  await closeSelf();
}

// ---------- 启动：解锁门控 ----------

async function init(): Promise<void> {
  if (await keychain.isUnlocked()) {
    await load();
    return;
  }
  $('#unlock').hidden = false;
  const pw = $('#unlock-pw') as HTMLInputElement;
  pw.focus();
  const tryUnlock = async () => {
    if (await keychain.unlock(pw.value)) {
      $('#unlock').hidden = true;
      await load();
    } else {
      $('#unlock-err').hidden = false;
    }
    pw.value = '';
  };
  $('#unlock-btn').addEventListener('click', () => void tryUnlock());
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryUnlock(); });
}

$('#add-url').addEventListener('click', () => addUrlRow({ url: '', match: 'host' }));
$('#add-account').addEventListener('click', () => addAccountRow({ username: '', password: '' }));
$('#add-note').addEventListener('click', () => addRecordRow({ template: 'note', name: '', content: '' }));
$('#add-secret').addEventListener('click', () => addRecordRow({ template: 'secret', name: '', content: '' }));
$('#save-btn').addEventListener('click', () => void save());
// 归档/恢复：以切换后的状态保存当前条目
$('#archive-btn').addEventListener('click', () => void (async () => {
  if (!editId) { await closeSelf(); return; }
  const next = bookmark.status === 'archived' ? 'active' : 'archived';
  await vault.saveBookmark({ ...bookmark, status: next });
  await closeSelf();
})());
$('#delete-btn').addEventListener('click', () => void (async () => {
  if (editId) await vault.deleteBookmark(editId);
  await closeSelf();
})());
$('#cancel-btn').addEventListener('click', () => void closeSelf());

await init();
