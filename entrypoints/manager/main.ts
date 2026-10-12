/**
 * 管理表页：tag 与关联信息的全局管理（先建后选，编辑页以选单引用）。
 */

import * as vault from '../../utils/vault';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function render(): Promise<void> {
  const [tags, links] = await Promise.all([vault.listTags(), vault.listLinkedInfos()]);

  const tagList = $('#tag-list');
  tagList.innerHTML = '';
  for (const t of tags) {
    const row = document.createElement('div');
    row.className = 'row';
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = t.name;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', () => void vault.deleteTag(t.id).then(render));
    row.append(val, del);
    tagList.append(row);
  }

  const linkList = $('#link-list');
  linkList.innerHTML = '';
  for (const l of links) {
    const row = document.createElement('div');
    row.className = 'row';
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = `${l.type}: ${l.value}`;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', () => void vault.deleteLinkedInfo(l.id).then(render));
    row.append(val, del);
    linkList.append(row);
  }
}

async function addTag(): Promise<void> {
  const input = $('#new-tag') as HTMLInputElement;
  const err = $('#tag-err');
  try {
    await vault.addTag(input.value.trim());
    input.value = '';
    err.hidden = true;
    await render();
  } catch (e) {
    err.textContent = String(e);
    err.hidden = false;
  }
}

async function addLink(): Promise<void> {
  const type = $('#new-link-type') as HTMLInputElement;
  const value = $('#new-link-value') as HTMLInputElement;
  const err = $('#link-err');
  try {
    await vault.addLinkedInfo(type.value.trim(), value.value.trim());
    type.value = '';
    value.value = '';
    err.hidden = true;
    await render();
  } catch (e) {
    err.textContent = String(e);
    err.hidden = false;
  }
}

$('#add-tag').addEventListener('click', () => void addTag());
$('#add-link').addEventListener('click', () => void addLink());

await render();
