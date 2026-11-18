/**
 * crypto.js 的类型声明（扩展侧 TS import 用；实现是纯 WebCrypto JS，Node/浏览器双端）。
 */

export function u8ToB64(u8: Uint8Array): string;
export function b64ToU8(b64: string): Uint8Array;

export function generateIdentity(): Promise<CryptoKeyPair>;
export function exportIdentityPub(publicKey: CryptoKey): Promise<string>;
export function importX25519Pub(b64: string): Promise<CryptoKey>;
export function fingerprint(identityPubB64: string): Promise<string>;
export function identityToJwk(pair: CryptoKeyPair): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }>;
export function identityFromJwk(jwks: { privateJwk: JsonWebKey; publicJwk: JsonWebKey }): Promise<CryptoKeyPair>;

export function generateSessionKeypair(): Promise<CryptoKeyPair>;
export function deriveSessionKey(
  privateKey: CryptoKey,
  peerSessionPubB64: string,
  selfSessionPubB64: string,
): Promise<CryptoKey>;

export interface Envelope {
  $enc: 'v1';
  iv: string;
  data: string;
}

export function seal(
  key: CryptoKey,
  plaintext: unknown,
  aad: { id: string | number; session: string },
): Promise<Envelope>;
export function open(
  key: CryptoKey,
  envelope: unknown,
  aad: { id: string | number; session: string },
): Promise<unknown>;
