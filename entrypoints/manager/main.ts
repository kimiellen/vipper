/**
 * 管理表页：tag 与关联信息的全局管理（先建后选，编辑页以选单引用）+ 数据导入导出。
 * 导出：必须当场输入主密码确认（即使已解锁）；导入：需解锁（明文敏感字段要重新加密落盘）。
 */

import * as keychain from '../../utils/keychain';
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
    del.addEventListener('click', () =>
      void vault.deleteTag(t.id).then(render).catch((e) => {
        const err = $('#tag-err');
        err.textContent = String(e);
        err.hidden = false;
      }),
    );
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
    val.textContent = `${l.name}: ${l.value}`;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', () =>
      void vault.deleteLinkedInfo(l.id).then(render).catch((e) => {
        const err = $('#link-err');
        err.textContent = String(e);
        err.hidden = false;
      }),
    );
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
  const name = $('#new-link-type') as HTMLInputElement; // M9e 重建时改为名称字段
  const value = $('#new-link-value') as HTMLInputElement;
  const err = $('#link-err');
  try {
    await vault.addLinkedInfo(name.value.trim(), value.value.trim());
    name.value = '';
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

// ---------- 导入导出 ----------

function dataStatus(text: string, isError = false): void {
  const el = isError ? $('#data-err') : $('#data-status');
  el.textContent = text;
  el.hidden = false;
  if (isError) $('#data-status').textContent = '';
  else $('#data-err').hidden = true;
}

/** 导出前当场验证主密码（spec：导出需确认主密码） */
$('#export-btn').addEventListener('click', () => void (async () => {
  const pw = ($('#data-pw') as HTMLInputElement).value;
  if (!(await keychain.unlock(pw))) { dataStatus('主密码错误', true); return; }
  ($('#data-pw') as HTMLInputElement).value = '';
  const data = await vault.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vipper-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  dataStatus(`已导出 ${data.bookmarks.length} 条书签`);
})());

$('#import-btn').addEventListener('click', () => ($('#import-file') as HTMLInputElement).click());
($('#import-file') as HTMLInputElement).addEventListener('change', (e) => void (async () => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    // 导入需要解锁（明文敏感字段重新加密）；若已锁定则先验证主密码
    if (!(await keychain.isUnlocked())) {
      const pw = ($('#data-pw') as HTMLInputElement).value;
      if (!(await keychain.unlock(pw))) { dataStatus('已锁定且主密码错误', true); return; }
    }
    const result = await vault.importAll(JSON.parse(await file.text()));
    dataStatus(`导入完成：新增 ${result.added} · 更新 ${result.updated} · 跳过 ${result.skipped}`);
    await render();
  } catch (err) {
    dataStatus(`导入失败：${String(err)}`, true);
  } finally {
    (e.target as HTMLInputElement).value = '';
  }
})());

await render();
