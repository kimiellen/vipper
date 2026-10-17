/**
 * keeper 导出 JSON → vipper 导入 JSON 转换器。
 *
 * 用法：node scripts/keeper-to-vipper.mjs <keeper导出.json> <输出.json>
 *
 * 映射（keeper 模型 → vipper 模型）：
 * - bookmark.name → title；notes → remarks；urls（空则兜底 about:blank，match 默认 host）
 * - accounts → accounts（明文密码，导入时 vipper 重新加密落盘）；accounts.relatedIds 的并集 → bookmark.linkedInfos
 * - tagIds → tags（id 重生成 UUID）；tag 颜色 #hex → 最近的 Catppuccin 14 色
 * - relations → linkedInfos（注意：keeper 导出不含 relation.value，value 置空——keeper 侧 ExportRelation 结构限制）
 * - pinyinInitials/pinyinFull 丢弃；keeper 无 records/归档概念 → records: []、status: 'active'
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Catppuccin Mocha 14 色（与 design-system/tokens.css 一致） */
const CAT_COLORS = {
  rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
  red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af',
  green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec',
  blue: '#89b4fa', lavender: '#b4befe',
};

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** keeper 的任意 hex 颜色 → 欧氏距离最近的 Catppuccin 色名 */
function nearestCatColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex ?? '')) return 'mauve';
  const [r, g, b] = hexRgb(hex);
  let best = 'mauve';
  let bestDist = Infinity;
  for (const [name, catHex] of Object.entries(CAT_COLORS)) {
    const [cr, cg, cb] = hexRgb(catHex);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

const ms = (iso) => Date.parse(iso);

function convert(keeper) {
  if (keeper?.version !== 'keeper-1.0' || !Array.isArray(keeper.bookmarks)) {
    throw new Error('不是有效的 keeper 导出文件（version 应为 keeper-1.0）');
  }

  const tagIdMap = new Map(); // keeper i64 → vipper uuid
  const tags = (keeper.tags ?? []).map((t) => {
    const id = crypto.randomUUID();
    tagIdMap.set(t.id, id);
    return { id, name: t.name, color: nearestCatColor(t.color) };
  });

  const linkIdMap = new Map();
  const linkedInfos = (keeper.relations ?? []).map((r) => {
    const id = crypto.randomUUID();
    linkIdMap.set(r.id, id);
    return { id, name: r.name, value: '' }; // keeper 导出不含 relation.value
  });

  const bookmarks = keeper.bookmarks.map((b) => {
    const urls = (b.urls ?? []).filter((u) => u?.url);
    return {
      id: b.id, // keeper 的 UUID 原样保留（重复导入同一备份幂等）
      title: b.name,
      remarks: b.notes ?? '',
      tags: (b.tagIds ?? []).map((id) => tagIdMap.get(id)).filter(Boolean),
      linkedInfos: [...new Set((b.accounts ?? []).flatMap((a) => a.relatedIds ?? []))]
        .map((id) => linkIdMap.get(id)).filter(Boolean),
      urls: urls.length ? urls.map((u) => ({ url: u.url, match: 'host' })) : [{ url: 'about:blank', match: 'host' }],
      accounts: (b.accounts ?? []).map((a) => ({ username: a.username, password: a.password })),
      records: [],
      status: 'active',
      createdAt: ms(b.createdAt),
      updatedAt: ms(b.updatedAt),
      lastUsedAt: ms(b.lastUsedAt),
    };
  });

  return {
    app: 'vipper',
    version: 2,
    exportedAt: Date.now(),
    bookmarks,
    tags,
    linkedInfos,
  };
}

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('用法：node scripts/keeper-to-vipper.mjs <keeper导出.json> <输出.json>');
  process.exit(1);
}
const keeper = JSON.parse(readFileSync(input, 'utf-8'));
const out = convert(keeper);
writeFileSync(output, JSON.stringify(out, null, 2));
console.log(`转换完成：${out.bookmarks.length} 条书签 · ${out.tags.length} 个 tag · ${out.linkedInfos.length} 条关联信息 → ${output}`);
