import { createInjector, createScope, ok } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTheme, defaultThemeContribution } from './default-theme.js';
import {
  APPEARANCE_ATTRS,
  APPEARANCE_PREFERENCE_KEY,
  AppearanceStoreToken,
  AppearanceToken,
  appearanceUnit,
  appearanceUnitWith,
  type AppearanceStore,
  browserMediaQueries,
  compileTheme,
  compositeOver,
  contrastRatio,
  createAppearance,
  defineTheme,
  defineTokens,
  extendTheme,
  formatHex,
  kebabCase,
  legacyAliases,
  type MediaQueryPort,
  normalizeHex,
  parseColor,
  relativeLuminance,
  resolveAppearance,
  resolveThemeValues,
  sanitizeAppearance,
  TEXT_CONTRAST_PAIRS,
  themeContribution,
  themeTokens,
  themeValue,
  tokenProperty,
  tokenSetOf,
  UI_CONTRAST_PAIRS,
  validateTheme,
  valueOf,
} from './theme.js';

afterEach(() => {
  document.head.querySelectorAll('style[data-sf-theme-style]').forEach((s) => s.remove());
});

function fakeMedia(initial: Record<string, boolean> = {}): MediaQueryPort & { set(query: string, value: boolean): void } {
  const state = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  return {
    matches: (q) => state.get(q) === true,
    subscribe(q, fn) {
      const set = listeners.get(q) ?? new Set();
      set.add(fn);
      listeners.set(q, set);
      return () => set.delete(fn);
    },
    set(q, value) {
      state.set(q, value);
      for (const fn of listeners.get(q) ?? []) fn();
    },
  };
}

function memoryStore(): AppearanceStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => ok(map.get(key)),
    set: async (key, value) => {
      map.set(key, value);
      return ok();
    },
  };
}

const tiny = defineTokens('x', { color: ['text', 'bg'], space: ['sm'] });
const tinyTheme = defineTheme({
  id: 'test/tiny',
  tokens: tiny,
  values: { color: { text: '#111111', bg: '#ffffff' }, space: { sm: '8px' } },
  dark: { color: { text: '#eeeeee', bg: '#000000' } },
  contrast: { light: { color: { text: '#000000' } } },
  density: { pro: { space: { sm: '4px' } } },
});

describe('tokens', () => {
  it('derives custom properties and references from typed names', () => {
    expect(kebabCase('textMuted')).toBe('text-muted');
    expect(kebabCase('neutral12')).toBe('neutral-12');
    expect(kebabCase('size2xl')).toBe('size-2xl');
    expect(tokenProperty('sf', 'color', 'surfaceSunken')).toBe('--sf-color-surface-sunken');
    expect(themeTokens.color.textMuted.property).toBe('--sf-color-text-muted');
    expect(themeTokens.color.textMuted.ref).toBe('var(--sf-color-text-muted)');
    expect(themeTokens.color.textMuted.css.cssText).toBe('var(--sf-color-text-muted)');
    expect(themeTokens.space.xl.name).toBe('space.xl');
    expect(tokenSetOf(tiny).list.map((t) => t.property)).toEqual(['--x-color-text', '--x-color-bg', '--x-space-sm']);
  });

  it('rejects malformed declarations', () => {
    expect(() => defineTokens('Bad', { a: ['b'] })).toThrow(/prefix/);
    expect(() => defineTokens('x', { 'bad-group': ['b'] })).toThrow(/group/);
    expect(() => defineTokens('x', { a: ['b-c'] })).toThrow(/token name/);
    expect(() => defineTokens('x', { a: ['bC', 'b'], aB: ['x'] })).not.toThrow();
    // `aB.c` and `a.bC` both map to --x-a-b-c
    expect(() => defineTokens('x', { aB: ['c'], a: ['bC'] })).toThrow(/already taken/);
  });

  it('reads values by token', () => {
    expect(valueOf(tinyTheme.values, tiny.color.bg)).toBe('#ffffff');
    expect(valueOf(tinyTheme.dark, tiny.space.sm)).toBeUndefined();
  });
});

