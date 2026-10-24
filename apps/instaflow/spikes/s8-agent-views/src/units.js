// Units and small helpers. Ticks are canonical (705,600,000 per second, DOCUMENT-FORMAT §2); views never show them.
import { createHash } from 'node:crypto';

export const TICKS_PER_SECOND = 705_600_000;

/** seconds → ticks, nearest tick (exact for any value the view can print with 3 decimals). */
export function secToTicks(s) { return Math.round(s * TICKS_PER_SECOND); }
/** ticks → seconds for the view: 3 decimals, trailing zeros dropped by Number(). */
export function ticksToSec(t) { return Math.round((t / TICKS_PER_SECOND) * 1000) / 1000 || 0; }
/** page px for the view: integers. */
export function roundPx(v) { return Math.round(v) || 0; }

export function sha256(text) { return 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0, 16); }

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** tiny deterministic PRNG (mulberry32) so seeds and fuzzers are reproducible. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; }
export function pct(xs, p) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; }

/** Error values (CLAUDE.md rule 6): stable code + fix. Codes follow DOCUMENT-FORMAT §7.4. */
export function sfError(code, message, fix, extra = {}) { return { code, message, fix, ...extra }; }
