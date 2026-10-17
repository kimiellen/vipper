/**
 * M4 自动化验收：凭据库核心（加密层 + 主密码/锁定 + 拆 key 存储布局）。
 * 前置：按 AGENTS.md「自动化测试回路」启动 Chromium（加载 .output/chrome-mv3，端口 9333）。
 *
 * 断言：
 * - 主密码设置/解锁/错误密码拒绝
 * - 敏感字段（account.password、secret.content）密文落盘、明文不落盘
 * - 解密往返一致
 * - lock() 与模拟浏览器重启（清空 storage.session）后锁定
 * - 惰性超时锁（lastActive 过期后自动锁定）
 * - idx 索引与 bm: 详情一致
 */

import { connectSW, createChecker } from './lib/sw-driver.mjs';

const { sw, close } = await connectSW();
const { check, summary } = createChecker();

// ---- 主密码设置与解锁 ----
check('初始化前 isInitialized=false', await sw(`__vipper.keychain.isInitialized()`) === false);
await sw(`__vipper.keychain.setupMasterPassword('correct-horse')`);
check('设置主密码后 isInitialized=true', await sw(`__vipper.keychain.isInitialized()`) === true);
check('设置后处于解锁状态', await sw(`__vipper.keychain.isUnlocked()`) === true);

// ---- 敏感字段加密落盘 ----
const id = await sw(`(async () => {
  const b = await __vipper.vault.addBookmark({
    title: 'Bank', urls: [{ url: 'https://bank.example.com/login', match: 'host' }],
    accounts: [{ username: 'alice', password: 's3cret!' }],
    records: [{ template: 'secret', name: '密保问题', content: '第一只宠物叫旺财' },
              { template: 'note', name: '备注记录', content: '明文内容' }],
    remarks: '常用',
  });
  return b.id;
})()`);

const rawCheck = JSON.parse(await sw(`(async () => {
  const raw = (await chrome.storage.local.get('bm:${id}'))['bm:${id}'];
  const blob = JSON.stringify(raw);
  return JSON.stringify({
    pwEnvelope: raw.accounts[0].password.startsWith('{"$enc"'),
    secretEnvelope: raw.records[0].content.startsWith('{"$enc"'),
    noPlainPw: !blob.includes('s3cret!'),
    noPlainSecret: !blob.includes('旺财'),
    notePlain: raw.records[1].content === '明文内容',
    titlePlain: raw.title === 'Bank',
    remarksPlain: raw.remarks === '常用',
  });
})()`));
check('password 以 $enc 信封落盘', rawCheck.pwEnvelope, rawCheck);
check('secret.content 以 $enc 信封落盘', rawCheck.secretEnvelope, rawCheck);
check('落盘数据不含明文密码/私密内容', rawCheck.noPlainPw && rawCheck.noPlainSecret, rawCheck);
check('note 记录与 title/remarks 保持明文', rawCheck.notePlain && rawCheck.titlePlain && rawCheck.remarksPlain, rawCheck);

// ---- 解密往返 ----
const round = JSON.parse(await sw(`(async () => {
  const b = await __vipper.vault.getBookmarkDecrypted('${id}');
  return JSON.stringify({ pw: b.accounts[0].password, secret: b.records[0].content });
})()`));
check('解密往返一致', round.pw === 's3cret!' && round.secret === '第一只宠物叫旺财', round);

// ---- idx 索引一致 ----
const idxEntry = JSON.parse(await sw(`(async () => {
  const idx = await __vipper.vault.listIndex();
  return JSON.stringify(idx.find((e) => e.id === '${id}') ?? null);
})()`));
check('idx 索引含该条目（title/urls/status）',
  idxEntry?.title === 'Bank' && idxEntry?.urls?.[0]?.url === 'https://bank.example.com/login' && idxEntry?.status === 'active',
  idxEntry);

// ---- 锁定与解锁 ----
await sw(`__vipper.keychain.lock()`);
check('lock() 后锁定', await sw(`__vipper.keychain.isUnlocked()`) === false);
check('锁定后解密读取被拒绝', await sw(`__vipper.vault.getBookmarkDecrypted('${id}').then(() => 'resolved', (e) => String(e))`)
  .then((s) => s.includes('locked')));

check('错误密码拒绝解锁', await sw(`__vipper.keychain.unlock('wrong-password')`) === false);
check('正确密码解锁', await sw(`__vipper.keychain.unlock('correct-horse')`) === true);

// ---- 模拟浏览器重启：清空 storage.session → 重启锁定 ----
await sw(`chrome.storage.session.clear()`);
check('模拟重启后锁定（storage.session 清空）', await sw(`__vipper.keychain.isUnlocked()`) === false);

// ---- 惰性超时锁（M9b 起默认 0 = 关闭；显式设置后生效）----
await sw(`__vipper.keychain.unlock('correct-horse')`);
await sw(`chrome.storage.session.set({ 'key:lastActive': Date.now() - 31 * 60 * 1000 })`);
check('默认关闭超时锁：31 分钟无操作仍保持解锁', await sw(`__vipper.keychain.isUnlocked()`) === true);
await sw(`__vipper.keychain.setSettings({ lockTimeoutMin: 30 })`);
await sw(`chrome.storage.session.set({ 'key:lastActive': Date.now() - 31 * 60 * 1000 })`);
check('设置 30 分钟超时后自动锁定', await sw(`__vipper.keychain.isUnlocked()`) === false);

summary();
close();
