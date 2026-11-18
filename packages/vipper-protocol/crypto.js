/**
 * socket 通道加密（socket-access.md §5.2）：纯 WebCrypto 自建，无第三方加密库。
 *
 *   X25519（ECDH）密钥协商 → HKDF-SHA256 派生会话密钥 → AES-GCM 256 加密消息体
 *
 * 同一份实现跑两端：扩展侧浏览器 WebCrypto（Chrome ≥133）、host/cli 侧
 * Node `crypto.webcrypto`（Node ≥22，Node 22+ 已全局暴露 webcrypto 语义）。
 *
 * 概念：
 * - 身份密钥对：cli 首次连接生成并持久化（私钥文件 0600），指纹 = SHA-256(公钥 raw)。
 * - 会话密钥对：每次配对握手双方各生一对临时 X25519，用完即弃（前向保密）。
 * - 会话密钥派生绑定双方会话公钥（排序后 SHA-256 作 HKDF salt），
 *   防 unknown key share，且同一身份每连接得到不同密钥。
 * - 信封：{ $enc:'v1', iv:<b64>, data:<b64> }；AAD 绑定帧头 { id, session }，
 *   防密文被搬到别的请求上下文重放。
 */

const X25519 = { name: 'X25519' };
const ENC_INFO = new TextEncoder().encode('vipper-socket-channel-v1');
const subtle = () => globalThis.crypto.subtle;

/** base64 编解码（浏览器/Node 双端；分块避免大数组 spread 爆栈） */
export function u8ToB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToU8(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/* ---------- 身份密钥对（长期，私钥只存客户端本地） ---------- */

/** 生成 X25519 身份密钥对（可导出 JWK 供持久化） */
export function generateIdentity() {
  return subtle().generateKey(X25519, true, ['deriveBits']);
}

/** 导出身份公钥：raw 32 字节 → base64（协议线上形态） */
export async function exportIdentityPub(publicKey) {
  return u8ToB64(new Uint8Array(await subtle().exportKey('raw', publicKey)));
}

/** 导入对端身份/会话公钥（raw base64） */
export function importX25519Pub(b64) {
  return subtle().importKey('raw', b64ToU8(b64), X25519, false, []);
}

/** 身份指纹 = SHA-256(公钥 raw) 的 hex（配对存储与白名单的 key，§5.1） */
export async function fingerprint(identityPubB64) {
  const digest = await subtle().digest('SHA-256', b64ToU8(identityPubB64));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 身份密钥对 → 可持久化 JWK（私钥文件内容；调用方负责 0600 落盘） */
export async function identityToJwk(pair) {
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey);
  const publicJwk = await subtle().exportKey('jwk', pair.publicKey);
  return { privateJwk, publicJwk };
}

/** 从持久化 JWK 恢复身份密钥对 */
export async function identityFromJwk({ privateJwk, publicJwk }) {
  const privateKey = await subtle().importKey('jwk', privateJwk, X25519, false, ['deriveBits']);
  const publicKey = await subtle().importKey('jwk', publicJwk, X25519, true, []);
  return { privateKey, publicKey };
}

/* ---------- 会话密钥（每连接一换） ---------- */

/** 生成临时 X25519 会话密钥对（握手用，用完即弃） */
export function generateSessionKeypair() {
  return subtle().generateKey(X25519, false, ['deriveBits']);
}

/**
 * X25519 协商 + HKDF-SHA256 派生 AES-GCM 256 会话密钥。
 * salt = SHA-256(排序拼接的双方会话公钥)：绑定本次握手两端，同身份不同连接密钥不同。
 * @param {CryptoKey} privateKey 己方会话私钥
 * @param {string} peerSessionPubB64 对端会话公钥（raw base64）
 * @param {string} selfSessionPubB64 己方会话公钥（raw base64）
 */
export async function deriveSessionKey(privateKey, peerSessionPubB64, selfSessionPubB64) {
  const peerPub = await importX25519Pub(peerSessionPubB64);
  const shared = await subtle().deriveBits({ name: 'X25519', public: peerPub }, privateKey, 256);
  const pairMaterial = [peerSessionPubB64, selfSessionPubB64].sort().join('.');
  const salt = await subtle().digest('SHA-256', new TextEncoder().encode(pairMaterial));
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: ENC_INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ---------- 信封 ---------- */

/**
 * 加密一条业务消息为信封（§4.3：{"$enc":"v1",iv,data}）。
 * @param {CryptoKey} key 会话密钥
 * @param {object} plaintext 业务消息（JSON 可序列化）
 * @param {{ id: string|number, session: string }} aad 帧头绑定（防跨请求重放）
 */
export async function seal(key, plaintext, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(JSON.stringify(aad)) },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext)),
  );
  return { $enc: 'v1', iv: u8ToB64(iv), data: u8ToB64(new Uint8Array(data)) };
}

/**
 * 解密信封。任何校验失败（篡改/错钥/AAD 不符）统一抛错——
 * 调用方对外只回统一错误码，不区分失败原因（§11：不泄露状态）。
 */
export async function open(key, envelope, aad) {
  if (!envelope || envelope.$enc !== 'v1' || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('信封格式非法');
  }
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64ToU8(envelope.iv), additionalData: new TextEncoder().encode(JSON.stringify(aad)) },
    key,
    b64ToU8(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
