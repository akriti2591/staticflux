import { err } from '@staticflux/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOG, catalogLoader, catalogOf, defineMessages, defineTranslations, type MessageRef, type ParamsOf } from './messages.js';

const m = defineMessages('studio', {
  saved: 'Saved',
  greeting: 'Hello {name}!',
  items: '{count, plural, =0 {No items} one {# item} other {# items}}',
  invite: '{host} invited {count, plural, one {{guest}} other {{guest} and # others}} on {when, date, short}',
  pronoun: '{g, select, female {She} other {They}} {total, number, percent}',
  tags: 'Tags: {tags, list}',
});

describe('defineMessages', () => {
  it('returns frozen typed refs with stable ids', () => {
    expect(m.saved).toMatchObject({ kind: 'message', namespace: 'studio', key: 'saved', id: 'studio/saved', source: 'Saved', sourceLocale: 'en' });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.saved)).toBe(true);
    expect(Object.keys(m)).toEqual(['saved', 'greeting', 'items', 'invite', 'pronoun', 'tags']);
  });

  it('carries a non-enumerable catalog descriptor', () => {
    const descriptor = catalogOf(m);
    expect(descriptor.namespace).toBe('studio');
    expect(descriptor.keys).toContain('items');
    expect(m[CATALOG]).toBe(descriptor);
    expect(defineMessages('x', {}, { sourceLocale: 'de' })[CATALOG].sourceLocale).toBe('de');
  });

  it('rejects invalid namespaces', () => {
    expect(() => defineMessages('Bad Name', {})).toThrow(/invalid namespace/);
  });

  it('infers placeholder types from ICU text', () => {
    expectTypeOf<ParamsOf<'Saved'>>().toEqualTypeOf<{}>();
    expectTypeOf(m.greeting).toEqualTypeOf<MessageRef<{ readonly name: string | number }, 'studio', 'greeting'>>();
    expectTypeOf<ParamsOf<'{count, plural, one {# item} other {# items}}'>>().toEqualTypeOf<{ readonly count: number }>();
    expectTypeOf<ParamsOf<'{host} invited {count, plural, one {{guest}} other {{guest} and # others}} on {when, date, short}'>>().toEqualTypeOf<{
      readonly host: string | number;
      readonly count: number;
      readonly guest: string | number;
      readonly when: number | Date;
    }>();
    expectTypeOf<ParamsOf<'{g, select, female {She} other {They}} {total, number, percent}'>>().toEqualTypeOf<{
      readonly g: string;
      readonly total: number;
    }>();
    expectTypeOf<ParamsOf<'Tags: {tags, list}'>>().toEqualTypeOf<{ readonly tags: readonly string[] }>();
    // branch bodies are text, not args
    expectTypeOf<ParamsOf<'{n, plural, one {item} other {items}}'>>().toEqualTypeOf<{ readonly n: number }>();
    // a plain arg reused as plural narrows to number
    expectTypeOf<ParamsOf<'{n} / {n, plural, other {#}}'>>().toEqualTypeOf<{ readonly n: number }>();
    expectTypeOf<ParamsOf<string>>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
  });
});

describe('defineTranslations', () => {
  it('builds a bundle with keys checked against the catalog', () => {
    const fr = defineTranslations(m, 'fr', { saved: 'Enregistré', greeting: 'Bonjour {name} !' });
    expect(fr).toMatchObject({ kind: 'translations', namespace: 'studio', locale: 'fr' });
    expect(fr.messages['saved']).toBe('Enregistré');
    // @ts-expect-error unknown key
    defineTranslations(m, 'fr', { nope: 'x' });
  });
});

describe('catalogLoader', () => {
  const fr = defineTranslations(m, 'fr', { saved: 'Enregistré' });
  const signal = new AbortController().signal;

  it('loads per-locale imports (module default or bundle) case-insensitively', async () => {
    const loader = catalogLoader(m, {
      fr: async () => ({ default: fr }),
      'pt-BR': async () => defineTranslations(m, 'pt-BR', { saved: 'Salvo' }),
    });
    expect(loader.namespace).toBe('studio');
    expect(loader.locales).toEqual(['fr', 'pt-BR']);
    const a = await loader.load('FR', signal);
    expect(a.ok && a.value?.messages['saved']).toBe('Enregistré');
    const b = await loader.load('pt-br', signal);
    expect(b.ok && b.value?.messages['saved']).toBe('Salvo');
    expect(await loader.load('de', signal)).toEqual({ ok: true, value: undefined });
  });

  it('maps import failures to SF-I18N-003', async () => {
    const loader = catalogLoader(m, {
      fr: async () => {
        throw new Error('chunk 404');
      },
    });
    const result = await loader.load('fr', signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-I18N-003');
    expect(err(1).ok).toBe(false);
  });
});