describe('colors', () => {
  it('parses hex and rgb() forms', () => {
    expect(parseColor('#abc')).toEqual(ok({ r: 170, g: 187, b: 204, a: 1 }));
    expect(parseColor('#11223380')).toEqual(ok({ r: 17, g: 34, b: 51, a: 0.502 }));
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual(ok({ r: 10, g: 20, b: 30, a: 0.5 }));
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual(ok({ r: 10, g: 20, b: 30, a: 0.5 }));
    const bad = parseColor('rebeccapurple');
    expect(!bad.ok && bad.error.code).toBe('SF-UI-010');
    expect(parseColor('rgb(300, 0, 0)').ok).toBe(false);
  });

  it('formats and normalizes hex', () => {
    expect(formatHex({ r: 255, g: 0, b: 16, a: 1 })).toBe('#ff0010');
    expect(formatHex({ r: 255, g: 0, b: 16, a: 0.5 })).toBe('#ff001080');
    expect(normalizeHex('3af')).toEqual(ok('#33aaff'));
    expect(normalizeHex(' #33AAFF ')).toEqual(ok('#33aaff'));
    expect(normalizeHex('#12345').ok).toBe(false);
    expect(normalizeHex('blue').ok).toBe(false);
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1);
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(contrastRatio('#000', '#fff')).toEqual(ok(21));
    expect(contrastRatio('#fff', '#fff')).toEqual(ok(1));
    expect(contrastRatio('#767676', '#ffffff')).toEqual(ok(4.54));
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }).r).toBeCloseTo(127.5);
    expect(contrastRatio('rgba(0,0,0,0.5)', '#ffffff').ok).toBe(true);
    expect(contrastRatio('nope', '#fff').ok).toBe(false);
    expect(contrastRatio('#fff', 'nope').ok).toBe(false);
  });
});

