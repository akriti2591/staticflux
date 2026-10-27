import { createScope, err, ok, type Result, unit } from '@staticflux/core';
import { createMemoryDocumentStore, type DocumentHead, HeadConflictError } from '@staticflux/document/v2';
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { bootHome } from './boot.js';
import { HOME_QUICK_ACTIONS } from './capabilities.js';
import { defineHome, type IfHomeElement, isPlainActivation } from './home-element.js';
import { HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex, withHomeIndex } from './index-record.js';
import { relativeTime } from './messages.js';
import { createHomeModel, type HomeIndexSource } from './model.js';
import { HomeModelToken } from './tokens.js';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const entry = (asset: string, kind: HomeEntry['kind'], title: string, editedAt: string, extra: Partial<HomeEntry> = {}): HomeEntry => ({
  asset,
  kind,
  title,
  createdAt: '2026-10-01T00:00:00.000Z',
  editedAt,
  lens: kind === 'image' ? 'pixel' : 'layout',
  ...extra,
});
const INDEX: HomeIndex = {
  schema: HOME_INDEX_SCHEMA,
  entries: [
    entry('as_flyer', 'composition', 'Night Market Flyer', '2026-10-25T11:58:00.000Z', { format: { width: 1080, height: 1350 } }),
    entry('as_menu', 'composition', 'Spring menu', '2026-10-24T09:00:00.000Z'),
    entry('as_tpl', 'template', 'Promo template', '2026-10-20T09:00:00.000Z'),
    entry('as_img', 'image', 'Lantern photo', '2026-10-19T09:00:00.000Z'),
  ],
};

/** Every element in the composed tree (light DOM + open shadow roots). */
function deepAll(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot !== null) out.push(...deepAll(el.shadowRoot, selector));
  return out;
}

