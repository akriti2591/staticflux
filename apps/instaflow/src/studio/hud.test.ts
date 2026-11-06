/**
 * `<if-hud>` (B11b, STUDIO-UX-SPEC §4.2.4): the pill per selection kind under Clean Pop — exactly the ranked controls
 * (≤ 6, then More), each forwarding to the port; the colour popover commits a paint; the More menu lists only what the
 * selection can run, grouped; the a11y audit passes for every kind.
 */
import { expectNoA11yIssues, accessibleName } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SelectionKind, SelectionSummary } from '../app/scene-summary.js';
import { CONTROL_SETS } from './studio-controls.js';
import { hudControls } from '../spec/controls.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineHud, type HudPort, type IfHudElement, moreMenuGroups, paintFromColor, pillCapabilities } from './hud.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineHud());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const base = (kind: SelectionKind, extra: Partial<SelectionSummary> = {}): SelectionSummary => ({
  kind,
  nodes: ['a'],
  label: 'A',
  typeLabel: 'A',
  locked: kind === 'locked',
  anyLocked: kind === 'locked',
  hidden: false,
  actions: ['instaflow/delete', 'instaflow/duplicate'],
  ...extra,
});

async function mount(summary: SelectionSummary): Promise<{ hud: IfHudElement; calls: string[] }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [] });
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push(`${name} ${JSON.stringify(args.filter((a) => a !== undefined))}`);
  const port: HudPort = {
    invoke: log('invoke'),
    setPaint: log('setPaint'),
    setProp: log('setProp'),
    setFont: log('setFont'),
    setSize: log('setSize'),
    setTextColor: log('setTextColor'),
    toggleText: log('toggleText'),
    setTextAlign: log('setTextAlign'),
    setRepeat: log('setRepeat'),
    setImageFit: log('setImageFit'),
    command: log('command'),
  };
  const actions = new Map([['instaflow/flip-horizontal', { id: 'instaflow/flip-horizontal', title: 'Flip horizontal', shortcut: 'Shift+H' }]]);
  render(html`<if-hud .summary=${summary} .port=${port} .actions=${actions} .fonts=${[{ label: 'Noto Sans', value: { font: 'sha256:aa', family: 'Noto Sans' } }]}></if-hud>`, root.container);
  dispose = () => root.dispose();
  await settle(6);
  return { hud: root.container.querySelector('if-hud') as IfHudElement, calls };
}

const items = (hud: IfHudElement): string[] => [...(hud.shadowRoot?.querySelectorAll('[data-hud-item]') ?? [])].map((el) => accessibleName(el) || (el.getAttribute('label') ?? ''));

