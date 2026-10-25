/**
 * Small synchronous hashes for pipes: FNV-1a (checksums of seqlock cells, ids
 * stamped into pipe headers) and MurmurHash3 x86-128 (content digests for the
 * blob side channel). Non-cryptographic: pipes run between threads of one app,
 * so collisions are an accident to make unlikely, not an attack to resist.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 16777619;

/** FNV-1a over Int32 words (fast checksum for in-memory frames). */
export function fnv1aWords(words: Int32Array, start = 0, end = words.length): number {
  let h = FNV_OFFSET;
  for (let i = start; i < end; i++) h = Math.imul(h ^ (words[i] as number), FNV_PRIME);
  return h | 0;
}

/** FNV-1a over a string's UTF-16 code units (ids stamped into pipe headers). */
export function fnv1aString(text: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  return h | 0;
}

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

function fmix(input: number): number {
  let h = input;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** MurmurHash3 x86_128 of `bytes` as 32 lowercase hex characters. */
export function murmur3x86_128(bytes: Uint8Array, seed = 0): string {
  const c1 = 0x239b961b;
  const c2 = 0xab0e9789;
  const c3 = 0x38b34ae5;
  const c4 = 0xa1e38b93;
  let h1 = seed;
  let h2 = seed;
  let h3 = seed;
  let h4 = seed;
  const length = bytes.length;
  const blocks = length >>> 4;
  const word = (i: number): number =>
    (bytes[i] as number) | ((bytes[i + 1] as number) << 8) | ((bytes[i + 2] as number) << 16) | ((bytes[i + 3] as number) << 24);
  for (let b = 0; b < blocks; b++) {
    const i = b * 16;
    let k1 = word(i);
    let k2 = word(i + 4);
    let k3 = word(i + 8);
    let k4 = word(i + 12);
    k1 = Math.imul(rotl(Math.imul(k1, c1), 15), c2);
    h1 ^= k1;
    h1 = rotl(h1, 19) + h2;
    h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, c2), 16), c3);
    h2 ^= k2;
    h2 = rotl(h2, 17) + h3;
    h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, c3), 17), c4);
    h3 ^= k3;
    h3 = rotl(h3, 15) + h4;
    h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, c4), 18), c1);
    h4 ^= k4;
    h4 = rotl(h4, 13) + h1;
    h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
  }
  const tail = blocks * 16;
  // Tail: up to 15 bytes packed little-endian into four lanes; a lane is mixed when it has any byte.
  const rest = length & 15;
  const lanes = [0, 0, 0, 0];
  for (let i = 0; i < rest; i++) lanes[i >> 2] = (lanes[i >> 2] as number) ^ ((bytes[tail + i] as number) << ((i & 3) * 8));
  const [k1, k2, k3, k4] = lanes as [number, number, number, number];
  if (rest > 12) h4 ^= Math.imul(rotl(Math.imul(k4, c4), 18), c1);
  if (rest > 8) h3 ^= Math.imul(rotl(Math.imul(k3, c3), 17), c4);
  if (rest > 4) h2 ^= Math.imul(rotl(Math.imul(k2, c2), 16), c3);
  if (rest > 0) h1 ^= Math.imul(rotl(Math.imul(k1, c1), 15), c2);
  h1 ^= length;
  h2 ^= length;
  h3 ^= length;
  h4 ^= length;
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  h1 = fmix(h1);
  h2 = fmix(h2);
  h3 = fmix(h3);
  h4 = fmix(h4);
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}