describe('<if-home>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineHome());
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  async function mount(source: HomeIndexSource = { read: async () => ok(INDEX) }) {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const went: string[] = [];
    const controller = new AbortController();
    const model = createHomeModel({ source, host: { navigate: (href) => went.push(href) }, signal: controller.signal });
    const root = mountTestRoot({ units: [unit({ id: 'test/home-model', provides: HomeModelToken, scope: 'app', create: () => model })] });
    dispose = async () => {
      controller.abort();
      await root.dispose();
    };
    render(html`<if-home .now=${NOW}></if-home>`, root.container);
    await settle();
    const host = root.container.querySelector('if-home') as IfHomeElement;
    await host.updateComplete;
    const shadow = host.shadowRoot as ShadowRoot;
    return { host, shadow, model, went, root };
  }

  it('renders the design: top bar, hero, quick actions, recents, templates and files, with no a11y issues', async () => {
    const { shadow, root } = await mount();
    expect(shadow.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Make something bold today');
    expect([...shadow.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Quick actions', 'Jump back in', 'Templates', 'Files']);
    // Sections are named regions (landmarks a screen reader lists).
    expect([...shadow.querySelectorAll('section')].map((s) => s.getAttribute('aria-labelledby'))).toEqual(['hero', 'quick', 'recent', 'templates', 'files']);
    const quick = [...shadow.querySelectorAll('.quick sf-card')];
    expect(quick.map((c) => c.getAttribute('href'))).toEqual(['/new?format=post', '/new?format=story', '/new?format=landscape', '/new?format=slides', '/new?format=poster', '/new?format=letter', '/new?format=carousel']);
    // B11b: the hero's format row (HOME-FILES §1.2) and Custom….
    expect([...shadow.querySelectorAll('.formats sf-button')].map((b) => b.getAttribute('data-format'))).toEqual(['post', 'story', 'landscape', 'slides', 'poster', 'letter', 'custom']);
    expect(quick.map((c) => c.getAttribute('data-action'))).toEqual(HOME_QUICK_ACTIONS.map((a) => a.id));
    const recents = [...shadow.querySelectorAll('section[aria-labelledby="recent"] sf-card')];
    expect(recents.map((c) => [c.getAttribute('data-asset'), c.getAttribute('href')])).toEqual([
      ['as_flyer', '/s/as_flyer'],
      ['as_menu', '/s/as_menu'],
    ]);
    expect(recents[0]?.textContent?.replace(/\s+/g, ' ')).toContain('Night Market Flyer');
    expect(recents[0]?.textContent).toContain('Edited 2 minutes ago · 1080 × 1350');
    const templates = [...shadow.querySelectorAll('section[aria-labelledby="templates"] sf-card')];
    expect(templates.map((c) => c.getAttribute('href'))).toEqual(['/new?template=as_tpl']);
    const files = [...shadow.querySelectorAll('.file')];
    expect(files.map((f) => f.getAttribute('data-asset'))).toEqual(['as_flyer', 'as_menu', 'as_tpl', 'as_img']);
    expect(files.map((f) => f.querySelector('a')?.getAttribute('href') ?? null)).toEqual(['/s/as_flyer', '/s/as_menu', '/new?template=as_tpl', null]);
    expect(files.map((f) => f.querySelector('sf-tag')?.textContent)).toEqual(['Design', 'Design', 'Template', 'Media']);
    expect(auditA11y(root.container)).toEqual([]);
  });

  it('keyboard: every action is one native focusable control (links and buttons, no positive tabindex)', async () => {
    const { shadow, root } = await mount();
    const links = deepAll(root.container, 'a[href]');
    // logo + 7 quick actions + 2 recents + 1 template + 3 linked files
    expect(links).toHaveLength(14);
    expect(deepAll(root.container, '[tabindex]').filter((el) => Number(el.getAttribute('tabindex')) > 0)).toEqual([]);
    const buttons = [...shadow.querySelectorAll('header sf-button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['＋ New design']);
    expect(shadow.querySelector('header sf-icon-button')?.getAttribute('label')).toBe('New design formats');
    expect(buttons[0]?.getAttribute('role')).toBe('button');
  });

  it('a plain click (or Enter on the link) runs the capability; a modified click is left to the browser', async () => {
    const { shadow, went } = await mount();
    const card = shadow.querySelector('section[aria-labelledby="recent"] sf-card') as HTMLElement;
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    card.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    await settle();
    expect(went).toEqual(['/s/as_flyer']);
    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    card.dispatchEvent(newTab);
    expect(newTab.defaultPrevented).toBe(false);
    (shadow.querySelector('.quick sf-card') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    (shadow.querySelector('.formats sf-button[data-format="story"]') as HTMLElement).click();
    (shadow.querySelector('.file a') as HTMLElement).click();
    await settle();
    expect(went).toEqual(['/s/as_flyer', '/new?format=post', '/new?format=story', '/s/as_flyer']);
    expect(isPlainActivation(new MouseEvent('click', { button: 1 }))).toBe(false);
    expect(isPlainActivation(new MouseEvent('click', { button: 0, metaKey: true }))).toBe(false);
  });

  it('New design opens the dialog; Create runs the capability with the custom size; the ▾ menu starts a format or Custom size…', async () => {
    const { shadow, went, root } = await mount();
    (shadow.querySelector('header sf-button.new-design') as HTMLElement).click();
    await settle(4);
    const dialog = shadow.querySelector('if-new-design') as HTMLElement & { open: boolean };
    expect(dialog.open).toBe(true);
    expect(auditA11y(root.container)).toEqual([]);
    const size = dialog.shadowRoot?.querySelector('sf-size-field') as HTMLElement;
    size.dispatchEvent(new CustomEvent('sf-change', { detail: { width: 1500, height: 500, unit: 'px' } }));
    await settle(2);
    (dialog.shadowRoot?.querySelector('footer sf-button[variant="primary"]') as HTMLElement).click();
    await settle();
    expect(went).toEqual(['/new?format=custom&w=1500&h=500']);
    expect(dialog.open).toBe(false);
    const menu = shadow.querySelector('header sf-menu') as HTMLElement;
    menu.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'landscape' } }));
    await settle();
    expect(went.at(-1)).toBe('/new?format=landscape');
    menu.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'custom' } }));
    await settle(4);
    expect(dialog.open).toBe(true);
    expect(dialog.shadowRoot?.querySelector('.chip[aria-checked="true"]')?.getAttribute('data-format')).toBe('custom');
  });

  it('speaks a failed action in the polite live region', async () => {
    const { host, shadow, model } = await mount();
    const status = shadow.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;
    // A design deleted in another tab: the card is still on screen, the capability refuses it.
    expect(model.index.entries).toHaveLength(4);
    const run = (host as unknown as { run(a: () => Promise<Result<unknown>>, t: string): Promise<void> }).run.bind(host);
    await run(() => model.open('as_gone'), 'Gone');
    await host.updateComplete;
    expect(status.textContent).toContain('no design with this asset id');
  });

  it('empty workspace: says how to start, still no a11y issues', async () => {
    const { shadow, root } = await mount({ read: async () => ok({ schema: HOME_INDEX_SCHEMA, entries: [] }) });
    const texts = [...shadow.querySelectorAll('.empty')].map((p) => p.textContent);
    expect(texts).toEqual([
      'No designs yet. Choose New design or a quick action to start one.',
      'No templates yet. In Studio, choose “Save as template” to make one from a design.',
      'Your designs, templates and imported media appear here.',
    ]);
    expect(auditA11y(root.container)).toEqual([]);
  });

  it('a failed read shows an alert with "Try again", which reads again', async () => {
    let calls = 0;
    const { host, shadow, root } = await mount({ read: async () => ((calls += 1) === 1 ? err(HeadConflictError({ message: 'blocked' })) : ok(INDEX)) });
    const alert = shadow.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Home could not read your workspace: blocked');
    expect(auditA11y(root.container)).toEqual([]);
    (alert.querySelector('sf-button') as HTMLElement).click();
    await settle();
    await host.updateComplete;
    expect(shadow.querySelector('[role="alert"]')).toBeNull();
    expect(shadow.querySelectorAll('section[aria-labelledby="recent"] sf-card')).toHaveLength(2);
  });

  it('loading: the main region is busy and says so', async () => {
    const { shadow } = await mount({ read: () => new Promise(() => undefined) });
    expect(shadow.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(shadow.querySelector('main [role="status"]')?.textContent).toBe('Loading your workspace…');
  });
});

