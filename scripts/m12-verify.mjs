/**
 * M12 自动化验收：搜索支持中文首拼与全拼。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333，全新 profile）。
 *
 * 断言：
 * - 首拼/全拼命中 title（淘宝 tb/taobao、中国银行 yh/yinhang、重庆火锅 cq/chongqing、长城 cc/changcheng、长沙 cs/changsha、京东 jd/jingdong）
 * - 首拼/全拼命中 remarks（二次验证 ec/erci、工资卡 gzk/gongzi、旅行计划 lxjh/lvxing）
 * - 原有直接子串（title / url）与空查询排序不回归
 * - 大小写、空格/标点归一化
 * - 无命中为空
 */

import { connectSW, createChecker, sleep } from './lib/sw-driver.mjs';

const { sw, attachPage, close } = await connectSW();
const { check, summary } = createChecker();

await sw(`__vipper.keychain.setupMasterPassword('m12-test')`);

// ---- 1. 播种：URL 均不含被断言的首拼/全拼，确保命中来自拼音转换 ----
await sw(`(async () => {
  const base = Date.now();
  const defs = [
    ['淘宝网', '常用购物', 'https://taobao.example.com'],
    ['京东', '二次验证', 'https://jingdong.example.com'],
    ['中国银行', '工资卡', 'https://boc.example.com'],
    ['重庆火锅', '解放碑', 'https://hotpot.example.com'],
    ['长城', '历史遗迹', 'https://greatwall.example.com'],
    ['长沙', '旅行计划', 'https://changsha.example.com'],
    ['GitHub', 'code host', 'https://github.com'],
    ['Steam', '游戏', 'https://steam.example.com'],
  ];
  for (let i = 0; i < defs.length; i++) {
    const [title, remarks, url] = defs[i];
    await __vipper.vault.addBookmark({
      title, remarks, urls: [{ url, match: 'host' }], lastUsedAt: base - i * 1000,
    });
  }
})()`);

// ---- 2. 打开 wui 并等待列表首屏 ----
await sw(`chrome.windows.create({ url: chrome.runtime.getURL('wui.html'), type: 'popup', width: 1600, height: 900 })`);
const page = await attachPage('wui.html');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(300);
for (let i = 0; i < 40; i++) {
  if (await page(`document.querySelectorAll('#results-body tr').length > 0`).catch(() => false)) break;
  await sleep(250);
}
await sleep(300);

async function search(q) {
  await page(`(() => {
    const i = document.querySelector('#search');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input'));
  })()`);
  await sleep(250);
  return JSON.parse(await page(`JSON.stringify(
    [...document.querySelectorAll('#results-body tr')].map((tr) => tr.children[1]?.textContent),
  )`));
}

const only = (rows, title) => rows.length === 1 && rows[0] === title;

// ---- 3. 空查询：全部 + lastUsedAt 降序 ----
const all = await search('');
check('空查询返回全部且按 lastUsedAt 降序', all.length === 8 && all[0] === '淘宝网' && all[7] === 'Steam', all);

// ---- 4. title 首拼 / 全拼 ----
const titleCases = [
  ['tb', '淘宝网'], ['taobao', '淘宝网'],
  ['yh', '中国银行'], ['yinhang', '中国银行'], ['zhongguo', '中国银行'],
  ['cq', '重庆火锅'], ['chongqing', '重庆火锅'],
  ['cc', '长城'], ['changcheng', '长城'],
  ['cs', '长沙'], ['changsha', '长沙'],
  ['jd', '京东'], ['jingdong', '京东'],
];
for (const [q, title] of titleCases) {
  const rows = await search(q);
  check(`title 「${title}」命中 ${q}`, only(rows, title), rows);
}

// ---- 5. remarks 首拼 / 全拼 ----
const remarksCases = [
  ['ec', '京东'], ['erci', '京东'],          // 二次验证
  ['gzk', '中国银行'], ['gongzi', '中国银行'], // 工资卡
  ['lxjh', '长沙'], ['lvxing', '长沙'], ['lüxing', '长沙'], // 旅行计划（ü → v 归一化）
];
for (const [q, title] of remarksCases) {
  const rows = await search(q);
  check(`remarks 「${title}」命中 ${q}`, only(rows, title), rows);
}

// ---- 6. 原有直接匹配 + 归一化 + 无命中 ----
const direct = await search('git');
check('直接子串仍命中 title（git → GitHub）', only(direct, 'GitHub'), direct);

const urlHit = await search('hotpot');
check('直接子串仍命中 url（hotpot → 重庆火锅）', only(urlHit, '重庆火锅'), urlHit);

const upper = await search('TB');
check('大小写不敏感（TB → 淘宝网）', only(upper, '淘宝网'), upper);

const spaced = await search('tao bao');
check('空格/标点归一化（tao bao → 淘宝网）', only(spaced, '淘宝网'), spaced);

const miss = await search('zzzz');
check('无命中返回空列表', miss.length === 0, miss);

summary();
close();
