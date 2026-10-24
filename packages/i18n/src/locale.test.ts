import { describe, expect, it } from 'vitest';
import { baseLocale, canonicalizeLocale, languageOf, localeFallbackChain, negotiateLocale, textDirection } from './locale.js';

describe('locale utilities', () => {
  it('canonicalizes tags and rejects malformed ones', () => {
    expect(canonicalizeLocale('EN-us')).toBe('en-US');
    expect(canonicalizeLocale('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalizeLocale('not a locale!')).toBeUndefined();
  });

  it('strips extensions and extracts the language', () => {
    expect(baseLocale('de-DE-u-co-phonebk')).toBe('de-DE');
    expect(languageOf('pt-BR')).toBe('pt');
  });

  it('builds fallback chains ending with the default', () => {
    expect(localeFallbackChain('zh-Hant-TW', 'en')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh', 'en']);
    expect(localeFallbackChain('en-GB', 'en')).toEqual(['en-GB', 'en']);
    expect(localeFallbackChain('en', 'en')).toEqual(['en']);
  });

  it('negotiates exact, truncated, sibling-region and default matches', () => {
    const available = ['en', 'fr', 'pt-BR', 'zh-Hant'];
    expect(negotiateLocale(['fr-CA'], available, 'en')).toBe('fr');
    expect(negotiateLocale(['pt-PT'], available, 'en')).toBe('pt-BR');
    expect(negotiateLocale(['zh-Hant-HK'], available, 'en')).toBe('zh-Hant');
    expect(negotiateLocale(['ja', 'fr'], available, 'en')).toBe('fr');
    expect(negotiateLocale(['ja'], available, 'en')).toBe('en');
    expect(negotiateLocale(['!!', 'PT-br'], available, 'en')).toBe('pt-BR');
    expect(negotiateLocale([], available, 'en')).toBe('en');
  });

  it('detects text direction', () => {
    expect(textDirection('ar')).toBe('rtl');
    expect(textDirection('he-IL')).toBe('rtl');
    expect(textDirection('fa')).toBe('rtl');
    expect(textDirection('en')).toBe('ltr');
    expect(textDirection('az-Arab')).toBe('rtl');
    expect(textDirection('sr-Latn')).toBe('ltr');
  });
});
