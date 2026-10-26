/**
 * The Pages panel: the story in order, keyboard paths (show, reorder with Alt+↑/↓, previous / next /
 * fit all), an accessibility audit under Clean Pop, and the B0 panel contribution.
 */
import { box, unit } from '@staticflux/core';
import type { SfButtonElement } from '@staticflux/kit/button';
import type { SfTreeElement } from '@staticflux/kit/tree';
import { auditA11y, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LensContributionId } from '../spec/contributions.js';
import { createEditorRegistries } from '../spec/registries.js';
import { editDocumentCapability, proposeSpecCapability } from '../spec/capabilities.js';
import { StudioIds, studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { studioSpecFor } from '../spec/studio-spec.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { canvasLensFeature } from './canvas-lens.js';
import { lensContributionUnits, pagesPanel } from './contributions.js';
import { type CameraReason, createLensController } from './controller.js';
import type { Camera } from './lens-feature.js';
import { createLensFeatureRegistry } from './lens-features.js';
import { lensMessages, lensText } from './messages.js';
import { pagesLensFeature } from './pages-lens.js';
import { definePagesPanel, type IfPagesPanelElement, pageNodes, reorderTarget, storyFrames } from './pages-panel.js';
import { createStoryWriter } from './story.js';
import { readCompositionStructure, structureFeed } from './structure.js';
import { LensControllerToken, StoryWriterToken } from './tokens.js';
import { compositionDoc, priya, unwrap } from './test-helpers.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => definePagesPanel());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const frame = (page: string, index: number, name?: string) => ({ page, index, ...(name === undefined ? {} : { name }), rect: { x: 0, y: 0, w: 1080.4, h: 1350 } });

describe('pure helpers', () => {
  it('storyFrames sorts by story index; pageNodes names and sizes rows with the layout lens mark', () => {
    expect(storyFrames([frame('b', 1), frame('a', 0)]).map((f) => f.page)).toEqual(['a', 'b']);
    const nodes = pageNodes([frame('b', 1), frame('a', 0, 'Cover')], (f) => f.name ?? `Page ${f.index + 1}`);
    expect(nodes.map((n) => [n.id, n.label, n.badge])).toEqual([
      ['a', 'Cover', '1080×1350'],
      ['b', 'Page 2', '1080×1350'],
    ]);
  });

  it('reorderTarget turns a drop into the story index of the list without the moved page', () => {
    const order = ['p1', 'p2', 'p3'];
    expect(reorderTarget(order, { id: 'p3', targetId: 'p1', position: 'before' })).toBe(0);
    expect(reorderTarget(order, { id: 'p1', targetId: 'p2', position: 'after' })).toBe(1);
    expect(reorderTarget(order, { id: 'p1', targetId: 'p3', position: 'after' })).toBe(2);
    expect(reorderTarget(order, { id: 'p1', targetId: 'p2', position: 'inside' })).toBeUndefined();
    expect(reorderTarget(order, { id: 'p1', targetId: 'p1', position: 'before' })).toBeUndefined();
    expect(reorderTarget(order, { id: 'p1', targetId: 'zz', position: 'before' })).toBeUndefined();
  });

  it('lensText formats with params and falls back to the source text', () => {
    expect(lensText(undefined, lensMessages.showing, { number: 2, count: 5, name: 'Cover' })).toBe('Page 2 of 5: Cover');
    expect(lensText(undefined, lensMessages.overview)).toBe('Fit all');
  });
});

async function mount() {
  const { doc, root } = await compositionDoc([{ id: 'p1', name: 'Cover' }, { id: 'p2' }, { id: 'p3', name: 'Offer' }]);
  const lens = box<LensContributionId | undefined>(StudioIds.lens.pages);
  const shown: [Camera, CameraReason][] = [];
  const features = unwrap(createLensFeatureRegistry([pagesLensFeature, canvasLensFeature]));
  const controller = createLensController({ features, lens: () => lens.get(), structure: structureFeed(root), viewport: () => ({ width: 1000, height: 800 }), camera: { show: (c, r) => shown.push([c, r]) } });
  const story = createStoryWriter({ doc, structure: () => readCompositionStructure(root), actor: () => priya });
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const testRoot = mountTestRoot({
    units: [
      unit({ id: 'test/lens-controller', provides: LensControllerToken, scope: 'app', create: () => controller }),
      unit({ id: 'test/story-writer', provides: StoryWriterToken, scope: 'app', create: () => story }),
    ],
  });
  dispose = () => testRoot.dispose();
  render(html`<if-pages-panel></if-pages-panel>`, testRoot.container);
  await settle();
  const panel = testRoot.container.querySelector('if-pages-panel') as IfPagesPanelElement;
  await panel.updateComplete;
  const shadow = panel.shadowRoot as ShadowRoot;
  const q = <T extends Element>(selector: string): T => shadow.querySelector(selector) as T;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
      await panel.updateComplete;
    }
  };
  const tree = async () => {
    const host = q<SfTreeElement>('sf-tree');
    await host.updateComplete;
    return host.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
  };
  const announced = (): string => q<HTMLElement>('[role="status"]').textContent ?? '';
  return { doc, root, controller, shown, panel, q, flush, tree, announced, lens };
}

