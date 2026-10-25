/**
 * License classifier for `sf licenses` (IF-2.11). Pure: takes a license string as
 * npm (`package.json#license`), cargo (`Cargo.toml#license`) or the model-weights
 * registry write it, and returns `allowed`, `denied` or `unknown`.
 *
 * - SPDX expressions are evaluated: `OR` is allowed when any branch is allowed,
 *   `AND` is denied when any part is denied. `WITH <exception>` keeps the base
 *   license's verdict (GPL with the Classpath exception is still GPL).
 *   Cargo's legacy `MIT/Apache-2.0` means `MIT OR Apache-2.0`.
 * - Denied: the GPL family (GPL, LGPL, AGPL), SSPL, non-commercial terms (any
 *   `-NC` Creative Commons variant, "non-commercial" text, PolyForm Noncommercial,
 *   BRIA RMBG), source-available "no competing use" terms (BUSL, Elastic,
 *   Commons Clause), watermark terms, and `UNLICENSED` (no grant at all).
 * - Unknown: anything else that is not on the allowlist (missing, `SEE LICENSE IN`,
 *   custom identifiers). Unknown fails the check too until an exception with a
 *   reason is recorded in the license policy.
 */

export type LicenseVerdict = 'allowed' | 'denied' | 'unknown';

export interface LicenseClassification {
  readonly verdict: LicenseVerdict;
  /** Human-readable reason, e.g. `GPL-3.0-only: GPL family (copyleft)`. */
  readonly reason: string;
}

/** Permissive or weak-file-copyleft licenses that are fine for a closed commercial app (MPL-2.0 unmodified, IF-2.11). */
export const ALLOWED_LICENSES: readonly string[] = [
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-1-Clause',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'W3C',
  'WTFPL',
  'Zlib',
];

interface DenyRule {
  readonly test: RegExp;
  readonly reason: string;
}

/** Matched against a single license identifier (after `+`, `-only`, `-or-later` are kept as-is). */
const DENIED_IDS: readonly DenyRule[] = [
  { test: /^(A|L)?GPL/i, reason: 'GPL family (copyleft)' },
  { test: /^SSPL/i, reason: 'SSPL (service copyleft)' },
  { test: /^CC-BY(-SA)?-NC/i, reason: 'non-commercial (Creative Commons NC)' },
  { test: /^PolyForm-Noncommercial/i, reason: 'non-commercial (PolyForm)' },
  { test: /^bria-rmbg/i, reason: 'non-commercial (BRIA RMBG model license)' },
  { test: /^(BUSL|BSL-1\.1)/i, reason: 'source-available, no production use (Business Source License)' },
  { test: /^Elastic/i, reason: 'source-available (Elastic License)' },
  { test: /^Commons-Clause/i, reason: 'source-available (Commons Clause)' },
  { test: /^UNLICENSED$/i, reason: 'no license granted (UNLICENSED)' },
];

/** Matched against the whole license string, so free text and custom ids are caught too. */
const DENIED_TEXT: readonly DenyRule[] = [
  { test: /non[-\s_]?commercial/i, reason: 'non-commercial terms' },
  { test: /watermark/i, reason: 'watermark obligation' },
];

const ALLOWED = new Map(ALLOWED_LICENSES.map((id) => [id.toLowerCase(), id]));

type Token = { readonly kind: 'open' | 'close' | 'and' | 'or' | 'with' } | { readonly kind: 'id'; readonly value: string };

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = [];
  const parts = expression.replace(/([()])/g, ' $1 ').trim().split(/\s+/);
  for (const part of parts) {
    if (part.length === 0) continue;
    const upper = part.toUpperCase();
    if (part === '(') tokens.push({ kind: 'open' });
    else if (part === ')') tokens.push({ kind: 'close' });
    else if (upper === 'AND') tokens.push({ kind: 'and' });
    else if (upper === 'OR') tokens.push({ kind: 'or' });
    else if (upper === 'WITH') tokens.push({ kind: 'with' });
    else if (/^[A-Za-z0-9][A-Za-z0-9.+:_-]*$/.test(part)) tokens.push({ kind: 'id', value: part });
    else return undefined;
  }
  return tokens;
}