describe('bootHome', () => {
  it('renders Home over a workspace store and reads again when the tab becomes visible', async () => {
    const store = createMemoryDocumentStore();
    const signal = new AbortController().signal;
    const container = document.createElement('div');
    document.body.append(container);
    const scope = createScope('home-boot-test');
    const went: string[] = [];
    const booted = await bootHome({ container, scope, store, host: { navigate: (h) => went.push(h) } });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    await settle();
    expect(booted.value.model.state).toBe('ready');
    expect(booted.value.model.recents()).toEqual([]);
    expect(document.head.querySelector('style')?.textContent).toContain('--sf-color-accent');
    const base: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    const head = withHomeIndex(base, INDEX);
    expect((await store.writeHead('library', head, null, signal)).ok).toBe(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    await settle();
    expect(booted.value.model.recents().map((e) => e.asset)).toEqual(['as_flyer', 'as_menu']);
    expect(await booted.value.model.newDesign('story')).toEqual(ok({ href: '/new?format=story' }));
    expect(went).toEqual(['/new?format=story']);
    scope.dispose();
    expect(container.querySelector('if-home')).toBeNull();
    expect(booted.value.model.state).toBe('disposed');
  });
});

describe('relativeTime', () => {
  it('reads like a person would say it (Intl, numeric auto)', () => {
    expect(relativeTime('2026-10-25T12:00:00.000Z', NOW, 'en')).toBe('now');
    expect(relativeTime('2026-10-25T11:58:00.000Z', NOW, 'en')).toBe('2 minutes ago');
    expect(relativeTime('2026-10-25T09:00:00.000Z', NOW, 'en')).toBe('3 hours ago');
    expect(relativeTime('2026-10-24T09:00:00.000Z', NOW, 'en')).toBe('yesterday');
    expect(relativeTime('2026-10-01T09:00:00.000Z', NOW, 'en')).toBe('3 weeks ago');
    expect(relativeTime('2026-11-01T09:00:00.000Z', NOW, 'en')).toBe('now'); // a clock ahead reads as now
  });
});
