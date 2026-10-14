/**
 * 主密码与解锁状态管理（keychain）。
 *
 * - 主密码永不落盘；storage.local 只存 { salt, iterations, verifier }
 * - verifier = 用派生密钥加密固定串，解锁时解密校验密码是否正确
 * - 解锁后密钥以 base64 形式存 storage.session：SW 休眠不丢、浏览器重启必丢（=重启锁定）
 * - 惰性超时锁：每次取密钥时检查距上次活跃是否超阈值（默认 30 分钟，可配置）
 */

import { decryptString, deriveKey, encryptString, exportKeyB64, importKeyB64, randomSaltB64 } from './crypto';

const META_KEY = 'meta:key';
const SESSION_KEY = 'key:key';
const SESSION_LAST = 'key:lastActive';
const SETTINGS_KEY = 'meta:settings';
const VERIFIER_PLAINTEXT = 'vipper-key-verifier';
const PBKDF2_ITERATIONS = 600_000;

interface KeyMeta {
  salt: string;
  iterations: number;
  verifier: string;
}

export interface VaultSettings {
  lockTimeoutMin: number;
  autoArchiveDays: number;
  /** 主题：dark（默认）/ light / system */
  theme: 'dark' | 'light' | 'system';
  /** 界面语言：zh（默认）/ en */
  lang: 'zh' | 'en';
  /** 用户名生成器：单词长度 / 数字长度 */
  genWordLen: number;
  genDigitLen: number;
  /** 密码生成器：长度 / 是否含符号 */
  genPassLen: number;
  genPassSymbols: boolean;
}

/** 0 = 不开启（超时锁定/自动归档默认关闭，spec 2026-10-14 修订） */
const DEFAULT_SETTINGS: VaultSettings = {
  lockTimeoutMin: 0, autoArchiveDays: 0,
  theme: 'dark', lang: 'zh',
  genWordLen: 8, genDigitLen: 2, genPassLen: 12, genPassSymbols: true,
};

export async function isInitialized(): Promise<boolean> {
  return (await chrome.storage.local.get(META_KEY))[META_KEY] !== undefined;
}

/** 首次设置主密码 */
export async function setupMasterPassword(password: string): Promise<void> {
  if (await isInitialized()) throw new Error('master password already set');
  const salt = randomSaltB64();
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const meta: KeyMeta = {
    salt,
    iterations: PBKDF2_ITERATIONS,
    verifier: await encryptString(key, VERIFIER_PLAINTEXT),
  };
  await chrome.storage.local.set({ [META_KEY]: meta });
  await chrome.storage.session.set({ [SESSION_KEY]: await exportKeyB64(key), [SESSION_LAST]: Date.now() });
}

/** 解锁：密码错误返回 false */
export async function unlock(password: string): Promise<boolean> {
  const meta = (await chrome.storage.local.get(META_KEY))[META_KEY] as KeyMeta | undefined;
  if (!meta) return false;
  const key = await deriveKey(password, meta.salt, meta.iterations);
  try {
    if ((await decryptString(key, meta.verifier)) !== VERIFIER_PLAINTEXT) return false;
  } catch {
    return false;
  }
  await chrome.storage.session.set({ [SESSION_KEY]: await exportKeyB64(key), [SESSION_LAST]: Date.now() });
  return true;
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove([SESSION_KEY, SESSION_LAST]);
}

export async function getSettings(): Promise<VaultSettings> {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<VaultSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function setSettings(patch: Partial<VaultSettings>): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(await getSettings()), ...patch } });
}

/**
 * 取当前密钥。未解锁或超时返回 null；成功则刷新活跃时间（惰性滑动锁定）。
 * lockTimeoutMin 为 0 时不做超时判定（默认关闭，spec 2026-10-14）。
 */
export async function getKey(): Promise<CryptoKey | null> {
  const s = await chrome.storage.session.get([SESSION_KEY, SESSION_LAST]);
  const keyB64 = s[SESSION_KEY] as string | undefined;
  if (!keyB64) return null;
  const { lockTimeoutMin } = await getSettings();
  if (lockTimeoutMin > 0 && Date.now() - ((s[SESSION_LAST] as number | undefined) ?? 0) > lockTimeoutMin * 60_000) {
    await lock();
    return null;
  }
  await chrome.storage.session.set({ [SESSION_LAST]: Date.now() });
  return importKeyB64(keyB64);
}

export async function isUnlocked(): Promise<boolean> {
  return (await getKey()) !== null;
}
