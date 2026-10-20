/** Vite `?inline` CSS 导入：返回 CSS 字符串，不注入文档（content script 用于 shadow DOM） */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
