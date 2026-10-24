/**
 * `encrypted(keyProvider)`: AES-GCM encryption at rest via WebCrypto. Values
 * are serialized (JSON by default), encrypted with a fresh 96-bit IV, and the
 * store key is bound as additional authenticated data, so a ciphertext copied
 * to another key fails to decrypt (`SF-STORE-003`). Records carry the key id
 * (`kid`) for rotation: the provider's `get(kid)` decrypts old records, new
 * writes use `current()`.
 *
 * Encryption at rest protects against casual disk/devtools inspection, NOT
 * against script running in the page (it can call the key provider too).
 * Change events never carry plaintext values.
 */
import { err, ok, type Result } from '@staticflux/core';
import { base64ToBytes, bytesToBase64, type Codec, jsonCodec, mapValues } from './codec.js';
import { StoreCorruptError, StoreUnavailableError, toStoreError } from './errors.js';
import type { AsyncStore } from './types.js';

export interface EncryptedRecord {
  readonly alg: 'A256GCM';
  readonly kid: string;
  /** base64 IV (12 bytes). */
  readonly iv: string;
  /** base64 ciphertext + tag. */
  readonly ct: string;
}

export interface StoreKey {
  readonly id: string;
  readonly key: CryptoKey;
}

export interface KeyProvider {
  /** Key used for new writes. */
  current(signal?: AbortSignal): Promise<Result<StoreKey>>;
  /** Key by id for reading records written with an older key (default: only `current`). */
  get?(id: string, signal?: AbortSignal): Promise<Result<StoreKey | undefined>>;
}

/** The subset of `SubtleCrypto` used here (injectable). */
export interface SubtleLike {
  encrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData?: Uint8Array }, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData?: Uint8Array }, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
}

export interface EncryptedOptions<V> {
  readonly subtle?: SubtleLike;
  /** Random bytes for IVs (default `crypto.getRandomValues`). */
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Plaintext serialization (default JSON). */
  readonly codec?: Codec<V, string>;
}

export function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return r['alg'] === 'A256GCM' && typeof r['kid'] === 'string' && typeof r['iv'] === 'string' && typeof r['ct'] === 'string';
}

/** A provider for one fixed key. */
export function staticKeyProvider(key: CryptoKey, id = 'k1'): KeyProvider {
  const entry: StoreKey = { id, key };
  return {
    current: async () => ok(entry),
    get: async (wanted) => ok(wanted === id ? entry : undefined),
  };
}

type GenerateKeySubtle = { generateKey(algorithm: { name: 'AES-GCM'; length: 256 }, extractable: boolean, usages: readonly ('encrypt' | 'decrypt')[]): Promise<CryptoKey> };

/** Generate a non-extractable AES-GCM-256 key (store it in IndexedDB — CryptoKeys are structured-clonable). */
export async function generateStoreKey(subtle?: GenerateKeySubtle): Promise<Result<CryptoKey>> {
  const api = subtle ?? (globalThis.crypto?.subtle as unknown as GenerateKeySubtle | undefined);
  if (api === undefined) return err(StoreUnavailableError({ message: 'WebCrypto is not available (insecure context?).', details: { backend: 'webcrypto' } }));
  try {
    return ok(await api.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  } catch (error) {
    return err(toStoreError(error, 'webcrypto', 'generateKey'));
  }
}

export function encrypted<V>(keyProvider: KeyProvider, options: EncryptedOptions<V> = {}): (inner: AsyncStore<EncryptedRecord>) => AsyncStore<V> {
  return (inner) => {
    const subtle = options.subtle ?? (globalThis.crypto?.subtle as unknown as SubtleLike | undefined);
    const randomBytes = options.randomBytes ?? ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
    const codec = options.codec ?? jsonCodec<V>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const unavailable = (): Result<never> =>
      err(StoreUnavailableError({ message: 'WebCrypto (crypto.subtle) is not available; it requires a secure context.', details: { backend: 'webcrypto' } }));
    const keyFor = async (kid: string, signal: AbortSignal | undefined): Promise<Result<StoreKey | undefined>> => {
      const current = await keyProvider.current(signal);
      if (current.ok && current.value.id === kid) return current;
      if (keyProvider.get === undefined) return current.ok ? ok(undefined) : current;
      return keyProvider.get(kid, signal);
    };
    return mapValues<EncryptedRecord, V>(inner, {
      name: 'encrypted',
      decodeChanges: false,
      async encode(value, key, signal) {
        if (subtle === undefined) return unavailable();
        const plain = codec.encode(value, key);
        if (!plain.ok) return plain;
        const current = await keyProvider.current(signal);
        if (!current.ok) return current;
        try {
          const iv = randomBytes(12);
          const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(key) }, current.value.key, encoder.encode(plain.value));
          return ok({ alg: 'A256GCM', kid: current.value.id, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) });
        } catch (error) {
          return err(toStoreError(error, 'webcrypto', 'encrypt'));
        }
      },
      async decode(raw, key, signal) {
        if (subtle === undefined) return unavailable();
        if (!isEncryptedRecord(raw)) return err(StoreCorruptError({ message: `Entry "${key}" is not an encrypted record.`, details: { key } }));
        const found = await keyFor(raw.kid, signal);
        if (!found.ok) return found;
        if (found.value === undefined) {
          return err(StoreCorruptError({ message: `No key "${raw.kid}" to decrypt "${key}".`, details: { key, kid: raw.kid } }));
        }
        let plain: ArrayBuffer;
        try {
          plain = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(raw.iv), additionalData: encoder.encode(key) }, found.value.key, base64ToBytes(raw.ct));
        } catch (error) {
          return err(StoreCorruptError({ cause: error, message: `Entry "${key}" failed to decrypt (wrong key or tampered).`, details: { key, kid: raw.kid } }));
        }
        return codec.decode(decoder.decode(plain), key);
      },
    });
  };
}
