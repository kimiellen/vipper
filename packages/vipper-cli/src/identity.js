/**
 * vipper-cli 客户端身份（socket-access.md §5.1/§5.3）：
 * 首次连接生成 X25519 密钥对，私钥 JWK 存 ~/.config/vipper/client-key（0600），
 * 此后每次连接复用同一身份；只有私钥文件被删/用户撤销/主动重新配对时身份才变。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  exportIdentityPub, fingerprint, generateIdentity, identityFromJwk, identityToJwk,
} from '../../vipper-protocol/crypto.js';

/** @returns {string} 配置目录（遵循 XDG_CONFIG_HOME） */
export function configDir() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'vipper');
}

/** @returns {string} 私钥文件路径 */
export function clientKeyPath() {
  return join(configDir(), 'client-key');
}

/**
 * 读取或创建客户端身份。
 * @returns {Promise<{ pair: CryptoKeyPair, identityPub: string, fingerprint: string, created: boolean }>}
 */
export async function ensureIdentity() {
  const path = clientKeyPath();
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const pair = await identityFromJwk(saved);
    const identityPub = await exportIdentityPub(pair.publicKey);
    return { pair, identityPub, fingerprint: await fingerprint(identityPub), created: false };
  } catch {
    // 缺失或损坏：生成新身份（旧身份在扩展侧的配对记录随之失效，需重新配对）
    const pair = await generateIdentity();
    const jwks = await identityToJwk(pair);
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ v: 1, ...jwks }), { mode: 0o600 });
    chmodSync(path, 0o600); // 兜底：umask 宽松时 mode 参数只在创建时生效，强制收敛
    const identityPub = await exportIdentityPub(pair.publicKey);
    return { pair, identityPub, fingerprint: await fingerprint(identityPub), created: true };
  }
}
