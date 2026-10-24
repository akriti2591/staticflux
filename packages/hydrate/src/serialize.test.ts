import { describe, expect, it } from 'vitest';
import { escapeHtmlAttribute, escapeJsonForHtml, parseIslandProps, renderIslandMarker, scanIslands, serializeIslandProps } from './index.js';

const XSS = `</script><script>alert(1)</script>' " <img src=x onerror=alert(2)> & \u2028\u2029`;

function mount(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('serializeIslandProps', () => {
  it('produces valid JSON with no raw <, >, & or line separators', () => {
    const json = serializeIslandProps({ text: XSS, n: 1, nested: [true, null, { a: 'b' }] });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.value).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json.value)).toEqual({ text: XSS, n: 1, nested: [true, null, { a: 'b' }] });
  });

  it('drops undefined object properties (optional props)', () => {
    const json = serializeIslandProps({ a: 1, b: undefined });
    expect(json).toEqual({ ok: true, value: '{"a":1}' });
  });

  it.each([
    ['function', { f: () => 1 }],
    ['symbol', { s: Symbol('x') }],
    ['bigint', { b: 1n }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', [Infinity]],
    ['class instance', { d: new Date(0) }],
    ['map', new Map()],
    ['undefined in array', [1, undefined]],
    ['undefined root', undefined],
  ])('rejects %s with SF-HYD-030', (_name, value) => {
    const result = serializeIslandProps(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-HYD-030');
  });

  it('rejects cycles but accepts shared (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(serializeIslandProps({ a: shared, b: shared }).ok).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(serializeIslandProps(cyclic).ok).toBe(false);
  });

  it('accepts null-prototype objects', () => {
    const value = Object.assign(Object.create(null) as object, { a: 1 });
    expect(serializeIslandProps(value)).toEqual({ ok: true, value: '{"a":1}' });
  });
});

describe('escaping helpers', () => {
  it('escapes attribute-breaking characters', () => {
    expect(escapeHtmlAttribute(`a&b"c'd<e>f`)).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;f');
  });
  it('escapes JSON for HTML', () => {
    expect(escapeJsonForHtml('"</script>&"')).toBe('"\\u003c/script\\u003e\\u0026"');
  });
});

describe('renderIslandMarker', () => {
  it('renders an <sf-island> marker that round-trips through the DOM scanner', () => {
    const markup = renderIslandMarker({
      chunk: 'feature:cart',
      hydrate: 'interaction',
      props: { sku: 'a1', text: XSS },
      id: 'cart',
      exportName: 'cartIsland',
      size: { width: 320, height: 48 },
      html: '<button>Add</button>',
      attributes: { class: 'island "x"' },
    });
    expect(markup.ok).toBe(true);
    if (!markup.ok) return;
    const root = mount(markup.value);
    expect(root.querySelectorAll('script').length).toBe(0);
    expect(root.querySelectorAll('img').length).toBe(0);
    const { islands, issues } = scanIslands(root);
    expect(issues).toEqual([]);
    const island = islands[0];
    expect(island).toMatchObject({ id: 'cart', chunk: 'feature:cart', strategy: 'interaction', exportName: 'cartIsland', declaredSize: { width: 320, height: 48 } });
    expect(island && parseIslandProps(island)).toEqual({ ok: true, value: { sku: 'a1', text: XSS } });
    expect(island?.element.getAttribute('class')).toBe('island "x"');
    expect(island?.element.querySelector('button')?.textContent).toBe('Add');
  });

  it('renders the data-attribute form with props in a script (XSS-safe)', () => {
    const markup = renderIslandMarker({
      chunk: 'feature:feed',
      form: { tag: 'section' },
      propsIn: 'script',
      props: { text: XSS },
      html: '<p>static</p>',
    });
    expect(markup.ok).toBe(true);
    if (!markup.ok) return;
    expect(markup.value.startsWith('<section data-sf-island="feature:feed">')).toBe(true);
    const root = mount(markup.value);
    const scripts = root.querySelectorAll('script');
    expect(scripts.length).toBe(1);
    expect(root.querySelectorAll('img').length).toBe(0);
    const island = scanIslands(root).islands[0];
    expect(island?.props.kind).toBe('script');
    expect(island && parseIslandProps(island)).toEqual({ ok: true, value: { text: XSS } });
  });

  it('requires a reason for eager at runtime too', () => {
    const forged = { chunk: 'feature:x', hydrate: 'eager', html: '' } as unknown as Parameters<typeof renderIslandMarker>[0];
    expect(renderIslandMarker(forged).ok).toBe(false);
    const good = renderIslandMarker({ chunk: 'feature:x', hydrate: 'eager', reason: 'hero', html: '' });
    expect(good).toEqual({ ok: true, value: '<sf-island chunk="feature:x" hydrate="eager" reason="hero"></sf-island>' });
  });

  it.each([
    ['bad chunk', { chunk: 'bad' as `${string}:${string}`, html: '' }],
    ['bad strategy', { chunk: 'feature:x', hydrate: 'soon' as 'idle', html: '' }],
    ['void host tag', { chunk: 'feature:x', form: { tag: 'img' }, html: '' }],
    ['script host tag', { chunk: 'feature:x', form: { tag: 'script' }, html: '' }],
    ['invalid tag', { chunk: 'feature:x', form: { tag: 'di v' }, html: '' }],
    ['event handler attribute', { chunk: 'feature:x', attributes: { onclick: 'x()' }, html: '' }],
    ['reserved attribute', { chunk: 'feature:x', attributes: { props: '{}' }, html: '' }],
    ['invalid attribute name', { chunk: 'feature:x', attributes: { 'a b': '1' }, html: '' }],
    ['negative size', { chunk: 'feature:x', size: { width: -1, height: 1 }, html: '' }],
    ['non-plain props', { chunk: 'feature:x', props: { f: () => 1 }, html: '' }],
  ])('rejects %s', (_name, options) => {
    const result = renderIslandMarker(options as Parameters<typeof renderIslandMarker>[0]);
    expect(result.ok).toBe(false);
  });
});
