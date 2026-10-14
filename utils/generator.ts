/**
 * 用户名/密码生成器（纯前端，无依赖；spec: UI 载体 · Settings→general 内置）。
 * 规则参数持久化在 meta:settings（genWordLen/genDigitLen/genPassLen/genPassSymbols）。
 */

/** 常见可读单词池（用户名生成用） */
const WORDS = [
  'maple', 'river', 'stone', 'cloud', 'tiger', 'ocean', 'forest', 'ember',
  'willow', 'falcon', 'cedar', 'breeze', 'harbor', 'meadow', 'otter', 'raven',
  'summit', 'coral', 'drift', 'flint', 'glade', 'heron', 'juniper', 'kelp',
  'lark', 'moss', 'north', 'onyx', 'pine', 'quartz', 'ridge', 'sage',
  'thorn', 'umber', 'vale', 'wren', 'yarrow', 'zephyr', 'aspen', 'birch',
  'clover', 'dune', 'elm', 'fern', 'grove', 'holly', 'iris', 'lake',
];

const LOWER = 'abcdefghijkmnpqrstuvwxyz';   // 去 l 防混淆
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';    // 去 I 防混淆
const DIGITS = '23456789';                   // 去 0/1 防混淆
const SYMBOLS = '#$!%&*+-=?@';

function randInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

function pick(chars: string): string {
  return chars[randInt(chars.length)]!;
}

/** 用户名：随机单词拼接截断到 wordLen + 尾部 digitLen 位数字（如 mapleriver42） */
export function genUsername(wordLen: number, digitLen: number): string {
  let word = '';
  while (word.length < wordLen) word += WORDS[randInt(WORDS.length)];
  word = word.slice(0, Math.max(1, wordLen));
  let digits = '';
  for (let i = 0; i < digitLen; i++) digits += pick(DIGITS);
  return word + digits;
}

/** 密码：len 位，含大小写数字（可选符号）；保证每类字符至少出现一次 */
export function genPassword(len: number, symbols: boolean): string {
  const pools = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
  const all = pools.join('');
  const n = Math.max(len, pools.length);
  const chars = pools.map(pick); // 每类先保一个
  while (chars.length < n) chars.push(pick(all));
  // Fisher–Yates 洗牌，避免必含字符固定在前缀
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('').slice(0, n);
}