describe('<if-hud> per selection kind (§4.2.4)', () => {
  const CASES: readonly [string, SelectionSummary, readonly string[]][] = [
    ['shape (rectangle)', base('shape', { common: 'rectangle', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 8 }), ['Fill', 'Stroke', 'Radius', 'Duplicate', 'Delete']],
    // #47: slot 3 is the shape's own count (STUDIO §4.2.4; INSPECTOR-LAYOUT §2: `Sides` / `Points` rank 3).
    ['shape (polygon: Sides in slot 3)', base('shape', { common: 'polygon', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 0, points: 5 }), ['Fill', 'Stroke', 'Sides', 'Duplicate', 'Delete']],
    ['shape (star: Points in slot 3)', base('shape', { common: 'star', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 0, points: 5, ratio: 0.382 }), ['Fill', 'Stroke', 'Points', 'Duplicate', 'Delete']],
    ['shape (ellipse: no radius)', base('shape', { common: 'ellipse', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' } }), ['Fill', 'Stroke', 'Duplicate', 'Delete']],
    ['text', base('text', { common: 'text' }), ['Font: Font', 'Size', 'Text colour', 'Bold', 'Align: Align text left', 'Delete']],
    ['image', base('image', { common: 'image', fit: 'contain' }), ['Fit: Fit', 'Duplicate', 'Delete']],
    ['frame', base('frame', { common: 'frame', fill: { kind: 'solid', color: '#FFFFFF' }, stroke: { kind: 'none' }, clip: true }), ['Fill', 'Clip content', 'Duplicate', 'Delete']],
    ['group', base('group', { actions: ['instaflow/ungroup', 'instaflow/delete', 'instaflow/duplicate'] }), ['Ungroup', 'Align', 'Duplicate', 'Delete']],
    [
      'multi (shapes)',
      base('multi', { nodes: ['a', 'b', 'c'], common: 'rectangle', fill: { kind: 'mixed' }, stroke: { kind: 'none' }, actions: ['instaflow/group', 'instaflow/distribute-h-spacing', 'instaflow/delete'] }),
      ['Fill', 'Stroke', 'Align', 'Distribute: Distribute', 'Group', 'Delete'],
    ],
    ['mixed', base('mixed', { nodes: ['a', 'b'], actions: ['instaflow/group', 'instaflow/delete'] }), ['Align', 'Group', 'Delete']],
    ['locked', base('locked'), ['Unlock']],
    ['repeat', base('repeat', { repeat: { kind: 'radial', count: 8 } }), ['Count', 'Expand', 'Release']],
    ['boolean', base('boolean', { booleanOp: 'subtract', fill: { kind: 'solid', color: '#000000' }, stroke: { kind: 'none' } }), ['Operation: Subtract', 'Fill', 'Release', 'Flatten', 'Delete']],
    ['mask', base('mask', { mask: { node: 'm', mode: 'alpha', invert: false } }), ['Mask mode: Alpha', 'Invert', 'Release', 'Duplicate', 'Delete']],
  ];

  it.each(CASES)('%s: exactly the ranked controls, then More', async (_, summary, expected) => {
    const { hud } = await mount(summary);
    const shown = items(hud);
    expect(shown.slice(0, expected.length)).toEqual(expected);
    expect(hudControls(CONTROL_SETS[summary.kind]).length).toBeLessThanOrEqual(6);
    expectNoA11yIssues(hud);
  });

  it('nothing selected: no pill', async () => {
    const { hud } = await mount(base('none', { nodes: [] }));
    expect(hud.shadowRoot?.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('a locked selection shows the Locked chip and Unlock runs lock with locked: false', async () => {
    const { hud, calls } = await mount(base('locked'));
    expect(hud.shadowRoot?.querySelector('sf-tag')?.textContent).toBe('Locked');
    (hud.shadowRoot?.querySelector('sf-icon-button[label="Unlock"]') as HTMLElement).click();
    expect(calls).toEqual(['invoke ["instaflow/lock",{"locked":false}]']);
  });

  it('#47: the pill’s Sides (polygon) and Points (star) set geometry.sides once per commit, clamped to 3…1000', async () => {
    const field = (hud: IfHudElement, label: string): HTMLElement => {
      const el = hud.shadowRoot?.querySelector(`sf-number-field[label="${label}"]`) as HTMLElement | null;
      if (el === null) throw new Error(`no field ${label}`);
      return el;
    };
    const change = (el: Element, value: number): boolean => el.dispatchEvent(new CustomEvent('sf-change', { detail: { value }, bubbles: true, composed: true }));
    const has = (hud: IfHudElement, label: string): boolean => (hud.shadowRoot?.querySelector(`[data-hud-item][label="${label}"]`) ?? null) !== null;
    const polygon = await mount(base('shape', { common: 'polygon', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 0, points: 5 }));
    expect(has(polygon.hud, 'Radius')).toBe(false);
    change(field(polygon.hud, 'Sides'), 8);
    change(field(polygon.hud, 'Sides'), 2);
    change(field(polygon.hud, 'Sides'), 5000);
    expect(polygon.calls).toEqual(['setProp ["geometry.sides",8,"Sides"]', 'setProp ["geometry.sides",3,"Sides"]', 'setProp ["geometry.sides",1000,"Sides"]']);
    await dispose?.();
    const star = await mount(base('shape', { common: 'star', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 0, points: 5, ratio: 0.382 }));
    change(field(star.hud, 'Points'), 6.6);
    expect(star.calls).toEqual(['setProp ["geometry.sides",7,"Points"]']);
    await dispose?.();
    const rect = await mount(base('shape', { common: 'rectangle', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' }, radius: 8 }));
    expect(has(rect.hud, 'Radius')).toBe(true);
    expect(has(rect.hud, 'Sides') || has(rect.hud, 'Points')).toBe(false);
  });

  it('a mask group’s mode, invert and release act on the mask element', async () => {
    const { hud, calls } = await mount(base('mask', { mask: { node: 'm', mode: 'clip', invert: false } }));
    const root = hud.shadowRoot as ShadowRoot;
    (root.querySelector('sf-button[aria-pressed], sf-button:not([slot])') as HTMLElement | null)?.click();
    root.querySelector('sf-menu')?.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'luminance' } }));
    (root.querySelector('sf-icon-button[label="Release"]') as HTMLElement).click();
    expect(calls).toContain('invoke ["instaflow/mask-luminance",["m"]]');
    expect(calls).toContain('invoke ["instaflow/mask-release",["m"]]');
  });

  it('#42: only the pill’s own popovers and menus freeze it; an sf-toggle bubbling from inside one is not counted', async () => {
    const { hud } = await mount(base('shape', { common: 'rectangle', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' } }));
    const frozen: boolean[] = [];
    hud.addEventListener('if-hud-freeze', (e) => frozen.push((e as CustomEvent<{ frozen: boolean }>).detail.frozen));
    const inner = hud.shadowRoot?.querySelector('sf-color-popover') as HTMLElement;
    const popover = inner.closest('sf-popover') as HTMLElement;
    const toggle = (target: HTMLElement, open: boolean): boolean => target.dispatchEvent(new CustomEvent('sf-toggle', { detail: { open }, bubbles: true, composed: true }));
    toggle(inner, true);
    expect(frozen).toEqual([]);
    toggle(popover, true);
    toggle(inner, false);
    expect(frozen).toEqual([true]);
    toggle(popover, false);
    expect(frozen).toEqual([true, false]);
  });

  it('the fill swatch’s colour popover commits one paint for the selection', async () => {
    const { hud, calls } = await mount(base('shape', { common: 'rectangle', fill: { kind: 'solid', color: '#FF5C39' }, stroke: { kind: 'none' } }));
    const popover = hud.shadowRoot?.querySelector('sf-color-popover') as HTMLElement;
    popover.dispatchEvent(new CustomEvent('sf-change', { detail: { kind: 'color', hex: '#3d5afe', opacity: 1 }, bubbles: true }));
    popover.dispatchEvent(new CustomEvent('sf-change', { detail: { kind: 'token', token: 'primary' }, bubbles: true }));
    expect(calls).toEqual(['setPaint ["fills","#3D5AFE","Fill"]', 'setPaint ["fills","@primary","Fill"]']);
  });

  it('text controls: size, bold, align and font run the typography port', async () => {
    const { hud, calls } = await mount(base('text', { common: 'text' }));
    const root = hud.shadowRoot as ShadowRoot;
    root.querySelector('sf-number-field')?.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 48, delta: 0, source: 'type' } }));
    (root.querySelector('sf-icon-button[label="Bold"]') as HTMLElement).click();
    root.querySelector('sf-menu')?.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'center' } }));
    root.querySelector('sf-font-picker')?.dispatchEvent(new CustomEvent('sf-change', { detail: { family: 'Noto Sans' } }));
    expect(calls).toEqual(['setSize [48]', 'toggleText ["bold"]', 'setTextAlign ["center"]', 'setFont [{"font":"sha256:aa","family":"Noto Sans"}]']);
  });
});