describe('themes', () => {
  it('validates completeness, unknown tokens and unsafe values', () => {
    expect(validateTheme(tinyTheme).ok).toBe(true);
    expect(validateTheme(defaultTheme).ok).toBe(true);
    const broken = defineTheme({
      id: 'test/broken',
      tokens: tiny,
      values: { color: { text: '', bg: '#fff' }, space: { sm: '8px' } } as never,
      dark: { color: { nope: '#000' } } as never,
      reducedMotion: { space: { sm: 'red; } body { x' } },
    });
    const result = validateTheme(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SF-UI-008');
      expect(result.error.details?.['issues']).toEqual([
        'values.color.text: missing',
        'values.color.text: empty',
        'dark.color.nope: not a token of this set',
        'reducedMotion.space.sm: unsafe characters in "red; } body { x"',
      ]);
    }
  });

  it('resolves values per appearance', () => {
    const base = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' } as const;
    expect(resolveThemeValues(tinyTheme, base).color.text).toBe('#111111');
    expect(resolveThemeValues(tinyTheme, { ...base, scheme: 'dark' }).color.text).toBe('#eeeeee');
    expect(resolveThemeValues(tinyTheme, { ...base, contrast: 'more' }).color.text).toBe('#000000');
    expect(themeValue(tinyTheme, tiny.space.sm, { ...base, density: 'pro' })).toBe('4px');
    expect(themeValue(defaultTheme, themeTokens.motion.durationNormal, { ...base, motion: 'reduce' })).toBe('0ms');
    expect(themeValue(defaultTheme, themeTokens.size.control, { ...base, density: 'focus' })).toBe('32px');
  });

  it('extends a theme without forking it', () => {
    const brand = extendTheme(defaultTheme, { id: 'brand/test', values: { color: { accent: '#5b4ee5' } }, dark: { color: { accent: '#9b8cff' } } });
    expect(brand.values.color.accent).toBe('#5b4ee5');
    expect(brand.values.color.text).toBe(defaultTheme.values.color.text);
    expect(brand.dark.color?.accent).toBe('#9b8cff');
    expect(brand.dark.color?.canvas).toBe(defaultTheme.dark.color?.canvas);
    expect(brand.aliases).toBe(defaultTheme.aliases);
    expect(defaultTheme.values.color.accent).toBe('#3a5bd9');
  });

  it('declares control shape, control edge, agent and display tokens; the default keeps its look', () => {
    const c = themeTokens.color;
    expect(themeTokens.radius.control.property).toBe('--sf-radius-control');
    expect(c.controlEdge.property).toBe('--sf-color-control-edge');
    expect([c.agent, c.agentHover, c.onAgent, c.agentSoft, c.agentInk].map((tk) => tk.property)).toEqual([
      '--sf-color-agent',
      '--sf-color-agent-hover',
      '--sf-color-on-agent',
      '--sf-color-agent-soft',
      '--sf-color-agent-ink',
    ]);
    expect(themeTokens.font.familyDisplay.property).toBe('--sf-font-family-display');
    // Same shape as before the token existed; control edges reuse the ≥ 3:1 strong border.
    expect(defaultTheme.values.radius.control).toBe(defaultTheme.values.radius.md);
    expect(defaultTheme.values.color.controlEdge).toBe(defaultTheme.values.color.borderStrong);
    expect(defaultTheme.dark.color?.controlEdge).toBe(defaultTheme.dark.color?.borderStrong);
    expect(defaultTheme.values.font.familyDisplay).toBe(defaultTheme.values.font.family);
    const ui = UI_CONTRAST_PAIRS.map(([fg, bg]) => `${fg.name}/${bg.name}`);
    expect(ui).toEqual(expect.arrayContaining(['color.controlEdge/color.surface1', 'color.controlEdge/color.canvas', 'color.agent/color.surface1']));
    const text = TEXT_CONTRAST_PAIRS.map(([fg, bg]) => `${fg.name}/${bg.name}`);
    expect(text).toEqual(expect.arrayContaining(['color.onAgent/color.agent', 'color.agentInk/color.agentSoft', 'color.textMuted/color.neutral3']));
  });

  it('compiles to CSS that honors platform preferences before JS and explicit attributes after', () => {
    const cssText = compileTheme(tinyTheme);
    expect(cssText).toContain(':root{--x-color-text:#111111;--x-color-bg:#ffffff;--x-space-sm:8px;color-scheme:light}');
    expect(cssText).toContain('@media (prefers-color-scheme:dark){:root:not([data-sf-scheme]){--x-color-text:#eeeeee;--x-color-bg:#000000;color-scheme:dark}}');
    expect(cssText).toContain(':root[data-sf-scheme="dark"]{');
    expect(cssText).toContain(':root[data-sf-contrast="more"]{--x-color-text:#000000}');
    // dark + more re-resolves every contrast key against the dark values
    expect(cssText).toContain(':root[data-sf-contrast="more"][data-sf-scheme="dark"]{--x-color-text:#eeeeee}');
    expect(cssText).toContain(':root[data-sf-density="pro"]{--x-space-sm:4px}');
    expect(cssText).not.toContain('data-sf-density="focus"');
    expect(cssText).not.toContain('reduced-motion');
    const scoped = compileTheme(defaultTheme, { selector: '[data-sf-theme="sf/default"]' });
    expect(scoped).toContain('[data-sf-theme="sf/default"][data-sf-motion="reduce"]{--sf-motion-duration-fast:0ms');
    expect(scoped).toContain('--sf-color-bg:var(--sf-color-canvas)');
    expect(Object.keys(legacyAliases)).toContain('--sf-space-2');
  });
});

