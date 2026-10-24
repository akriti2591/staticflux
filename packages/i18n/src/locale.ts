/**
 * Locale utilities: canonicalization, fallback chains, negotiation and text
 * direction. All feature-detected (`Intl.Locale`, `getTextInfo`) with
 * table-based fallbacks for older engines.
 */

export type TextDirection = 'ltr' | 'rtl';

/** Canonical BCP 47 tag (`EN-us` → `en-US`), or undefined when malformed. */
export function canonicalizeLocale(tag: string): string | undefined {
  const getCanonicalLocales = (Intl as { getCanonicalLocales?: (tags: string) => string[] }).getCanonicalLocales;
  if (typeof getCanonicalLocales === 'function') {
    try {
      return getCanonicalLocales(tag)[0];
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) ? tag : undefined;
}

/** Tag without Unicode/private extensions (`de-DE-u-co-phonebk` → `de-DE`). */
export function baseLocale(tag: string): string {
  const LocaleCtor = (Intl as { Locale?: typeof Intl.Locale }).Locale;
  if (typeof LocaleCtor === 'function') {
    try {
      return new LocaleCtor(tag).baseName;
    } catch {
      // fall through
    }
  }
  return tag.split(/-[ux]-/i)[0] ?? tag;
}

/** Primary language subtag (`pt-BR` → `pt`). */
export function languageOf(tag: string): string {
  return (baseLocale(tag).split('-')[0] ?? tag).toLowerCase();
}

/**
 * Fallback chain by subtag truncation, ending with `defaultLocale`:
 * `zh-Hant-TW` → `['zh-Hant-TW', 'zh-Hant', 'zh', 'en']`.
 */
export function localeFallbackChain(locale: string, defaultLocale: string): readonly string[] {
  const chain: string[] = [];
  const push = (tag: string): void => {
    if (!chain.some((existing) => existing.toLowerCase() === tag.toLowerCase())) chain.push(tag);
  };
  const parts = baseLocale(locale).split('-');
  for (let length = parts.length; length > 0; length -= 1) push(parts.slice(0, length).join('-'));
  push(defaultLocale);
  return chain;
}

/**
 * Pick the best available locale for the user's requested list (e.g.
 * `navigator.languages`). Order: exact match → truncated match → same language
 * in another region → `defaultLocale`.
 */
export function negotiateLocale(
  requested: readonly string[],
  available: readonly string[],
  defaultLocale: string,
): string {
  const byLower = new Map(available.map((tag) => [tag.toLowerCase(), tag]));
  for (const raw of requested) {
    const tag = canonicalizeLocale(raw);
    if (tag === undefined) continue;
    const parts = baseLocale(tag).split('-');
    for (let length = parts.length; length > 0; length -= 1) {
      const match = byLower.get(parts.slice(0, length).join('-').toLowerCase());
      if (match !== undefined) return match;
    }
    const language = languageOf(tag);
    const sibling = available.find((candidate) => languageOf(candidate) === language);
    if (sibling !== undefined) return sibling;
  }
  return defaultLocale;
}

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr', 'Yezi']);
const RTL_LANGUAGES = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'syr', 'ku-arab']);

interface LocaleWithTextInfo {
  getTextInfo?: () => { direction?: string };
  textInfo?: { direction?: string };
  maximize?: () => { script?: string | undefined };
  script?: string | undefined;
}

/** Writing direction of a locale (`ar` → `rtl`). */
export function textDirection(locale: string): TextDirection {
  const LocaleCtor = (Intl as { Locale?: typeof Intl.Locale }).Locale;
  if (typeof LocaleCtor === 'function') {
    try {
      const value = new LocaleCtor(locale) as unknown as LocaleWithTextInfo;
      const info = typeof value.getTextInfo === 'function' ? value.getTextInfo() : value.textInfo;
      if (info?.direction === 'rtl' || info?.direction === 'ltr') return info.direction;
      const script = value.script ?? (typeof value.maximize === 'function' ? value.maximize().script : undefined);
      if (script !== undefined) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
    } catch {
      // fall through to the table
    }
  }
  const lower = locale.toLowerCase();
  const scriptMatch = /-([a-z]{4})(?:-|$)/i.exec(locale)?.[1];
  if (scriptMatch !== undefined) {
    const script = scriptMatch.charAt(0).toUpperCase() + scriptMatch.slice(1).toLowerCase();
    return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  }
  return RTL_LANGUAGES.has(languageOf(lower)) ? 'rtl' : 'ltr';
}
