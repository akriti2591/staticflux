/**
 * Render check: the kit's button variants (and the switcher, tag and slider) mounted under
 * Clean Pop resolve to the approved recipes (`Components.dc.html` `renderVals()`): pill
 * radius, fills, text colours, the control edge and the 2 px deep-tangerine focus ring.
 * Runs in happy-dom (computed styles through shadow roots and custom properties).
 */
import { defineButton, type SfButtonElement } from '@staticflux/kit/button';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { defineSegmented, type SfSegmentedElement } from '@staticflux/kit/segmented';
import { defineSlider, type SfSliderElement } from '@staticflux/kit/slider';
import { defineTag, type SfTagElement } from '@staticflux/kit/tag';
import { compileTheme, formatHex, parseColor } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopPalette as p, cleanPopTheme } from './clean-pop.js';
import { lensOf, lensTag } from './lenses.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => {
  defineButton();
  defineIconButton();
  defineSegmented();
  defineSlider();
  defineTag();
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(template: unknown): Promise<HTMLElement> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [] });
  dispose = () => root.dispose();
  render(template, root.container);
  await settle();
  return root.container;
}

/** A colour as lower-case `#rrggbb` ('transparent' when fully transparent; unparsable values unchanged). */
function hex(value: string): string {
  const parsed = parseColor(value);
  if (!parsed.ok) return value;
  return parsed.value.a === 0 ? 'transparent' : formatHex(parsed.value);
}

const control = (host: Element): CSSStyleDeclaration => getComputedStyle(host.shadowRoot?.querySelector('.control') as Element);

describe('kit buttons under Clean Pop', () => {
  const variants = [
    { variant: 'primary', background: p.primary, color: p.white },
    { variant: 'agent', background: p.agent, color: p.white },
    { variant: 'agent-soft', background: p.agentSoft, color: p.agentInk },
    { variant: 'secondary', background: p.white, color: p.ink, edge: p.controlEdge },
    { variant: 'ghost', background: 'transparent', color: p.ink },
  ] as const;

  for (const recipe of variants) {
    it(`${recipe.variant}: pill, fill and text colour from the recipe`, async () => {
      const container = await mount(html`<sf-button variant=${recipe.variant}>Share</sf-button>`);
      const style = control(container.querySelector('sf-button') as SfButtonElement);
      expect(style.borderTopLeftRadius).toBe('9999px');
      expect(hex(style.backgroundColor)).toBe(hex(recipe.background));
      expect(hex(style.color)).toBe(hex(recipe.color));
      if ('edge' in recipe) {
        expect(style.borderTopWidth).toBe('1px');
        expect(hex(style.borderTopColor)).toBe(hex(recipe.edge));
      }
    });
  }

  it('sizes 42 / 34 / 28 px at standard density', async () => {
    const container = await mount(html`<sf-button size="lg">L</sf-button><sf-button>M</sf-button><sf-button size="sm">S</sf-button>`);
    const heights = [...container.querySelectorAll('sf-button')].map((b) => control(b).getPropertyValue('min-block-size'));
    expect(heights).toEqual(['42px', '34px', '28px']);
  });

  it('shows a 2 px deep-tangerine focus ring with a 2 px offset on the pill host', async () => {
    const container = await mount(html`<sf-button variant="agent">Send</sf-button>`);
    const button = container.querySelector('sf-button') as SfButtonElement;
    button.focus();
    await settle();
    const style = getComputedStyle(button);
    expect(style.borderTopLeftRadius).toBe('9999px');
    expect(style.outlineWidth).toBe('2px');
    expect(style.outlineStyle).toBe('solid');
    expect(hex(style.outlineColor)).toBe(hex(p.primary));
    expect(style.outlineOffset).toBe('2px');
  });

  it('icon buttons are circles', async () => {
    const container = await mount(html`<sf-icon-button label="Undo" variant="secondary">↶</sf-icon-button>`);
    const style = control(container.querySelector('sf-icon-button') as Element);
    expect(style.borderTopLeftRadius).toBe('9999px');
    expect(hex(style.borderTopColor)).toBe(hex(p.controlEdge));
  });
});

describe('switchers, tags and slider under Clean Pop', () => {
  it('segmented: a mist pill track with the control edge and a white selected pill', async () => {
    const options = [
      { value: 'canvas', label: 'Canvas' },
      { value: 'pixel', label: 'Pixel' },
    ];
    const container = await mount(html`<sf-segmented label="Mode" .options=${options} value="canvas"></sf-segmented>`);
    const segmented = container.querySelector('sf-segmented') as SfSegmentedElement;
    const track = getComputedStyle(segmented.shadowRoot?.querySelector('.track') as Element);
    expect(track.borderTopLeftRadius).toBe('9999px');
    expect(hex(track.backgroundColor)).toBe(hex(p.tint));
    expect(hex(track.borderTopColor)).toBe(hex(p.controlEdge));
    const selected = getComputedStyle(segmented.shadowRoot?.querySelector('[aria-checked="true"]') as Element);
    expect(hex(selected.backgroundColor)).toBe(hex(p.white));
    expect(hex(selected.color)).toBe(hex(p.ink));
    const other = getComputedStyle(segmented.shadowRoot?.querySelector('[aria-checked="false"]') as Element);
    expect(hex(other.color)).toBe(hex(p.muted));
  });

  it('tags: mist, agent and solid lens colours, all pills', async () => {
    const layout = lensTag(lensOf('layout'));
    const video = lensTag(lensOf('video'));
    const container = await mount(
      html`<sf-tag>Brand</sf-tag><sf-tag tone="agent">✦ Claude</sf-tag><sf-tag .color=${layout.color} .ink=${layout.ink}>Layout</sf-tag><sf-tag .color=${video.color} .ink=${video.ink}>Video</sf-tag>`,
    );
    await settle();
    const [neutral, agent, lensLayout, lensVideo] = [...container.querySelectorAll('sf-tag')].map((tag) => getComputedStyle(tag as SfTagElement));
    expect(neutral?.borderTopLeftRadius).toBe('9999px');
    expect(hex(neutral?.backgroundColor ?? '')).toBe(hex(p.tint));
    expect(hex(agent?.backgroundColor ?? '')).toBe(hex(p.agentSoft));
    expect(hex(agent?.color ?? '')).toBe(hex(p.agentInk));
    expect(hex(lensLayout?.backgroundColor ?? '')).toBe(hex('#FF5C39'));
    expect(hex(lensLayout?.color ?? '')).toBe(hex(p.ink));
    expect(hex(lensVideo?.color ?? '')).toBe(hex(p.white));
  });

  it('slider: filled share and the value in a mist mono pill', async () => {
    const container = await mount(html`<sf-slider label="Warmth" min="0" max="50" value="18"></sf-slider>`);
    const slider = container.querySelector('sf-slider') as SfSliderElement;
    const input = slider.shadowRoot?.querySelector('input') as HTMLInputElement;
    expect(input.style.getPropertyValue('--kit-fill')).toBe('36%');
    const value = getComputedStyle(slider.shadowRoot?.querySelector('.value') as Element);
    expect(hex(value.backgroundColor)).toBe(hex(p.tint));
    expect(value.fontFamily).toContain('Geist Mono');
    expect(value.borderTopLeftRadius).toBe('9999px');
  });
});
