/**
 * Typography panel and text contributions: kit-only UI under Clean Pop, keyboard paths, an accessibility audit,
 * and the contributions resolving through B0's tokens.
 */
import { createInjector, ok, unit } from '@staticflux/core';
import { auditA11y, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HudActionContributionsToken, PanelContributionsToken, ToolContributionsToken } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { placeTextOps, TextIds, textContributionUnits, textHudActions, textTool, typographyPanel } from './contributions.js';
import { ALIGN_OPTIONS, defineTypographyPanel, fontLabel, type IfTypographyPanelElement, TYPOGRAPHY_TEXT } from './typography-panel.js';
import { MIXED, type TypographyService, TypographyServiceToken, type TypographySummary } from './typography.js';

const SUMMARY: TypographySummary = { font: { font: 'sha256:aa' }, size: 24, weight: 700, bold: true, italic: false, underline: MIXED, color: '#112233', letterSpacing: 0, align: 'center', lineHeight: 1.2, link: undefined };

function fakeService(options: { readonly summary: TypographySummary | undefined } = { summary: SUMMARY }) {
  const summary = options.summary;
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}${args.length > 0 ? ` ${JSON.stringify(args[0])}` : ''}`);
    return ok(undefined);
  };
  const service: TypographyService = {
    summary: () => summary,
    fontChoices: () => [{ label: 'Display Sans', value: { font: 'sha256:aa' } }, { label: 'Brand body', value: { token: 'font.body' } }],
    colorChoices: () => [{ label: 'Primary', value: { token: 'color.primary' }, css: '#2255ff' }],
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setFont: record('setFont'),
    setSize: record('setSize'),
    setWeight: record('setWeight'),
    toggle: record('toggle'),
    setColor: record('setColor'),
    setLetterSpacing: record('setLetterSpacing'),
    setLink: record('setLink'),
    setAlign: record('setAlign'),
    setLineHeight: record('setLineHeight'),
    fitToBox: record('fitToBox'),
  };
  return { service, calls, notify: () => listeners.forEach((l) => l()) };
}

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineTypographyPanel());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(options?: { readonly summary: TypographySummary | undefined }) {
  const fake = fakeService(options);
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [unit({ id: 'test/typography', provides: TypographyServiceToken, scope: 'app', create: () => fake.service })] });
  dispose = () => root.dispose();
  render(html`<if-typography-panel></if-typography-panel>`, root.container);
  await settle();
  const panel = root.container.querySelector('if-typography-panel') as IfTypographyPanelElement;
  await panel.updateComplete;
  return { ...fake, panel, shadow: panel.shadowRoot as ShadowRoot };
}

describe('<if-typography-panel>', () => {
  it('renders kit rows with the summary, passes an a11y audit, and toggles by click and keyboard', async () => {
    const { panel, shadow, calls } = await mount();
    const rows = [...shadow.querySelectorAll('sf-inspector-row')].map((r) => r.getAttribute('label'));
    expect(rows).toEqual([TYPOGRAPHY_TEXT.font, TYPOGRAPHY_TEXT.size, TYPOGRAPHY_TEXT.style, TYPOGRAPHY_TEXT.align, TYPOGRAPHY_TEXT.lineHeight, TYPOGRAPHY_TEXT.color, TYPOGRAPHY_TEXT.brandColors]);
    const toggles = [...shadow.querySelectorAll('.toggles sf-button')] as HTMLElement[];
    expect(toggles.map((b) => [b.getAttribute('aria-label'), b.getAttribute('pressed')])).toEqual([
      ['Bold', 'true'],
      ['Italic', 'false'],
      ['Underline', 'mixed'],
    ]);
    (toggles[1] as HTMLElement).click();
    expect(calls).toContain('toggle "italic"');
    const segmented = shadow.querySelector('sf-segmented') as HTMLElement & { value: string; options: unknown };
    expect(segmented.value).toBe('center');
    expect(segmented.options).toBe(ALIGN_OPTIONS);
    segmented.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'end' } }));
    expect(calls).toContain('setAlign "end"');
    const slider = shadow.querySelector('sf-slider') as HTMLElement;
    slider.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 48 } }));
    expect(calls).toContain('setSize 48');
    const menus = shadow.querySelectorAll('sf-menu');
    (menus[0] as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: '1' } }));
    expect(calls).toContain('setFont {"token":"font.body"}');
    (menus[1] as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: '0' } }));
    expect(calls).toContain('setColor {"token":"color.primary"}');
    const color = shadow.querySelector('sf-color-field') as HTMLElement;
    color.dispatchEvent(new CustomEvent('sf-change', { detail: { value: '#ff0000' } }));
    expect(calls).toContain('setColor "#ff0000"');
    const fit = shadow.querySelector('.fit sf-button') as HTMLElement;
    press(fit, 'Enter');
    fit.click();
    expect(calls).toContain('fitToBox');
    expect(auditA11y(panel.parentElement as HTMLElement)).toEqual([]);
  });

  it('shows an empty state without a text selection and re-renders on service changes', async () => {
    const { shadow, notify, panel } = await mount({ summary: undefined });
    expect(shadow.querySelector('.empty')?.textContent).toBe(TYPOGRAPHY_TEXT.empty);
    const before = panel.revision;
    notify();
    await panel.updateComplete;
    expect(panel.revision).toBe(before + 1);
  });

  it('labels fonts from choices, tokens, families or the hash', () => {
    const { service } = fakeService();
    expect(fontLabel(SUMMARY, service)).toBe('Display Sans');
    expect(fontLabel({ ...SUMMARY, font: MIXED }, service)).toBe('Mixed');
    expect(fontLabel({ ...SUMMARY, font: undefined }, service)).toBe('Default font');
    expect(fontLabel({ ...SUMMARY, font: { token: 'font.x' } }, service)).toBe('@font.x');
    expect(fontLabel({ ...SUMMARY, font: { font: 'sha256:0123456789abcdef', family: 'Fam' } }, service)).toBe('Fam');
    expect(fontLabel({ ...SUMMARY, font: { font: 'sha256:0123456789abcdef' } }, service)).toBe('01234567');
  });
});

describe('text contributions (B0 tokens)', () => {
  it('contribute the Text tool, the Typography panel and three HUD actions', async () => {
    const { service } = fakeService();
    const injector = createInjector({ units: [...textContributionUnits(), unit({ id: 'test/typo', provides: TypographyServiceToken, scope: 'app', create: () => service })] });
    const tools = await injector.get(ToolContributionsToken);
    const panels = await injector.get(PanelContributionsToken);
    const hud = await injector.get(HudActionContributionsToken);
    expect(tools.ok && tools.value.map((t) => t.id)).toEqual([StudioIds.tool.text]);
    expect(panels.ok && panels.value.map((p) => p.id)).toEqual([TextIds.panel]);
    expect(hud.ok && hud.value.map((h) => h.id)).toEqual([TextIds.hud.font, TextIds.hud.size, TextIds.hud.fit]);
    expect(textTool).toMatchObject({ kind: 'instaflow/tool', shortcut: 'T', lenses: [StudioIds.lens.canvas] });
    expect(typographyPanel.placements[0]).toBe('inspector');
    expect(textHudActions.every((a) => a.tone === 'direct')).toBe(true);
    expect(typographyPanel.render({ density: 'standard', lens: StudioIds.lens.canvas, scope: 'selection' })).toBeDefined();
  });

  it('the Text tool places auto-width or fixed-width text', () => {
    const auto = placeTextOps({ node: 'n1', parent: 'page', x: 10, y: 20 });
    expect(auto.ok && auto.value[0]).toMatchObject({ op: 'create', kind: 'text', props: { 'spatial.x': 10, 'spatial.y': 20, 'text.box': 'auto-width', 'lineage.matchKey': 'n1' } });
    const fixed = placeTextOps({ node: 'n2', parent: null, x: 0, y: 0, width: 300, text: 'Hi', style: { size: 30 }, paragraph: { align: 'center' } });
    expect(fixed.ok && fixed.value[0]).toMatchObject({ props: { 'spatial.w': 300, 'text.box': 'auto-height' } });
    expect(placeTextOps({ node: 'n3', parent: null, x: Number.NaN, y: 0 }).ok).toBe(false);
    expect(placeTextOps({ node: 'n3', parent: null, x: 0, y: 0, width: 0 }).ok).toBe(false);
  });
});
