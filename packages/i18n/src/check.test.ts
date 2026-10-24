import { describe, expect, it } from 'vitest';
import { checkCatalogs } from './check.js';
import { defineMessages, defineTranslations, type TranslationBundle } from './messages.js';

const m = defineMessages('studio', {
  saved: 'Saved',
  items: '{count, plural, one {# item} other {# items}}',
  greet: 'Hi {name}',
  when: 'On {d, date}',
});

describe('checkCatalogs', () => {
  it('passes for complete, matching translations', () => {
    const report = checkCatalogs({
      catalogs: [m],
      translations: [
        defineTranslations(m, 'fr', {
          saved: 'Enregistré',
          items: '{count, plural, one {# élément} other {# éléments}}',
          greet: 'Salut {name}',
          when: 'Le {d, date, long}',
        }),
      ],
    });
    expect(report).toEqual({ ok: true, issues: [], errors: 0, warnings: 0 });
  });

  it('reports missing keys, placeholder mismatches, syntax errors and unknown keys', () => {
    const bad: TranslationBundle = {
      kind: 'translations',
      namespace: 'studio',
      locale: 'de',
      messages: {
        items: '{n, plural, one {# Element} other {# Elemente}}',
        greet: 'Hallo {name',
        when: 'Am {d, number}',
        extra: 'stale',
      },
    };
    const report = checkCatalogs({ catalogs: [m], translations: [bad] });
    expect(report.ok).toBe(false);
    const byKey = Object.fromEntries(report.issues.map((i) => [`${i.code}:${i.key ?? ''}`, i]));
    expect(byKey['missing-key:saved']?.locale).toBe('de');
    expect(byKey['placeholder-mismatch:items']?.message).toMatch(/expected count:plural, got n:plural/);
    expect(byKey['syntax-error:greet']?.severity).toBe('error');
    expect(byKey['placeholder-mismatch:when']).toBeDefined();
    expect(byKey['unknown-key:extra']?.severity).toBe('warning');
    expect(report.errors).toBe(4);
    expect(report.warnings).toBe(1);
  });

  it('requires listed locales even without bundles; skips the source locale', () => {
    const report = checkCatalogs({ catalogs: [m], translations: [], locales: ['en', 'es'] });
    expect(report.issues.filter((i) => i.code === 'missing-key')).toHaveLength(4);
    expect(report.issues.every((i) => i.locale === 'es')).toBe(true);
  });

  it('merges split bundles and treats plain args as compatible', () => {
    const report = checkCatalogs({
      catalogs: [m],
      translations: [
        defineTranslations(m, 'it', { saved: 'Salvato', items: '{count} elementi' }),
        defineTranslations(m, 'it', { greet: 'Ciao {name, select, other {amico}}', when: 'Il {d}' }),
      ],
    });
    expect(report.ok).toBe(true);
  });

  it('reports unused source keys when usage is given, source syntax errors, unknown namespaces', () => {
    const broken = defineMessages('broken', { oops: '{x, plural, one {a}}' });
    const report = checkCatalogs({
      catalogs: [m, broken],
      translations: [{ kind: 'translations', namespace: 'ghost', locale: 'fr', messages: {} }],
      locales: [],
      usedIds: ['studio/saved', 'studio/items', 'studio/greet'],
    });
    const codes = report.issues.map((i) => `${i.code}:${i.namespace}/${i.key ?? ''}`);
    expect(codes).toContain('unused-key:studio/when');
    expect(codes).toContain('syntax-error:broken/oops');
    expect(codes).toContain('unknown-namespace:ghost/');
    expect(codes).not.toContain('unused-key:studio/saved');
  });
});
