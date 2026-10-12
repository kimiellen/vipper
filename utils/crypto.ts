/**
 * 纯加解密层（WebCrypto，无第三方依赖）。
 * PBKDF2-SHA256 派生 AES-GCM 256 密钥；密文为自描述信封：
 *   {"$enc":"v1","iv":<base64>,"data":<base64>}
 */

const te = new TextEncoder();
const td = new TextDecoder();

export function bytesToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** 由主密码派生 AES-GCM 密钥（可导出，供 session 暂存） */
export async function deriveKey(
  password: string,
  saltB64: string,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export function randomSaltB64(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function encryptString(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plain));
  return JSON.stringify({ $enc: 'v1', iv: bytesToB64(iv), data: bytesToB64(data) });
}

/** 解密失败（密码错误/数据损坏）会抛异常 */
export async function decryptString(key: CryptoKey, envelope: string): Promise<string> {
  const { iv, data } = JSON.parse(envelope);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(iv) },
    key,
    b64ToBytes(data),
  );
  return td.decode(plain);
}

/** 判断一个字符串是否为加密信封 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('{"$enc"');
}

export async function exportKeyB64(key: CryptoKey): Promise<string> {
  return bytesToB64(await crypto.subtle.exportKey('raw', key));
}

export async function importKeyB64(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBytes(b64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
