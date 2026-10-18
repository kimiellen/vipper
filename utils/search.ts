/**
 * 索引检索：直接子串 + 中文拼音（首拼 / 全拼）。
 *
 * 拼音转换只在这里发生，且本模块只允许 wui 引用——pinyin-pro 词典约 140KB gzip，
 * 不能经 background 的 `import * as vault` 进入 service worker 包。
 */

import { pinyin } from 'pinyin-pro';
import type { IndexEntry } from './vault';

interface PinyinHaystack {
  first: string;
  full: string;
}

/** 按文本缓存转换结果：idx 条目量小，搜索时同一 title/remarks 只转换一次 */
const haystacks = new Map<string, PinyinHaystack>();

function haystack(text: string): PinyinHaystack {
  let h = haystacks.get(text);
  if (!h) {
    // nonZh: 'removed'：拼音串只保留汉字读音，英文/标点仍由 filterIndex 的直接子串匹配覆盖
    h = {
      first: pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'removed' })
        .join('')
        .toLowerCase(),
      full: pinyin(text, { toneType: 'none', type: 'array', nonZh: 'removed', v: true })
        .join('')
        .toLowerCase(),
    };
    haystacks.set(text, h);
  }
  return h;
}

/** 拼音查询归一化：ü 归一为 v，其余只保留小写字母数字（空格/标点不参与拼音匹配） */
const pinyinQuery = (q: string) => q.toLowerCase().replace(/ü/g, 'v').replace(/[^a-z0-9]/g, '');

/** 索引级检索：标题、备注或任一 URL 直接包含查询串，或标题/备注的拼音首拼/全拼命中；空查询返回全部（按 lastUsedAt 降序） */
export function filterIndex(entries: IndexEntry[], query: string): IndexEntry[] {
  const sorted = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const q = query.trim().toLowerCase();
  if (!q) return sorted;
  const qp = pinyinQuery(q);
  return sorted.filter((e) => {
    const direct =
      e.title.toLowerCase().includes(q) ||
      (e.remarks ?? '').toLowerCase().includes(q) ||
      e.urls.some((u) => u.url.toLowerCase().includes(q));
    if (direct || !qp) return direct;
    return [e.title, e.remarks ?? ''].some((text) => {
      const h = haystack(text);
      return h.first.includes(qp) || h.full.includes(qp);
    });
  });
}
