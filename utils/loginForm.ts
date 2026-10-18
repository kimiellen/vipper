/**
 * 登录字段选择器：content script 的填充逻辑与 service worker 的 frame 探测共用。
 *
 * 登录表单可能位于跨域 iframe（如 163 邮箱），顶层 document 无法跨域查询，
 * 因此 SW 需要在每个 frame 各跑一次同一组选择器，定位真正承载表单的 frame。
 */

/** 密码框候选（可见性由调用方过滤）：填充优先级最高，也是判断「这一 frame 是登录页」的最强信号 */
export const PASSWORD_SELECTOR = 'input[type="password"]:not([disabled])';

/** 显式标注为账号的输入框，优先于普通文本框 */
export const USERNAME_AUTOCOMPLETE_SELECTOR =
  'input[autocomplete="username"], input[autocomplete="email"]';

/** 账号框候选：autocomplete 之外再覆盖常见文本输入类型（最后回落到第一个） */
export const USERNAME_CANDIDATE_SELECTOR =
  'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';

/** name/id/placeholder/aria-label 里的账号语义提示词 */
export const USERNAME_HINT_RE = /user|email|login|account|phone|name/i;