type Node =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'and' | 'or'; readonly parts: readonly Node[] };

/** Recursive-descent parser: or := and (OR and)*; and := atom (AND atom)*; atom := ( or ) | id [WITH id]. */
function parse(tokens: readonly Token[]): Node | undefined {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const atom = (): Node | undefined => {
    const token = peek();
    if (token === undefined) return undefined;
    if (token.kind === 'open') {
      pos += 1;
      const inner = or();
      if (inner === undefined || peek()?.kind !== 'close') return undefined;
      pos += 1;
      return inner;
    }
    if (token.kind !== 'id') return undefined;
    pos += 1;
    if (peek()?.kind === 'with') {
      pos += 1;
      if (peek()?.kind !== 'id') return undefined;
      pos += 1; // The exception never changes the base license's verdict.
    }
    return { kind: 'id', id: token.value };
  };
  const chain = (kind: 'and' | 'or', next: () => Node | undefined): Node | undefined => {
    const first = next();
    if (first === undefined) return undefined;
    const parts = [first];
    while (peek()?.kind === kind) {
      pos += 1;
      const part = next();
      if (part === undefined) return undefined;
      parts.push(part);
    }
    return parts.length === 1 ? first : { kind, parts };
  };
  const and = (): Node | undefined => chain('and', atom);
  const or = (): Node | undefined => chain('or', and);
  const root = or();
  return root !== undefined && pos === tokens.length ? root : undefined;
}

/** Classify one SPDX identifier (no operators). */
export function classifyLicenseId(id: string): LicenseClassification {
  for (const rule of DENIED_IDS) if (rule.test.test(id)) return { verdict: 'denied', reason: `${id}: ${rule.reason}` };
  for (const rule of DENIED_TEXT) if (rule.test.test(id)) return { verdict: 'denied', reason: `${id}: ${rule.reason}` };
  const allowed = ALLOWED.get(id.toLowerCase());
  if (allowed !== undefined) return { verdict: 'allowed', reason: allowed };
  return { verdict: 'unknown', reason: `${id}: not on the allowlist` };
}

function evaluate(node: Node): LicenseClassification {
  if (node.kind === 'id') return classifyLicenseId(node.id);
  const results = node.parts.map(evaluate);
  const pick = (verdict: LicenseVerdict): LicenseClassification | undefined => results.find((r) => r.verdict === verdict);
  const order: readonly LicenseVerdict[] = node.kind === 'or' ? ['allowed', 'unknown', 'denied'] : ['denied', 'unknown', 'allowed'];
  for (const verdict of order) {
    const hit = pick(verdict);
    if (hit !== undefined) {
      if (verdict === 'allowed' && node.kind === 'and') return { verdict, reason: results.map((r) => r.reason).join(' AND ') };
      return hit;
    }
  }
  return { verdict: 'unknown', reason: 'empty expression' };
}

/**
 * Classify a license string. `undefined`/empty is unknown. Free text
 * ("non-commercial", "watermark") is denied even when it is not valid SPDX.
 */
export function classifyLicense(license: string | undefined | null): LicenseClassification {
  const text = (license ?? '').trim();
  if (text.length === 0 || /^(UNKNOWN|NONE|NOASSERTION)$/i.test(text)) return { verdict: 'unknown', reason: 'no license declared' };
  for (const rule of DENIED_TEXT) if (rule.test.test(text)) return { verdict: 'denied', reason: `"${text}": ${rule.reason}` };
  if (/^SEE LICENSE IN\b/i.test(text)) return { verdict: 'unknown', reason: `"${text}": custom license file; review it` };
  // Cargo's legacy separator: `MIT/Apache-2.0` = `MIT OR Apache-2.0`.
  const normalized = text.replace(/\s*\/\s*/g, ' OR ');
  const tokens = tokenize(normalized);
  const tree = tokens === undefined ? undefined : parse(tokens);
  if (tree === undefined) return { verdict: 'unknown', reason: `"${text}": not a valid SPDX expression` };
  return evaluate(tree);
}
