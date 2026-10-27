/**
 * `<if-inspector>` (B11b, STUDIO-UX-SPEC §5): the sections of each selection kind in order and nothing else; the
 * Page and Document sections with nothing selected; stacks with opacity, eye, remove, reorder and `+ Add ▾`; the
 * Text section's controls; every control forwarding to the port; Pro pins every section open; the full a11y audit
 * under Clean Pop for every kind.
 */
import type { JsonValue } from '@staticflux/document/v2';
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, type SelectionKind, type SelectionSummary } from '../app/scene-summary.js';
import type { AppearanceModel } from '../elements/inspector.js';
import type { TypographySummary } from '../text/typography.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineInspectorElement, EMPTY_INSPECTOR, type IfInspectorElement, type InspectorModel, type InspectorPort } from './inspector.js';
import { INSPECTOR_SECTIONS } from './inspector-model.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineInspectorElement());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

const summary = (kind: SelectionKind, extra: Partial<SelectionSummary> = {}): SelectionSummary => ({
  ...EMPTY_SELECTION,
  kind,
  nodes: ['a'],
  label: 'Card',
  typeLabel: 'Rectangle',
  actions: ['instaflow/delete'],
  ...extra,
});

const appearance = (extra: Partial<AppearanceModel> = {}): AppearanceModel => ({
  node: 'a',
  fills: [{ paint: '#FF5C39' }, { paint: { kind: 'linear', from: [0, 0.5], to: [1, 0.5], stops: [{ offset: 0, color: '#FF5C39' }, { offset: 1, color: '#FFC93C' }] } }],
  strokes: [{ paint: '#16151A', width: 2, align: 'inside' }],
  effects: [{ kind: 'drop-shadow', x: 0, y: 4, blur: 16, spread: 0, color: '#16151A29' }],
  opacity: 1,
  blend: 'normal',
  radius: 12,
  corners: [null, null, null, null],
  cornersLinked: true,
  smoothing: 0,
  sources: { fills: { arc: 'local' }, strokes: { arc: 'local' }, effects: { arc: 'local' }, radius: { arc: 'local' } },
  tokens: { colors: [], sizes: [], effects: [] },
  ...extra,
});

const TYPO: TypographySummary = { font: { font: 'sha256:aa', family: 'Noto Sans' }, size: 48, weight: 700, bold: true, italic: false, underline: false, color: '#16151A', letterSpacing: 0, align: 'start', lineHeight: 1.1, link: undefined, strike: false, script: undefined, spaceBefore: 0, spaceAfter: 12, indent: 0, box: 'fixed', verticalAlign: 'top', preset: 'Heading 1' };

const MODEL: InspectorModel = {
  ...EMPTY_INSPECTOR,
  page: { id: 'p1', name: 'Page 1', width: 1080, height: 1350 },
  title: 'Night Market Flyer',
  pages: 3,
  pageFill: { ...appearance({ node: 'p1', fills: [{ paint: '#FFFFFF' }], strokes: [], effects: [] }) },
  transform: { nodes: ['a'], x: 10, y: 20, w: 200, h: 100, rotation: 0, skew: 0, flipX: false, flipY: false, locked: 0, transforming: false },
  fonts: [{ label: 'Noto Sans', value: { font: 'sha256:aa', family: 'Noto Sans' } }],
};

async function mount(model: InspectorModel, density = 'standard'): Promise<{ el: IfInspectorElement; root: ShadowRoot; calls: string[] }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const testRoot = mountTestRoot({ units: [] });
  dispose = () => testRoot.dispose();
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push(`${name} ${JSON.stringify(args.filter((a) => a !== undefined))}`);
  const text = new Proxy({} as InspectorPort['text'], {
    get: (_, key: string) => (...args: unknown[]) => {
      calls.push(`text.${key} ${JSON.stringify(args)}`);
      return { ok: true, value: undefined };
    },
  });
  const port: InspectorPort = {
    invoke: log('invoke'),
    setPaint: log('setPaint'),
    setProp: log('setProp'),
    setFont: log('setFont'),
    setSize: log('setSize'),
    setTextColor: log('setTextColor'),
    toggleText: log('toggleText'),
    setTextAlign: log('setTextAlign'),
    setImageFit: log('setImageFit'),
    setRepeat: log('setRepeat'),
    command: log('command'),
    appearance: log('appearance'),
    pageAppearance: log('pageAppearance'),
    transform: log('transform'),
    transformSession: log('transformSession'),
    repeat: log('repeat'),
    text,
    renamePage: log('renamePage'),
    resizePage: log('resizePage'),
    renameTitle: log('renameTitle'),
    replaceImage: log('replaceImage'),
    imageFill: log('imageFill'),
  };
  render(html`<if-inspector .model=${model} .port=${port} density=${density}></if-inspector>`, testRoot.container);
  await settle(8);
  const el = testRoot.container.querySelector('if-inspector') as IfInspectorElement;
  return { el, root: el.shadowRoot as ShadowRoot, calls };
}