describe('appearance', () => {
  it('sanitizes stored preferences and resolves them against the platform', () => {
    expect(sanitizeAppearance({ scheme: 'dark', density: 'huge', motion: 'reduce', extra: 1 })).toEqual({ scheme: 'dark', motion: 'reduce' });
    expect(sanitizeAppearance(null)).toEqual({});
    const platform = { dark: true, moreContrast: false, forcedColors: true, reducedMotion: true };
    expect(resolveAppearance({ scheme: 'system', contrast: 'system', density: 'pro', motion: 'system' }, platform)).toEqual({
      scheme: 'dark',
      contrast: 'more',
      density: 'pro',
      motion: 'reduce',
    });
    expect(resolveAppearance({ scheme: 'light', contrast: 'normal', density: 'focus', motion: 'full' }, platform)).toEqual({
      scheme: 'light',
      contrast: 'normal',
      density: 'focus',
      motion: 'full',
    });
  });

  it('wraps matchMedia and degrades without it', () => {
    const none = browserMediaQueries({} as typeof globalThis);
    expect(none.matches('(prefers-color-scheme: dark)')).toBe(false);
    expect(typeof none.subscribe('x', () => undefined)).toBe('function');
    const real = browserMediaQueries();
    expect(typeof real.matches('(prefers-color-scheme: dark)')).toBe('boolean');
    real.subscribe('(prefers-color-scheme: dark)', () => undefined)();
  });

  it('applies the theme stylesheet and resolved attributes, following system changes', async () => {
    const media = fakeMedia({ '(prefers-color-scheme: dark)': false });
    const store = memoryStore();
    const appearance = createAppearance({ themes: [defaultTheme], media, store });
    const scope = createScope('app');
    const root = document.documentElement;
    expect(appearance.apply(root, scope).ok).toBe(true);
    const style = document.head.querySelector('style[data-sf-theme-style]');
    expect(style?.textContent).toContain('--sf-color-text:#1a1f27');
    expect(root.getAttribute(APPEARANCE_ATTRS.scheme)).toBe('light');
    expect(root.getAttribute(APPEARANCE_ATTRS.density)).toBe('standard');
    expect(root.getAttribute(APPEARANCE_ATTRS.theme)).toBe('sf/default');

    media.set('(prefers-color-scheme: dark)', true);
    expect(root.getAttribute(APPEARANCE_ATTRS.scheme)).toBe('dark');
    media.set('(prefers-reduced-motion: reduce)', true);
    expect(root.getAttribute(APPEARANCE_ATTRS.motion)).toBe('reduce');

    expect((await appearance.set({ scheme: 'light', density: 'pro' })).ok).toBe(true);
    expect(root.getAttribute(APPEARANCE_ATTRS.scheme)).toBe('light');
    expect(root.getAttribute(APPEARANCE_ATTRS.density)).toBe('pro');
    expect(JSON.parse(store.map.get(APPEARANCE_PREFERENCE_KEY) ?? '{}')).toEqual({ scheme: 'light', contrast: 'system', density: 'pro', motion: 'system' });

    await scope.dispose();
    expect(document.head.querySelector('style[data-sf-theme-style]')).toBeNull();
    expect(root.hasAttribute(APPEARANCE_ATTRS.scheme)).toBe(false);
  });

  it('restores a persisted preference and ignores corrupt data', async () => {
    const store = memoryStore();
    store.map.set(APPEARANCE_PREFERENCE_KEY, JSON.stringify({ density: 'focus', scheme: 'bogus' }));
    const appearance = createAppearance({ themes: [defaultTheme], store, media: fakeMedia() });
    expect((await appearance.restore()).ok).toBe(true);
    expect(appearance.preference).toEqual({ scheme: 'system', contrast: 'system', density: 'focus', motion: 'system' });
    store.map.set(APPEARANCE_PREFERENCE_KEY, '{not json');
    expect((await appearance.restore()).ok).toBe(true);
    expect(appearance.preference.density).toBe('focus');
    expect((await createAppearance({ themes: [defaultTheme] }).restore()).ok).toBe(true);
  });

  it('selects the last contributed theme, switches by id, and reports missing themes', () => {
    const brand = extendTheme(defaultTheme, { id: 'brand/x' });
    const appearance = createAppearance({ themes: [defaultTheme, brand], media: fakeMedia() });
    expect(appearance.theme.id).toBe('brand/x');
    expect(appearance.useTheme('sf/default').ok).toBe(true);
    expect(appearance.theme.id).toBe('sf/default');
    const missing = appearance.useTheme('nope/nope');
    expect(!missing.ok && missing.error.code).toBe('SF-UI-009');
    const empty = createAppearance({ themes: [], media: fakeMedia() });
    expect(() => empty.theme).toThrow(/theme/);
    const applied = empty.apply(document.createElement('div'), createScope('app'));
    expect(!applied.ok && applied.error.code).toBe('SF-UI-009');
  });

  it('scopes a subtree root by its theme attribute and recompiles on theme switch', async () => {
    const brand = extendTheme(defaultTheme, { id: 'brand/y', values: { color: { accent: '#123456' } } });
    const appearance = createAppearance({ themes: [defaultTheme, brand], media: fakeMedia(), theme: 'sf/default' });
    const host = document.createElement('div');
    document.body.append(host);
    const scope = createScope('app');
    appearance.apply(host, scope);
    const style = document.head.querySelector('style[data-sf-theme-style]');
    expect(style?.textContent?.startsWith('[data-sf-theme="sf/default"]{')).toBe(true);
    appearance.useTheme('brand/y');
    expect(host.getAttribute(APPEARANCE_ATTRS.theme)).toBe('brand/y');
    expect(style?.textContent).toContain('--sf-color-accent:#123456');
    await scope.dispose();
    host.remove();
  });
});

