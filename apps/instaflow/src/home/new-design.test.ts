/** B11b slice 5: the New design dialog (HOME-FILES §1.3): the draft rules and the element under Clean Pop. */
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import type { HomeEntry } from './index-record.js';
import {
  chooseFormat,
  defineNewDesign,
  draftRequest,
  type IfNewDesignElement,
  initialDraft,
  NEW_DESIGN_MEMORY_KEY,
  type NewDesignCreateDetail,
  readNewDesignMemory,
  setDraftSize,
  setStartFrom,
  writeNewDesignMemory,
} from './new-design.js';
import { SIZE_PRESET_GROUPS, sizePreset } from './size-presets.js';

const memoryStore = (): Storage => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), clear: () => map.clear(), key: () => null, length: 0 } as Storage;
};

describe('New design draft', () => {
  it('opens on the default format, or this device’s last choice; a format argument wins', () => {
    expect(initialDraft(undefined)).toMatchObject({ format: 'post', size: { width: 1080, height: 1080 }, unit: 'px', name: 'Untitled design', pages: 1 });
    const memory = { format: 'custom' as const, size: { width: 1500, height: 500 }, unit: 'mm' as const };
    expect(initialDraft(memory)).toMatchObject({ format: 'custom', size: { width: 1500, height: 500 }, unit: 'mm' });
    expect(initialDraft(memory, 'story')).toMatchObject({ format: 'story', size: { width: 1080, height: 1920 }, unit: 'mm' });
    expect(initialDraft(memory, 'custom')).toMatchObject({ format: 'custom', size: { width: 1500, height: 500 } });
  });

  it('a chip fills the size and pages; editing the size selects Custom; an unchanged size keeps the chip', () => {
    const slides = chooseFormat(initialDraft(undefined), 'slides');
    expect(slides).toMatchObject({ format: 'slides', size: { width: 1920, height: 1080 }, pages: 5 });
    expect(setDraftSize(slides, { width: 1920, height: 1080 }).format).toBe('slides');
    expect(setDraftSize(slides, { width: 1921, height: 1080 }, 'in')).toMatchObject({ format: 'custom', unit: 'in' });
  });

  it('Start from: Last design and a template set the size (the template wins); back to Blank keeps it', () => {
    const d = initialDraft(undefined);
    const last = setStartFrom(d, { kind: 'last' }, { last: { width: 1080, height: 1920 } });
    expect(last).toMatchObject({ format: 'story', start: { kind: 'last' } });
    const tpl = setStartFrom(d, { kind: 'template', asset: 'as_t' }, { template: () => ({ width: 640, height: 480 }) });
    expect(tpl).toMatchObject({ format: 'custom', size: { width: 640, height: 480 } });
    expect(chooseFormat(tpl, 'post').start).toEqual({ kind: 'blank' });
  });

  it('Create asks for a format, a custom size or a template; defaults are left out', () => {
    expect(draftRequest(initialDraft(undefined))).toEqual({ kind: 'new', input: { format: 'post' } });
    const custom = { ...setDraftSize(initialDraft(undefined), { width: 1500, height: 500 }, 'mm'), name: ' Spring ', pages: 2, background: '#FFEEDD' };
    expect(draftRequest(custom)).toEqual({ kind: 'new', input: { format: 'custom', width: 1500, height: 500, unit: 'mm', pages: 2, name: 'Spring', background: '#ffeedd' } });
    expect(draftRequest({ ...initialDraft(undefined), start: { kind: 'template', asset: 'as_t' }, name: '' })).toEqual({ kind: 'template', template: 'as_t', name: 'Untitled design' });
  });

  it('remembers format, size and unit per device, tolerating bad data', () => {
    const storage = memoryStore();
    expect(readNewDesignMemory(storage)).toBeUndefined();
    writeNewDesignMemory(storage, setDraftSize(initialDraft(undefined), { width: 700, height: 900 }, 'in'));
    expect(readNewDesignMemory(storage)).toEqual({ format: 'custom', size: { width: 700, height: 900 }, unit: 'in' });
    storage.setItem(NEW_DESIGN_MEMORY_KEY, '{"size":{"width":0}}');
    expect(readNewDesignMemory(storage)).toBeUndefined();
    storage.setItem(NEW_DESIGN_MEMORY_KEY, 'not json');
    expect(readNewDesignMemory(storage)).toBeUndefined();
    expect(readNewDesignMemory(undefined)).toBeUndefined();
  });

  it('presets are grouped social, print, screen; A4 is at 96 px per inch', () => {
    expect(SIZE_PRESET_GROUPS.map((g) => g.label)).toEqual(['Social', 'Print', 'Screen']);
    expect(sizePreset('a4')?.size).toEqual({ width: 794, height: 1123 });
    expect(sizePreset('letter')?.size).toEqual({ width: 816, height: 1056 });
    expect(sizePreset('nope')).toBeUndefined();
  });
});

describe('<if-new-design>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineNewDesign());
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  const TEMPLATES: readonly HomeEntry[] = [{ asset: 'as_t', kind: 'template', title: 'Promo', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout', format: { width: 640, height: 480 } }];

  async function mount(): Promise<{ el: IfNewDesignElement; created: NewDesignCreateDetail[]; container: HTMLElement }> {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    const created: NewDesignCreateDetail[] = [];
    render(html`<if-new-design .templates=${TEMPLATES} .last=${{ width: 1080, height: 1920 }} @if-create=${(e: CustomEvent<NewDesignCreateDetail>) => created.push(e.detail)}></if-new-design>`, root.container);
    await settle(4);
    return { el: root.container.querySelector('if-new-design') as IfNewDesignElement, created, container: root.container };
  }

  it('opens as a labelled modal with the format radio group, the size field and the name focused; passes the audit', async () => {
    const { el, container } = await mount();
    await el.show();
    await settle(4);
    expect(el.open).toBe(true);
    const shadow = el.shadowRoot as ShadowRoot;
    expect(shadow.querySelector('dialog')?.getAttribute('aria-labelledby')).toBe('nd-title');
    expect(shadow.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBe('nd-format');
    expect([...shadow.querySelectorAll('.chip')].map((c) => c.getAttribute('data-format'))).toEqual(['post', 'story', 'landscape', 'slides', 'poster', 'letter', 'custom']);
    expect([...shadow.querySelectorAll('select#start option')].map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Blank', 'Last design', 'Promo · 640 × 480']);
    expect(auditA11y(container)).toEqual([]);
  });

  it('arrows move the chip selection; Enter in the name creates; a template locks the size', async () => {
    const { el, created } = await mount();
    await el.show();
    await settle(4);
    const shadow = el.shadowRoot as ShadowRoot;
    const group = shadow.querySelector('[role="radiogroup"]') as HTMLElement;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle(2);
    expect(el.draft.format).toBe('story');
    const select = shadow.querySelector('select#start') as HTMLSelectElement;
    select.value = 'template:as_t';
    select.dispatchEvent(new Event('change'));
    await settle(2);
    expect(shadow.querySelector('sf-size-field')?.hasAttribute('disabled')).toBe(true);
    expect(shadow.textContent).toContain('Uses the template’s size');
    const name = shadow.querySelector('sf-text-field.name') as HTMLElement;
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await settle(2);
    expect(created).toEqual([{ kind: 'template', template: 'as_t', name: 'Untitled design' }]);
    expect(el.open).toBe(false);
  });
});
