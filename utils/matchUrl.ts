/**
 * URL 匹配规则（spec: 数据模型 · URL 区）：
 * - host：hostname 相同（默认；端口/路径/协议不参与）
 * - exact：origin + pathname 相同（忽略 query 与 hash——登录页常带 ?redirect= 等参数）
 * - prefix：页面 URL 以书签 URL 开头
 */

import type { UrlMatch } from './vault';

export function matchUrl(rule: UrlMatch, bookmarkUrl: string, pageUrl: string): boolean {
  try {
    const b = new URL(bookmarkUrl);
    const p = new URL(pageUrl);
    switch (rule) {
      case 'host':
        return b.hostname === p.hostname;
      case 'exact':
        return b.origin === p.origin && b.pathname === p.pathname;
      case 'prefix':
        return p.href.startsWith(b.href);
    }
  } catch {
    return false;
  }
}