describe('theme units', () => {
  it('contributes themes in order and provides the appearance through DI', async () => {
    const brand = extendTheme(defaultTheme, { id: 'brand/z' });
    const store = memoryStore();
    store.map.set(APPEARANCE_PREFERENCE_KEY, JSON.stringify({ density: 'pro' }));
    const injector = createInjector({
      units: [
        themeContribution(brand, { order: 5 }),
        defaultThemeContribution,
        appearanceUnit,
        { kind: 'unit', id: 'test/store', provides: AppearanceStoreToken, scope: 'app', create: () => store } as never,
      ],
    });
    const appearance = await injector.get(AppearanceToken);
    expect(appearance.ok).toBe(true);
    if (!appearance.ok) return;
    expect(appearance.value.themes.map((t) => t.id)).toEqual(['sf/default', 'brand/z']);
    expect(appearance.value.theme.id).toBe('brand/z');
    expect(appearance.value.preference.density).toBe('pro');
    await appearance.value.set({ motion: 'reduce' });
    expect(store.map.get(APPEARANCE_PREFERENCE_KEY)).toContain('"motion":"reduce"');
    await injector.dispose();
  });

  it('restores manually when asked (first paint never waits on storage)', async () => {
    const store = memoryStore();
    store.map.set(APPEARANCE_PREFERENCE_KEY, JSON.stringify({ density: 'pro' }));
    const injector = createInjector({
      units: [defaultThemeContribution, appearanceUnitWith({ restore: 'manual' }), { kind: 'unit', id: 'test/store', provides: AppearanceStoreToken, scope: 'app', create: () => store } as never],
    });
    const appearance = await injector.get(AppearanceToken);
    if (!appearance.ok) throw appearance.error;
    expect(appearance.value.preference.density).toBe('standard');
    await appearance.value.restore();
    expect(appearance.value.preference.density).toBe('pro');
    await injector.dispose();
  });

  it('works without a bound store and with an explicit theme id', async () => {
    const injector = createInjector({ units: [defaultThemeContribution, themeContribution(extendTheme(defaultTheme, { id: 'brand/w' })), appearanceUnitWith({ theme: 'sf/default', initial: { density: 'focus' } })] });
    const appearance = await injector.get(AppearanceToken);
    expect(appearance.ok && appearance.value.theme.id).toBe('sf/default');
    expect(appearance.ok && appearance.value.preference.density).toBe('focus');
    expect(appearance.ok && (await appearance.value.set({ scheme: 'dark' })).ok).toBe(true);
    await injector.dispose();
  });
});
