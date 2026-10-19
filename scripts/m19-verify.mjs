/**
 * M19 自动化验收：账号框按密码框上下文定位，不误填页面搜索框。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 场景（模拟 Steam 登录页：页头搜索框 + 正文登录表单，账号框没有任何 name/id/placeholder 语义）：
 * - form：搜索框在 form 外，账号框紧邻密码框之前 → 账号填进 form 内文本框
 * - noform：同样的结构但无 <form> → 退回按 DOM 邻近关系定位账号框
 * - labeled：账号框带 name="username" → 语义提示仍优先
 */

import http from 'node:http';
import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const PORT = 8390;

const page = ({ form, labeled }) => {
  const user = labeled ? '<input id="acct" name="username" type="text" />' : '<input id="acct" type="text" />';
  const fields = `${user}<input id="pass" name="password" type="password" />`;
  return `<!doctype html><html><body>
<header><input id="search" name="term" type="text" placeholder="Search the store" /></header>
${form ? `<form action="/login">${fields}</form>` : fields}
</body></html>`;
};

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  const [path] = (req.url ?? '/').split('?');
  res.end(
    page({
      form: path !== '/noform',
      labeled: path === '/labeled',
    }),
  );
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m19-test')`);
for (const path of ['/form', '/noform', '/labeled']) {
  await sw(`__vipper.vault.addBookmark({
    title: 'SteamLike${path}',
    urls: [{ url: 'http://127.0.0.1:${PORT}${path}', match: 'exact' }],
    accounts: [{ username: 'alice', password: 'p1' }],
  })`);
}

async function openAndFill(path) {
  const tabId = await sw(`(async () => {
    const win = await chrome.windows.getCurrent();
    const t = await chrome.tabs.create({ windowId: win.id, url: 'http://127.0.0.1:${PORT}${path}', active: true });
    return t.id;
  })()`);
  await sleep(900);
  await sw(`__vipper.dispatch('autofill')`);
  await sleep(1200);
  const res = await sw(`chrome.scripting.executeScript({
    target: { tabId: ${tabId} },
    func: () => ({
      search: document.querySelector('#search')?.value ?? null,
      user: document.querySelector('#acct')?.value ?? null,
      pass: document.querySelector('#pass')?.value ?? null,
    }),
  })`);
  await sw(`chrome.tabs.remove(${tabId})`).catch(() => {});
  return res[0].result;
}

let r = await openAndFill('/form');
check('form：账号填进密码框之前的文本框', r.user === 'alice', r);
check('form：页头搜索框不被填充', r.search === '', r);
check('form：密码正常填充', r.pass === 'p1', r);

r = await openAndFill('/noform');
check('noform：无 form 时按 DOM 邻近关系定位账号框', r.user === 'alice', r);
check('noform：页头搜索框不被填充', r.search === '', r);
check('noform：密码正常填充', r.pass === 'p1', r);

r = await openAndFill('/labeled');
check('labeled：name=username 的账号框仍优先', r.user === 'alice', r);
check('labeled：页头搜索框不被填充', r.search === '', r);

summary();
server.close();
close();
