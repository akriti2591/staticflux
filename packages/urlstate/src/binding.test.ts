import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  checkUrlDeclarations,
  createUrlDeclarationRegistry,
  defineIntent,
  defineUrlBinding,
  type IntentParamsOf,
  reserveParams,
  type UrlBinding,
  type UrlParamKey,
} from './binding.js';
import { codec, codecEquals } from './codec.js';
import { MarketingParams } from './marketing.js';

// Test-wide registry (declaration merging, as packages do in their contracts file).
declare module '@staticflux/core' {
  interface Registry {
    urlParams: {
      tab: 'comments' | 'history';
      page: number;
      workspace: string;
      lang: string;
      'sf-debug': true;
      panel: 'chat';
      prompt: string;
      selection: string;
      tags: readonly string[];
      'open-panel': 'inspector';
    };
    dialogs: { share: true; upgrade: true };
  }
}

export const TabParam = defineUrlBinding({ key: 'tab', kind: 'view', codec: codec.enum(['comments', 'history']), owner: 'studio/doc-store' });

describe('codecs', () => {
  it('string', () => {
    const c = codec.string({ maxLength: 3 });
    expect(c.parse('abc')).toEqual({ ok: true, value: 'abc' });
    expect(c.parse('abcd').ok).toBe(false);
    expect(c.parse('').ok).toBe(false);
    expect(codec.string({ allowEmpty: true }).parse('')).toEqual({ ok: true, value: '' });
    expect(c.serialize('x')).toBe('x');
  });

  it('enum, int, number, boolean, flag, list, custom', () => {
    const e = codec.enum(['a', 'b']);
    expect(e.parse('a').ok).toBe(true);
    const bad = e.parse('c');
    expect(!bad.ok && bad.error.code).toBe('SF-URL-003');
    const i = codec.int({ min: 1, max: 10 });
    expect(i.parse('5')).toEqual({ ok: true, value: 5 });
    for (const raw of ['0', '11', '1.5', 'x', '99999999999999999999']) expect(i.parse(raw).ok, raw).toBe(false);
    expect(i.serialize(3.7)).toBe('3');
    const n = codec.number();
    expect(n.parse('1.5')).toEqual({ ok: true, value: 1.5 });
    expect(n.parse('').ok).toBe(false);
    expect(n.parse('NaN').ok).toBe(false);
    expect(n.serialize(2)).toBe('2');
    const b = codec.boolean();
    expect(['', '1', 'true', '0', 'false'].map((r) => b.parse(r).ok && b.parse(r))).toEqual([
      { ok: true, value: true },
      { ok: true, value: true },
      { ok: true, value: true },
      { ok: true, value: false },
      { ok: true, value: false },
    ]);
    expect(b.parse('maybe').ok).toBe(false);
    expect(b.serialize(true)).toBe('1');
    expect(b.serialize(false)).toBe('0');
    expect(codec.flag().parse('anything')).toEqual({ ok: true, value: true });
    expect(codec.flag().serialize(true)).toBe('');
    const l = codec.list(codec.int());
    expect(l.parse('1,2,3')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(l.parse('')).toEqual({ ok: true, value: [] });
    expect(l.parse('1,x').ok).toBe(false);
    expect(l.serialize([1, 2])).toBe('1,2');
    expect(codecEquals(l, [1, 2], [1, 2])).toBe(true);
    expect(codecEquals(l, [1, 2], [1])).toBe(false);
    expect(codecEquals(codec.string(), 'a', 'a')).toBe(true);
    const custom = codec.custom({ parse: (raw) => ({ ok: true, value: raw.length }), serialize: (v: number) => 'x'.repeat(v) });
    expect(custom.parse('abc')).toEqual({ ok: true, value: 3 });
  });
});

describe('declarations', () => {
  it('defines typed bindings with kind-based history defaults', () => {
    expect(TabParam).toMatchObject({ kind: 'url-binding', key: 'tab', urlKind: 'view', history: 'push', default: undefined });
    expectTypeOf(TabParam).toEqualTypeOf<UrlBinding<'tab', 'comments' | 'history'>>();
    const ws = defineUrlBinding({ key: 'workspace', kind: 'sticky', codec: codec.string(), owner: 'shell/workspace', description: 'Active workspace' });
    expect(ws.history).toBe('replace');
    expectTypeOf<'tab'>().toMatchTypeOf<UrlParamKey>();
    // @ts-expect-error unregistered key
    defineUrlBinding({ key: 'nope', kind: 'view', codec: codec.string(), owner: 'x' });
    // @ts-expect-error codec type must match the registered value type
    defineUrlBinding({ key: 'page', kind: 'view', codec: codec.string(), owner: 'x' });
  });

  it('defines intents (prefill-only by default) with typed params', () => {
    const chat = defineIntent({
      id: 'agent-chat/prompt',
      owner: 'agent-chat',
      params: { panel: codec.enum(['chat']), prompt: codec.string() },
      required: ['panel'],
    });
    expect(chat).toMatchObject({ kind: 'intent', policy: 'prefill-only', required: ['panel'] });
    expectTypeOf<IntentParamsOf<typeof chat>>().toEqualTypeOf<{ readonly panel: 'chat' } & { readonly prompt?: string }>();
    const safe = defineIntent({ id: 'studio/open-inspector', owner: 'studio', params: { 'open-panel': codec.enum(['inspector']) }, safe: true });
    expect(safe.policy).toBe('safe');
    expect(safe.required).toEqual(['open-panel']);
  });

  it('detects key collisions statically and at runtime (SF-URL-002)', () => {
    const tabAgain = defineUrlBinding({ key: 'tab', kind: 'view', codec: codec.enum(['comments']), owner: 'billing/store' });
    const chat = defineIntent({ id: 'agent-chat/prompt', owner: 'agent-chat', params: { panel: codec.enum(['chat']), prompt: codec.string() } });
    const chat2 = defineIntent({ id: 'agent-chat/open', owner: 'agent-chat', params: { panel: codec.enum(['chat']) } });
    const stealsPrompt = defineIntent({ id: 'studio/prompt', owner: 'studio', params: { prompt: codec.string() } });
    const utmClash = reserveParams('analytics', ['utm_source']);

    const collisions = checkUrlDeclarations([TabParam, tabAgain, chat, chat2, stealsPrompt, MarketingParams, utmClash, TabParam]);
    expect(collisions.map((c) => c.key).sort()).toEqual(['prompt', 'tab', 'utm_source']);
    expect(collisions.find((c) => c.key === 'tab')?.owners).toEqual(['studio/doc-store', 'billing/store']);
    expect(checkUrlDeclarations([TabParam, chat, chat2, MarketingParams])).toEqual([]);

    const registry = createUrlDeclarationRegistry([TabParam, chat]);
    expect(registry.initialErrors).toEqual([]);
    expect(registry.register(TabParam).ok).toBe(true); // same declaration: idempotent
    expect(registry.register(chat2).ok).toBe(true); // same owner, shared intent param
    const r = registry.register(tabAgain);
    expect(!r.ok && r.error.code).toBe('SF-URL-002');
    expect(!r.ok && r.error.details).toMatchObject({ key: 'tab', owners: ['studio/doc-store', 'billing/store'] });
    expect(registry.lookup('panel')).toHaveLength(2);
    expect(registry.lookup('zzz')).toEqual([]);
    expect(registry.declarations).toHaveLength(3);
    const bad = createUrlDeclarationRegistry([TabParam, tabAgain]);
    expect(bad.initialErrors[0]?.code).toBe('SF-URL-002');
  });
});