const sections = (root: ShadowRoot): string[] => [...root.querySelectorAll('section[data-section]')].map((s) => s.getAttribute('data-section') ?? '');
const field = (root: ParentNode, label: string): HTMLElement => {
  const el = [...root.querySelectorAll<HTMLElement>('sf-number-field, sf-text-field')].find((f) => f.getAttribute('label') === label);
  if (el === undefined) throw new Error(`no field ${label}`);
  return el;
};
const change = (el: Element, detail: unknown): boolean => el.dispatchEvent(new CustomEvent('sf-change', { detail, bubbles: true, composed: true }));
const button = (root: ParentNode, label: string): HTMLElement => {
  const el = [...root.querySelectorAll<HTMLElement>('sf-icon-button, sf-button')].find((b) => b.getAttribute('label') === label || b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  if (el === undefined) throw new Error(`no button ${label}`);
  return el;
};
const select = (root: ParentNode, label: string, value: string): void => {
  const menu = [...root.querySelectorAll('sf-menu')].find((m) => m.getAttribute('label') === label);
  if (menu === undefined) throw new Error(`no menu ${label}`);
  menu.dispatchEvent(new CustomEvent('sf-select', { detail: { value } }));
};

describe('<if-inspector> sections per kind (§5.1)', () => {
  it('nothing selected: Page (name, size preset, the size field, Background stack) and Document (title, pages, units)', async () => {
    const { root, calls } = await mount(MODEL);
    expect(root.querySelector('header')?.textContent).toContain('Page 1');
    expect(sections(root)).toEqual(['page', 'document']);
    change(field(root, 'Page name'), { value: 'Cover' });
    select(root, 'Size preset', 'story');
    // B11c: Page › Size is the kit's size field (1…16 384 px, units, keep proportions, orientation).
    const size = root.querySelector('sf-size-field.page-size') as HTMLElement & { min: number; max: number };
    expect([size.min, size.max]).toEqual([1, 16_384]);
    change(size, { width: 1200, height: 1350, unit: 'px' });
    change(size, { width: 1350, height: 1080, unit: 'px' }); // the orientation switch swaps the sides
    change(size, { width: 1080, height: 1350, unit: 'mm' }); // a unit change alone writes nothing
    change(field(root, 'Title'), { value: 'Spring sale' });
    expect(root.querySelector('section[data-section="document"]')?.textContent).toMatch(/Pages\s*3/);
    expect(calls).toEqual(['renamePage ["Cover"]', 'resizePage [1080,1920]', 'resizePage [1200,1350]', 'resizePage [1350,1080]', 'renameTitle ["Spring sale"]']);
    // The Background is a fill stack on the page (B12 A-1): the eye hides it as one page edit.
    button(root, 'Hide background').click();
    expect(calls.at(-1)).toBe('pageAppearance [{"op":"toggle","stack":"fills","index":0}]');
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('B11c image fills: the fill swatch’s tabs Solid · Gradient · Image; Image chooses a workspace image or uploads; `+ Add ▾ › Image…`; image rows have Fit and the crop', async () => {
    const images = [{ asset: 'as_photo', title: 'Photo' }, { asset: 'as_logo', title: 'Logo', thumb: 'blob:logo' }];
    const { el, root, calls } = await mount({ ...MODEL, images, selection: summary('shape', { common: 'rectangle' }), appearance: appearance({ fills: [{ paint: '#FF5C39' }] }) });
    const fill = root.querySelector('section[data-section="fill"]') as HTMLElement;
    const tabs = fill.querySelector('sf-segmented.paint-tabs') as HTMLElement & { value: string };
    expect(tabs.value).toBe('solid');
    // R13.52: the Solid tab's contrast tag compares against the page's solid Background.
    expect(fill.querySelector('sf-color-popover')?.getAttribute('contrast-with')).toBe('#FFFFFF');
    change(tabs, { value: 'image' });
    await el.updateComplete;
    const choices = [...fill.querySelectorAll<HTMLButtonElement>('.paint-popover button.image-choice')];
    expect(choices.map((b) => b.getAttribute('aria-label'))).toEqual(['Use Photo', 'Use Logo']);
    expect(fill.querySelector('.paint-popover img')?.getAttribute('src')).toBe('blob:logo');
    choices[1]?.click();
    expect(calls.at(-1)).toBe('imageFill ["selection",{"asset":"as_logo"},0]');
    // + Add ▾ › Image…: the chooser popover beside the menu; Upload… asks for a file.
    select(fill, 'Add fill', 'image');
    await el.updateComplete;
    const picker = fill.querySelector('sf-popover.image-picker') as HTMLElement & { open: boolean };
    expect(picker.open).toBe(true);
    (picker.querySelector('sf-button.upload-image') as HTMLElement).click();
    expect(calls.at(-1)).toBe('imageFill ["selection",{"upload":true}]');
    expectNoA11yIssues(root.host as HTMLElement);
    // An image row: thumbnail, Fit (Fill · Fit · Stretch · Tile) and the numeric crop through instaflow/image-crop.
    el.model = { ...el.model, appearance: appearance({ fills: [{ paint: { kind: 'image', asset: { asset: 'as_logo' }, fit: 'cover' } }] }) };
    await el.updateComplete;
    expect(fill.querySelector('.summary')?.textContent).toContain('Image');
    (fill.querySelector('button.summary') as HTMLElement).click();
    await el.updateComplete;
    select(fill, 'Fill fit', 'tile');
    expect(calls.at(-1)).toBe('appearance [{"op":"update","stack":"fills","index":0,"patch":{"paint":{"kind":"image","asset":{"asset":"as_logo"},"fit":"tile"}}}]');
    change(field(fill, 'Fill scale'), { value: 150 });
    expect(calls.at(-1)).toBe('invoke ["instaflow/image-crop",{"crop":{"scale":1.5}}]');
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('B11c the page Background takes an image too (Add ▾ › Image…, the Image tab)', async () => {
    const { el, root, calls } = await mount({ ...MODEL, images: [{ asset: 'as_photo', title: 'Photo' }] });
    const page = root.querySelector('section[data-section="page"]') as HTMLElement;
    change(page.querySelector('sf-segmented.paint-tabs') as HTMLElement, { value: 'image' });
    await el.updateComplete;
    (page.querySelector('.paint-popover button.image-choice') as HTMLElement).click();
    expect(calls.at(-1)).toBe('imageFill ["page",{"asset":"as_photo"},0]');
    const menu = [...page.querySelectorAll('sf-menu')].find((m) => m.getAttribute('label') === 'Add background');
    expect([...(menu?.querySelectorAll(':scope > sf-menu-item') ?? [])].map((i) => i.getAttribute('value'))).toEqual(['colour', 'gradient', 'image']);
  });

  it('a rectangle: Transform, Fill, Stroke, Corners ▸, Effects ▸, Layer ▸; the stack rows edit through the port', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() });
    expect(sections(root)).toEqual(['transform', 'fill', 'stroke', 'corners', 'effects', 'layer']);
    expect([...root.querySelectorAll('sf-disclosure')].filter((d) => (d as HTMLElement & { open: boolean }).open).map((d) => d.getAttribute('heading'))).toEqual(['Transform', 'Fill', 'Stroke']);
    // Rows top first and numbered from the top: Fill 1 is the gradient (painted last), Fill 2 the colour under it.
    const fill = root.querySelector('section[data-section="fill"]') as HTMLElement;
    expect([...fill.querySelectorAll('.summary')].map((s) => s.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Linear · 2 stops · 0°', '#FF5C39']);
    change(field(fill, 'Fill 2 opacity'), { value: 50 });
    button(fill, 'Hide fill 1').click();
    button(fill, 'Remove fill 2').click();
    select(fill, 'Add fill', 'radial');
    change(field(root, 'X'), { value: 40 });
    change(field(root, 'W'), { value: 300 });
    expect(calls).toEqual([
      'appearance [{"op":"update","stack":"fills","index":0,"patch":{"opacity":0.5}}]',
      'appearance [{"op":"toggle","stack":"fills","index":1}]',
      'appearance [{"op":"remove","stack":"fills","index":0}]',
      'appearance [{"op":"add","stack":"fills","item":{"paint":{"kind":"radial","center":[0.5,0.5],"radius":0.5,"stops":[{"offset":0,"color":"#FF5C39"},{"offset":1,"color":"#FF5C3900"}]}}}]',
      'transform [{"field":"x","value":40}]',
      'transform [{"field":"w","value":300}]',
    ]);
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('expanding a row shows its second line: kind, blend and reorder (Alt+↑ moves it up)', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() });
    const fill = root.querySelector('section[data-section="fill"]') as HTMLElement;
    (fill.querySelectorAll('.summary')[1] as HTMLElement).click();
    await settle(2);
    select(fill, 'Fill 2 blend', 'multiply');
    select(fill, 'Fill 2 kind', 'linear');
    button(fill, 'Move up fill 2').click();
    fill.querySelectorAll('.stack-row')[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(calls.slice(0, 2)).toEqual(['appearance [{"op":"update","stack":"fills","index":0,"patch":{"blend":"multiply"}}]', 'appearance [{"op":"update","stack":"fills","index":0,"patch":{"paint":{"kind":"linear","from":[0,0.5],"to":[1,0.5],"stops":[{"offset":0,"color":"#FF5C39"},{"offset":1,"color":"#FF5C3900"}]}}}]']);
    expect(calls.slice(2)).toEqual(['appearance [{"op":"move","stack":"fills","from":0,"to":1}]', 'appearance [{"op":"move","stack":"fills","from":0,"to":1}]']);
  });

  it('text: Style, Font, Weight, Size, Colour, B I U S, Link, Align; More holds spacing, Auto-size, vertical align, scripts, case, clear, Fit to box', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('text', { common: 'text', typeLabel: 'Text' }), typography: TYPO });
    expect(sections(root)).toEqual(['transform', 'text', 'effects', 'layer']);
    const text = root.querySelector('section[data-section="text"]') as HTMLElement;
    select(text, 'Style', 'Body');
    select(text, 'Weight', '500');
    change(field(text, 'Size'), { value: 32 });
    button(text, 'Strikethrough').click();
    button(text, 'Centre').click();
    change(field(text, 'Line height'), { value: 1.4 });
    change(field(text, 'Space after'), { value: 8 });
    button(text, 'Auto width').click();
    button(text, 'Middle').click();
    button(text, 'Superscript').click();
    select(text, 'Convert case', 'upper');
    button(text, 'Clear formatting').click();
    button(text, 'Fit to box').click();
    expect(calls).toEqual([
      'text.applyPreset ["Body"]',
      'text.setWeight [500]',
      'text.setSize [32]',
      'text.toggle ["strike"]',
      'text.setAlign ["center"]',
      'text.setLineHeight [1.4]',
      'text.setParagraph [{"spaceAfter":8}]',
      'text.setBox ["auto-width"]',
      'text.setVerticalAlign ["middle"]',
      'text.setScript ["super"]',
      'text.convertCase ["upper"]',
      'text.clearFormatting []',
      'text.fitToBox []',
    ]);
    expect(text.textContent).toContain('Heading 1');
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('an image: Fit, Replace…, source name; the crop fields run the crop capability', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('image', { common: 'image', fit: 'cover', asset: 'as_1', cropped: true, crop: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } }), imageName: 'market.jpg' });
    expect(sections(root)).toEqual(['transform', 'image', 'effects', 'layer']);
    const image = root.querySelector('section[data-section="image"]') as HTMLElement;
    expect(image.textContent).toContain('market.jpg');
    select(image, 'Fit', 'contain');
    button(image, 'Replace…').click();
    change(field(image, 'Scale'), { value: 150 });
    button(image, 'Reset crop').click();
    expect(calls).toEqual(['setImageFit ["contain"]', 'replaceImage []', 'invoke ["instaflow/image-crop",{"crop":{"scale":1.5}}]', 'invoke ["instaflow/image-crop-reset"]']);
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('several shapes: one shared Fill row (Mixed) that replaces every top fill; Layer sets every element', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('multi', { nodes: ['a', 'b'], common: 'rectangle', label: '2 selected', typeLabel: '2 selected', fill: { kind: 'mixed' }, stroke: { kind: 'none' }, opacity: 1, blend: 'normal' }) });
    expect(sections(root)).toEqual(['transform', 'fill', 'stroke', 'effects', 'layer']);
    const fill = root.querySelector('section[data-section="fill"]') as HTMLElement;
    expect(fill.textContent).toContain('Mixed fills');
    fill.querySelector('sf-color-popover')?.dispatchEvent(new CustomEvent('sf-change', { detail: { kind: 'color', hex: '#3d5afe', opacity: 1 }, bubbles: true }));
    select(root.querySelector('section[data-section="layer"]') as HTMLElement, 'Layer blend', 'multiply');
    expect(calls).toEqual(['setPaint ["fills","#3D5AFE","Fill"]', 'setProp ["spatial.blend","multiply","Blend"]']);
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('locked: only the locked line and Unlock', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('locked', { locked: true, anyLocked: true }) });
    expect(sections(root)).toEqual(['locked']);
    button(root.querySelector('section') as HTMLElement, 'Unlock').click();
    expect(calls).toEqual(['invoke ["instaflow/lock",{"locked":false}]']);
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('the header renames in place and toggles the lock', async () => {
    const { root, calls } = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() });
    change(root.querySelector('header sf-inline-edit') as HTMLElement, { value: 'Hero card', previous: 'Card' });
    button(root.querySelector('header') as HTMLElement, 'Lock').click();
    expect(calls).toEqual(['invoke ["instaflow/rename",{"name":"Hero card"}]', 'invoke ["instaflow/lock",{"locked":true}]']);
  });

  it('focusName() puts the header name into editing (Mod+Shift+R, F2, the context menu); none for the page', async () => {
    const { el, root } = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() });
    expect(await el.focusName()).toBe(true);
    expect((root.querySelector('header sf-inline-edit') as HTMLElement & { editing: boolean }).editing).toBe(true);
    const page = await mount(MODEL);
    expect(await page.el.focusName()).toBe(false);
  });

  it.each(Object.keys(INSPECTOR_SECTIONS) as SelectionKind[])('%s: renders exactly its sections and passes the audit', async (kind) => {
    const extra: Partial<SelectionSummary> = {
      repeat: { kind: 'radial', count: 6 },
      mask: { node: 'm', mode: 'alpha', invert: false },
      booleanOp: 'subtract',
      fill: { kind: 'solid', color: '#FF5C39' },
      stroke: { kind: 'none' },
      common: kind === 'frame' ? 'frame' : kind === 'image' ? 'image' : 'rectangle',
      clip: true,
    };
    const model: InspectorModel = {
      ...MODEL,
      selection: kind === 'none' ? undefined : summary(kind, extra),
      appearance: kind === 'none' || kind === 'multi' || kind === 'mixed' ? undefined : appearance(),
      typography: TYPO,
      repeat: { node: 'a', params: { kind: 'radial', count: 6, radius: 120, startAngle: 0, sweep: 360, rotate: true } as never, instances: 6, fields: ['count', 'radius', 'startAngle', 'sweep', 'rotate'], kinds: ['radial', 'grid', 'mirror'], limits: {} as never },
    };
    const { root } = await mount(model);
    const expected = INSPECTOR_SECTIONS[kind].map((s) => s.id).filter((id) => id !== 'corners' || ['rectangle', 'frame', 'image'].includes(String(extra.common)));
    expect(sections(root)).toEqual(expected);
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('Pro pins every section open (no toggles) and opens every row', async () => {
    const { root } = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() }, 'pro');
    const disclosures = [...root.querySelectorAll('sf-disclosure')] as (HTMLElement & { pinned: boolean })[];
    expect(disclosures.length).toBeGreaterThan(0);
    expect(disclosures.every((d) => d.pinned)).toBe(true);
    expect(root.querySelectorAll('.second').length).toBe(4); // two fills, one stroke, one effect
    expectNoA11yIssues(root.host as HTMLElement);
  });

  it('collapsed sections remember their state on this device; reveal() opens one', async () => {
    const first = await mount({ ...MODEL, selection: summary('shape', { common: 'rectangle' }), appearance: appearance() });
    const effects = first.root.querySelector('section[data-section="effects"] sf-disclosure') as HTMLElement & { open: boolean };
    expect(effects.open).toBe(false);
    expect(effects.getAttribute('summary')).toBe('Shadow · 0 4 16 · 16 %');
    expect(await first.el.reveal('effects')).toBe(true);
    expect(JSON.parse(localStorage.getItem('instaflow/ui/inspector-sections') ?? '{}')).toEqual({ effects: true });
    const v: JsonValue = JSON.parse(localStorage.getItem('instaflow/ui/inspector-sections') ?? '{}');
    expect(v).toBeTruthy();
  });
});
