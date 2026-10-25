import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditA11y } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineIcon, defineIconElement, iconElement, iconProblems, iconStrokeWidth, type IconDef, SfIconElement } from './icon.js';
import * as icons from './icons/index.js';
import { squareIcon } from './icons/square.js';
import { trash2Icon } from './icons/trash-2.js';
import { cleanup, fixture } from './test-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(HERE, 'icons');
const manifest = JSON.parse(readFileSync(join(ICONS_DIR, 'icons.json'), 'utf8')) as { readonly lucide: readonly string[] };
const customNames = readdirSync(join(ICONS_DIR, 'custom'))
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4));
const all = Object.values(icons) as IconDef[];

beforeAll(() => defineIconElement());
afterEach(cleanup);

describe('icon data', () => {
  it('defineIcon freezes an icon value', () => {
    const icon = defineIcon('dot', [['circle', { cx: '12', cy: '12', r: '2' }]], 'custom');
    expect(icon).toEqual({ kind: 'icon', name: 'dot', nodes: [['circle', { cx: '12', cy: '12', r: '2' }]], source: 'custom' });
    expect(Object.isFrozen(icon)).toBe(true);
    expect(Object.isFrozen(icon.nodes[0]?.[1])).toBe(true);
  });

  it('uses stroke 1.75 at 16 px and 2 at 18 and 24 px', () => {
    expect([iconStrokeWidth(16), iconStrokeWidth(18), iconStrokeWidth(24)]).toEqual([1.75, 2, 2]);
  });

  it('reports tags and attributes outside the icon vocabulary', () => {
    const bad = defineIcon('bad', [['script' as 'path', { d: 'M0 0' }], ['path', { onload: 'x', d: 'M1 1' }]]);
    expect(iconProblems(bad)).toEqual(['bad[0]: tag <script> is not allowed', 'bad[1]: attribute "onload" is not allowed']);
  });

  it('builds an SVG on the 24-unit grid in currentColor, skipping anything unsafe', () => {
    const svg = iconElement(defineIcon('mixed', [['path', { d: 'M3 6h18', onclick: 'x' }], ['script' as 'path', {}]]));
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.children).toHaveLength(1);
    expect(svg.children[0]?.getAttribute('d')).toBe('M3 6h18');
    expect(svg.children[0]?.hasAttribute('onclick')).toBe(false);
  });
});

describe('the icon set', () => {
  it('has one module per manifest name and custom SVG, all in the barrel', () => {
    expect(all.map((i) => i.name).sort()).toEqual([...manifest.lucide, ...customNames].sort());
    const modules = readdirSync(ICONS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    expect(modules.length).toBe(all.length);
  });

  it('keeps every icon data-only and on the grid', () => {
    for (const icon of all) {
      expect(iconProblems(icon), icon.name).toEqual([]);
      expect(icon.nodes.length, icon.name).toBeGreaterThan(0);
      expect(icon.source).toBe(customNames.includes(icon.name) ? 'custom' : 'lucide');
    }
  });

  it('covers the Studio icon rules (STUDIO-UX-SPEC §10.2 point 4), Lucide and custom', () => {
    const names = new Set(all.map((i) => i.name));
    for (const name of ['mouse-pointer-2', 'hand', 'frame', 'square', 'type', 'pen-tool', 'rotate-cw', 'flip-horizontal-2', 'lock', 'eye-off', 'trash-2', 'ellipsis', 'chevron-down', 'settings', 'download', 'flag', 'layout-template'])
      expect(names.has(name), name).toBe(true);
    for (const name of ['boolean-union', 'boolean-subtract', 'boolean-intersect', 'boolean-exclude', 'mask', 'skew', 'pivot', 'repeat-radial', 'repeat-grid', 'repeat-mirror', 'drop-shadow', 'smooth-corner', 'text-auto-width', 'text-auto-height', 'text-fixed'])
      expect(names.has(name), name).toBe(true);
  });

  it('is what the generator writes from Lucide and the custom SVGs', () => {
    const script = join(HERE, '..', 'scripts', 'generate-icons.mjs');
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 20_000); // spawns node and imports Lucide's ESM index (thousands of modules)

  it('records the Lucide licence next to the modules', () => {
    const licence = readFileSync(join(ICONS_DIR, 'LICENSE'), 'utf8');
    expect(licence).toContain('ISC License');
    expect(licence).toContain('Lucide');
  });
});

describe('<sf-icon>', () => {
  it('renders the icon decoratively, reflecting its name', async () => {
    const { element } = await fixture<SfIconElement>(html`<sf-icon .icon=${trash2Icon}></sf-icon>`);
    expect(element.getAttribute('name')).toBe('trash-2');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.getAttribute('size')).toBe('16');
    const svg = element.shadowRoot?.querySelector('svg');
    expect(svg?.children.length).toBe(trash2Icon.nodes.length);
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('swaps icons and sizes, and becomes an image with a label', async () => {
    const { element } = await fixture<SfIconElement>(html`<sf-icon .icon=${trash2Icon} size="24"></sf-icon>`);
    expect(element.size).toBe(24);
    element.icon = squareIcon;
    element.label = 'Rectangle';
    await element.updateComplete;
    expect(element.getAttribute('name')).toBe('square');
    expect(element.getAttribute('role')).toBe('img');
    expect(element.getAttribute('aria-label')).toBe('Rectangle');
    expect(element.hasAttribute('aria-hidden')).toBe(false);
    expect(element.shadowRoot?.querySelectorAll('svg')).toHaveLength(1);
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
    element.icon = undefined;
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('svg')).toBeNull();
    expect(element.hasAttribute('name')).toBe(false);
  });

  it('falls back to 16 px for unknown sizes and themes the stroke per size', async () => {
    const { element } = await fixture<SfIconElement>(html`<sf-icon .icon=${squareIcon} size="20"></sf-icon>`);
    expect(element.size).toBe(16);
    const cssText = SfIconElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('var(--sf-icon-stroke, 1.75)');
    expect(cssText).toContain('var(--sf-icon-stroke, 2)');
    expect(cssText).toContain('forced-colors');
  });
});

describe('kit chrome uses the icon set, not text glyphs', () => {
  it('draws chevrons with <sf-icon> in the dock, panels, inspector groups and tree', () => {
    for (const file of ['dock.ts', 'inspector.ts', 'tree.ts']) {
      const source = readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(source, file).not.toMatch(/[▾▸‹›✕✓●⋯]/);
      expect(source, file).toContain('<sf-icon');
    }
  });
});