describe('pill helpers', () => {
  it('paintFromColor: hex upper-cased, alpha as 8-digit hex, tokens as @name', () => {
    expect(paintFromColor({ kind: 'color', hex: '#ff5c39', opacity: 1 })).toBe('#FF5C39');
    expect(paintFromColor({ kind: 'color', hex: '#ff5c39', opacity: 0.5 })).toBe('#FF5C3980');
    expect(paintFromColor({ kind: 'token', token: 'ink' })).toBe('@ink');
  });

  it('moreMenuGroups: applicable actions not in the pill, grouped in the spec’s order; unknown and excluded ids dropped', () => {
    const actions = new Map(
      ['instaflow/flip-horizontal', 'instaflow/group', 'instaflow/repeat-radial', 'instaflow/rename', 'instaflow/delete'].map((id) => [id, { id, title: id }]),
    );
    const summary = base('shape', { actions: ['instaflow/delete', 'instaflow/repeat-radial', 'instaflow/flip-horizontal', 'instaflow/group', 'instaflow/rename', 'instaflow/unknown'] });
    const pill = pillCapabilities(hudControls(CONTROL_SETS.shape));
    expect(moreMenuGroups(summary, pill, actions).map(([g, list]) => [g, list.map((a) => a.id)])).toEqual([
      ['Arrange', ['instaflow/group']],
      ['Transform', ['instaflow/flip-horizontal']],
      ['Repeat', ['instaflow/repeat-radial']],
    ]);
  });

  it('moreMenuGroups: Flatten is in More for a group, a repeat and a mask when it applies (#69)', () => {
    const actions = new Map([['instaflow/flatten', { id: 'instaflow/flatten', title: 'Flatten' }]]);
    for (const kind of ['group', 'repeat', 'mask'] as const) {
      const pill = pillCapabilities(hudControls(CONTROL_SETS[kind]));
      expect(moreMenuGroups(base(kind, { actions: ['instaflow/flatten'] }), pill, actions).map(([g, list]) => [g, list.map((a) => a.id)]), kind).toEqual([['Combine', ['instaflow/flatten']]]);
    }
  });
});