describe('<if-pages-panel>', () => {
  it('lists the story with kit components only and passes the a11y audit', async () => {
    const { panel } = await mount();
    const root = panel.shadowRoot as ShadowRoot;
    const custom = new Set([...root.querySelectorAll('*')].map((e) => e.localName).filter((n) => n.includes('-')));
    expect(custom).toEqual(new Set(['sf-tree', 'sf-toolbar', 'sf-button']));
    expect([...root.querySelectorAll('sf-button')].map((b) => (b as SfButtonElement).variant)).toEqual(['secondary', 'secondary', 'ghost']);
    expect(auditA11y(panel.parentElement as HTMLElement)).toEqual([]);
  });

  it('keyboard: arrows show each page, Alt+↓ moves it in the story, the toolbar steps and fits all', async () => {
    const { controller, shown, tree, flush, announced, root, q } = await mount();
    const node = await tree();
    node.focus();
    press(node, 'ArrowDown');
    await flush();
    expect(controller.current()).toBeDefined();
    press(node, 'Home');
    await flush();
    expect(controller.current()).toBe('p1');
    expect(announced()).toBe('Page 1 of 3: Cover');
    expect(shown.at(-1)?.[1]).toBe('focus');
    press(node, 'Enter');
    await flush();
    press(node, 'ArrowDown', { alt: true });
    await flush();
    expect(unwrap(readCompositionStructure(root)).pages.map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
    expect(announced()).toBe('Moved “Cover” to position 2');
    q<SfButtonElement>('sf-button.next').click();
    await flush();
    expect(controller.current()).toBe('p3');
    q<SfButtonElement>('sf-button.previous').click();
    await flush();
    expect(controller.current()).toBe('p1');
    q<SfButtonElement>('sf-button.overview').click();
    await flush();
    expect(shown.at(-1)?.[1]).toBe('overview');
  });

  it('shows an empty state without pages or without a composition', async () => {
    const { doc, flush, q, controller } = await mount();
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'x' }, { root: ['p1', 'p2', 'p3'].map((node) => ({ op: 'delete' as const, node })) }));
    await flush();
    expect(q<HTMLElement>('.empty').textContent).toBe('This document has no pages yet.');
    expect(q<SfButtonElement>('sf-button.next').disabled).toBe(true);
    expect(controller.step(1).ok).toBe(false);
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'x' }, { root: [{ op: 'delete', node: 'comp' }] }));
    await flush();
    expect(q<HTMLElement>('.empty').textContent).toBe('Pages appear here for compositions.');
  });
});

describe('lens contributions', () => {
  it('the Pages panel replaces B0’s placeholder; the Pages lens has its own toolbar, HUD and spec', () => {
    expect(pagesPanel.id).toBe(StudioIds.panel.pages);
    expect(lensContributionUnits).toHaveLength(1);
    const panels = [...studioPanels.filter((p) => p.id !== StudioIds.panel.pages), pagesPanel];
    const registries = unwrap(createEditorRegistries({ lenses: studioLenses, tools: studioTools, panels, hud: studioHudActions, capabilities: [proposeSpecCapability, editDocumentCapability] }));
    expect(registries.lens(StudioIds.lens.pages)).toMatchObject({ label: 'Pages', palette: 'layout', shortcut: '5' });
    const spec = studioSpecFor(StudioIds.lens.pages);
    const T = StudioIds.tool;
    expect(spec.tools).toEqual([T.select, T.shape, T.ellipse, T.polygon, T.star, T.line, T.text, T.hand]); // B11b: no Pen yet, the shape family
    expect(spec.hud).toEqual([]); // B11b: no assistant or motion actions before they run
    const body = pagesPanel.render({ density: 'pro', lens: StudioIds.lens.pages, scope: 'asset' }) as { strings: readonly string[] };
    expect(body.strings.join('')).toContain('<if-pages-panel>');
  });
});
