import { createScope, err, ok, type Result, unit } from '@staticflux/core';
import { createMemoryDocumentStore, type DocumentHead, HeadConflictError } from '@staticflux/document/v2';
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Toasts, ToastsToken } from '../app/feedback.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { bootHome } from './boot.js';
import { HOME_QUICK_ACTIONS } from './capabilities.js';
import { FIRST_RUN_KEY, type StoragePort } from './first-run.js';
import { ASSETS_DRAG_TYPE, defineHome, fileActions, type IfHomeElement, isPlainActivation } from './home-element.js';
import { HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex, withHomeIndex } from './index-record.js';
import { relativeTime } from './messages.js';
import { createHomeModel, type HomeImporter, type HomeIndexSource, type HomeModel, storeIndexSource, storeJournalWriter } from './model.js';
import type { HomeView } from './routes.js';
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
    entry('as_flyer', 'composition', 'Night Market Flyer', '2026-10-25T11:58:00.000Z', { format: { width: 1080, height: 1350 }, pages: 3 }),
    entry('as_menu', 'composition', 'Spring menu', '2026-10-24T09:00:00.000Z', { folder: 'Spring campaign' }),
    entry('as_tpl', 'template', 'Promo template', '2026-10-20T09:00:00.000Z'),
    entry('as_img', 'image', 'Lantern photo', '2026-10-19T09:00:00.000Z', { mime: 'image/png', size: 10, digest: 'sha256:aa' }),
    entry('as_old', 'composition', 'Old poster', '2026-10-10T09:00:00.000Z', { trashedAt: '2026-10-24T08:00:00.000Z' }),
  ],
};
const LIBRARY_HEAD: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };

/** Every element in the composed tree (light DOM + open shadow roots). */
function deepAll(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot !== null) out.push(...deepAll(el.shadowRoot, selector));
  return out;
}

/** Records toasts; `undoNewest` runs the newest Undo like the real one. */
function fakeToasts() {
  const shown: { message: string; tone?: string; action?: string }[] = [];
  const undos: (() => void)[] = [];
  const handle = { dismiss: () => undefined } as never;
  const toasts: Toasts = {
    show: (r) => (shown.push({ message: r.message, ...(r.tone === undefined ? {} : { tone: r.tone }), ...(r.action === undefined ? {} : { action: r.action.label }) }), handle),
    undoable: (r) => {
      shown.push({ message: r.message, action: 'Undo' });
      undos.push(r.undo);
      return handle;
    },
    error: (e) => (shown.push({ message: e.message, tone: 'danger' }), handle),
    undoNewest: () => {
      const undo = undos.pop();
      undo?.();
      return undo !== undefined;
    },
  };
  return { toasts, shown };
}

const persistence = (granted: boolean): StoragePort & { asked: number } => {
  const port = { asked: 0, estimate: async () => ({ usage: 1_234_567_890, quota: 10e9 }), persisted: async () => false, persist: async () => ((port.asked += 1), granted) };
  return port;
};

describe('<if-home>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineHome());
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(FIRST_RUN_KEY, 'seen');
  });
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  interface Mounted {
    readonly host: IfHomeElement;
    readonly shadow: ShadowRoot;
    readonly model: HomeModel;
    readonly went: string[];
    readonly pushed: string[];
    readonly shown: ReturnType<typeof fakeToasts>['shown'];
    readonly root: ReturnType<typeof mountTestRoot>;
  }

  async function mount(options: { index?: HomeIndex; source?: HomeIndexSource; storage?: StoragePort | null; importer?: HomeImporter; view?: HomeView } = {}): Promise<Mounted> {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const store = createMemoryDocumentStore();
    const signal = new AbortController().signal;
    expect((await store.writeHead('library', withHomeIndex(LIBRARY_HEAD, options.index ?? INDEX), null, signal)).ok).toBe(true);
    const went: string[] = [];
    const pushed: string[] = [];
    const controller = new AbortController();
    let ids = 0;
    const model = createHomeModel({
      source: options.source ?? storeIndexSource(store),
      journal: storeJournalWriter(store),
      ...(options.importer === undefined ? {} : { importer: async () => options.importer as HomeImporter }),
      host: { navigate: (href) => went.push(href), push: (href) => pushed.push(href) },
      signal: controller.signal,
      now: () => NOW,
      newAssetId: () => `as_new${(ids += 1)}`,
      ...(options.view === undefined ? {} : { view: options.view }),
    });
    const { toasts, shown } = fakeToasts();
    const root = mountTestRoot({
      units: [unit({ id: 'test/home-model', provides: HomeModelToken, scope: 'app', create: () => model }), unit({ id: 'test/toasts', provides: ToastsToken, scope: 'app', create: () => toasts })],
    });
    dispose = async () => {
      controller.abort();
      await root.dispose();
    };
    render(html`<if-home .now=${NOW} .storage=${options.storage === undefined ? null : options.storage}></if-home>`, root.container);
    await settle(3);
    const host = root.container.querySelector('if-home') as IfHomeElement;
    await host.updateComplete;
    const shadow = host.shadowRoot as ShadowRoot;
    return { host, shadow, model, went, pushed, shown, root };
  }

  const again = async (host: IfHomeElement, n = 3): Promise<void> => {
    await settle(n);
    await host.updateComplete;
  };
  const card = (shadow: ShadowRoot, asset: string): HTMLElement => shadow.querySelector(`[data-asset="${asset}"]`) as HTMLElement;
  const menuValues = (shadow: ShadowRoot): string[] => [...shadow.querySelectorAll('sf-menu.file-menu > sf-menu-item')].map((i) => i.getAttribute('value') as string);
  const pick = async (host: IfHomeElement, value: string): Promise<void> => {
    (host.shadowRoot?.querySelector('sf-menu.file-menu') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value, checked: undefined } }));
    await again(host);
  };
  const openMenu = async (host: IfHomeElement, asset: string): Promise<void> => {
    (card(host.shadowRoot as ShadowRoot, asset).querySelector('sf-icon-button.more') as HTMLElement).click();
    await again(host);
  };

  it('renders Home: header (logo, nav, search, New design), hero, quick actions, recents, templates and projects, with no a11y issues', async () => {
    const { shadow, root } = await mount({ storage: persistence(true) });
    expect(shadow.querySelector('a.brand')?.getAttribute('aria-label')).toBe('Instaflow, go to Home');
    expect(shadow.querySelector('a.brand svg[data-if-mark]')).not.toBeNull();
    expect([...shadow.querySelectorAll('nav .nav a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['Home', '/', 'page'],
      ['Files', '/files', null],
      ['Templates', '/templates', null],
      ['Trash', '/trash', null],
    ]);
    expect(shadow.querySelector('sf-text-field.search')?.getAttribute('label')).toBe('Search designs');
    expect(shadow.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Make something bold today');
    expect([...shadow.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Quick actions', 'Jump back in', 'Templates', 'Projects']);
    const quick = [...shadow.querySelectorAll('.quick sf-card')];
    expect(quick.map((c) => c.getAttribute('data-action'))).toEqual(HOME_QUICK_ACTIONS.map((a) => a.id));
    expect([...shadow.querySelectorAll('.formats sf-button')].map((b) => b.getAttribute('data-format'))).toEqual(['post', 'story', 'landscape', 'slides', 'poster', 'letter', 'custom']);
    const recents = [...shadow.querySelectorAll('section[aria-labelledby="recent"] sf-card')];
    expect(recents.map((c) => [c.getAttribute('data-asset'), c.getAttribute('href')])).toEqual([
      ['as_flyer', '/s/as_flyer'],
      ['as_menu', '/s/as_menu'],
    ]);
    expect(recents[0]?.textContent).toContain('Edited 2 minutes ago · 3 pages · 1080 × 1350');
    expect([...shadow.querySelectorAll('section[aria-labelledby="templates"] sf-card')].map((c) => c.getAttribute('href'))).toEqual(['/new?template=as_tpl']);
    const projects = [...shadow.querySelectorAll('.project-card')];
    expect(projects.map((p) => [p.getAttribute('data-project'), p.getAttribute('href')])).toEqual([['Spring campaign', '/p/Spring%20campaign']]);
    expect(projects[0]?.textContent).toContain('1 design');
    expect(shadow.querySelector('footer .storage')?.textContent).toBe('1.2 GB used on this device');
    expect(shadow.textContent).not.toContain('Old poster'); // trashed designs show nowhere but the trash
    expect(auditA11y(root.container)).toEqual([]);
  });

  it('keyboard: one native focusable per action, the card actions after their link, no positive tabindex', async () => {
    const { shadow, root } = await mount();
    const links = deepAll(root.container, 'a[href]');
    // logo + 4 nav + 7 quick actions + 2 recents + 1 template + 1 project
    expect(links).toHaveLength(16);
    expect(deepAll(root.container, '[tabindex]').filter((el) => Number(el.getAttribute('tabindex')) > 0)).toEqual([]);
    expect([...shadow.querySelectorAll('header sf-button')].map((b) => b.textContent?.trim())).toEqual(['＋ New design']);
    const flyer = card(shadow, 'as_flyer');
    expect([...flyer.querySelectorAll('sf-icon-button')].map((b) => b.getAttribute('label'))).toEqual(['Add Night Market Flyer to favourites', 'More for Night Market Flyer']);
    expect([...flyer.querySelectorAll('sf-icon-button')].every((b) => b.getAttribute('slot') === 'actions')).toBe(true);
  });

  it('a plain click (or Enter on the link) runs the capability; a modified click is left to the browser', async () => {
    const { shadow, went } = await mount();
    const flyer = card(shadow, 'as_flyer');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 });
    flyer.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    await settle();
    expect(went).toEqual(['/s/as_flyer']);
    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    flyer.dispatchEvent(newTab);
    expect(newTab.defaultPrevented).toBe(false);
    (shadow.querySelector('.quick sf-card') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    (shadow.querySelector('.formats sf-button[data-format="story"]') as HTMLElement).click();
    card(shadow, 'as_tpl').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await settle();
    expect(went).toEqual(['/s/as_flyer', '/new?format=post', '/new?format=story', '/new?template=as_tpl']);
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

  it('the file menu lists what each kind can do (data), and the menu opens from ⋯ and from a right-click', async () => {
    expect(fileActions(INDEX.entries[0] as HomeEntry)).toEqual(['open', 'open-tab', 'rename', 'duplicate', 'move', 'favourite', 'copy-link', 'trash']);
    expect(fileActions(INDEX.entries[2] as HomeEntry)).toEqual(['use', 'edit-template', 'rename', 'duplicate', 'move', 'favourite', 'trash']);
    expect(fileActions(INDEX.entries[3] as HomeEntry)).toEqual(['rename', 'move', 'favourite', 'trash']);
    expect(fileActions(INDEX.entries[4] as HomeEntry)).toEqual(['restore', 'delete-forever']);
    const { host, shadow, root } = await mount();
    await openMenu(host, 'as_flyer');
    expect(menuValues(shadow)).toEqual(['open', 'open-tab', 'rename', 'duplicate', 'move', 'favourite', 'copy-link', 'trash']);
    expect([...shadow.querySelectorAll('sf-menu.file-menu sf-menu[slot="submenu"] sf-menu-item')].map((i) => i.getAttribute('value'))).toEqual(['move:Spring campaign', 'move-new', 'move:']);
    expect(card(shadow, 'as_flyer').hasAttribute('actions-shown')).toBe(true);
    expect(auditA11y(root.container)).toEqual([]);
    const right = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    card(shadow, 'as_tpl').dispatchEvent(right);
    await again(host);
    expect(right.defaultPrevented).toBe(true);
    expect(menuValues(shadow)).toEqual(['use', 'edit-template', 'rename', 'duplicate', 'move', 'favourite', 'trash']);
  });

  it('rename inline from the menu or F2: Enter saves (one op, a toast with Undo); Undo and Escape restore', async () => {
    const { host, shadow, model, shown } = await mount();
    await openMenu(host, 'as_flyer');
    await pick(host, 'rename');
    const field = card(shadow, 'as_flyer').querySelector('sf-inline-edit') as HTMLElement & { value: string };
    expect(field).not.toBeNull();
    expect(card(shadow, 'as_flyer').hasAttribute('href')).toBe(false); // no link around the field
    field.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'Spring sale', previous: 'Night Market Flyer' } }));
    await again(host);
    expect(model.entry('as_flyer')?.title).toBe('Spring sale');
    expect(shown.at(-1)).toEqual({ message: 'Renamed to “Spring sale”', action: 'Undo' });
    // Mod+Z on Home runs the newest toast's Undo.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await again(host);
    expect(model.entry('as_flyer')?.title).toBe('Night Market Flyer');
    card(shadow, 'as_menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await again(host);
    const menuField = card(shadow, 'as_menu').querySelector('sf-inline-edit') as HTMLElement;
    menuField.dispatchEvent(new CustomEvent('sf-cancel'));
    await again(host);
    expect(card(shadow, 'as_menu').querySelector('sf-inline-edit')).toBeNull();
    expect(model.entry('as_menu')?.title).toBe('Spring menu');
  });

  it('duplicate (Mod+D or the menu) puts the copy first with focus; Undo trashes it', async () => {
    const { host, shadow, model, shown } = await mount();
    card(shadow, 'as_flyer').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }));
    await again(host, 5);
    expect(model.recents().map((e) => e.asset)).toEqual(['as_new1', 'as_flyer', 'as_menu']);
    expect(model.entry('as_new1')).toMatchObject({ title: 'Night Market Flyer copy', format: { width: 1080, height: 1350 } });
    expect(shown.at(-1)).toEqual({ message: 'Duplicated “Night Market Flyer copy”', action: 'Undo' });
    expect(host.shadowRoot?.activeElement).toBe(card(shadow, 'as_new1'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    await again(host);
    expect(model.entry('as_new1')?.trashedAt).toBeDefined();
  });

  it('favourite from the star, move to a project from the menu (Undo moves back), trash with Delete (Undo restores)', async () => {
    const { host, shadow, model, shown } = await mount();
    (card(shadow, 'as_flyer').querySelector('sf-icon-button.star') as HTMLElement).click();
    await again(host);
    expect(model.entry('as_flyer')?.favorite).toBe(true);
    expect(card(shadow, 'as_flyer').querySelector('.star-mark')).not.toBeNull();
    await openMenu(host, 'as_flyer');
    await pick(host, 'move:Spring campaign');
    expect(model.entry('as_flyer')?.folder).toBe('Spring campaign');
    expect(shown.at(-1)).toEqual({ message: 'Moved to Spring campaign', action: 'Undo' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await again(host);
    expect(model.entry('as_flyer')?.folder).toBeUndefined();
    card(shadow, 'as_menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await again(host);
    expect(model.entry('as_menu')?.trashedAt).toBe(new Date(NOW).toISOString());
    expect(card(shadow, 'as_menu')).toBeNull();
    expect(shown.at(-1)).toEqual({ message: 'Moved “Spring menu” to trash', action: 'Undo' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await again(host);
    expect(model.entry('as_menu')?.trashedAt).toBeUndefined();
  });

  it('Move to › New project… makes the project in a popover and moves the file there', async () => {
    const { host, shadow, model } = await mount();
    await openMenu(host, 'as_flyer');
    await pick(host, 'move-new');
    const field = shadow.querySelector('sf-text-field.popover-name') as HTMLElement & { value: string };
    field.value = 'Autumn';
    (shadow.querySelector('sf-popover.new-project-popover form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await again(host, 4);
    expect(model.projects().map((p) => p.name).sort()).toEqual(['Autumn', 'Spring campaign']);
    expect(model.entry('as_flyer')?.folder).toBe('Autumn');
  });

  it('copy link writes the Studio URL and toasts', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    const { host, shown } = await mount();
    await openMenu(host, 'as_flyer');
    await pick(host, 'copy-link');
    await again(host);
    expect(written).toEqual([new URL('/s/as_flyer', location.href).href]);
    expect(shown.at(-1)).toEqual({ message: 'Link copied' });
  });

  it('projects: ＋ New project names one inline; a card dragged onto a project card moves there', async () => {
    const { host, shadow, model } = await mount();
    (shadow.querySelector('section[aria-labelledby="projects"] .section-head sf-button') as HTMLElement).click();
    await again(host);
    const name = shadow.querySelector('sf-text-field.project-name') as HTMLElement & { value: string };
    name.value = 'Brand';
    (shadow.querySelector('form.new-project') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await again(host);
    expect(model.projects().map((p) => p.name)).toContain('Brand');
    expect(shadow.querySelector('[data-project="Brand"]')?.textContent).toContain('Empty');
    const data = new Map<string, string>();
    const dataTransfer = { types: [ASSETS_DRAG_TYPE], getData: (t: string) => data.get(t) ?? '', setData: (t: string, v: string) => void data.set(t, v), effectAllowed: 'all', dropEffect: 'none' };
    const drag = new Event('dragstart', { bubbles: true }) as DragEvent;
    Object.defineProperty(drag, 'dataTransfer', { value: dataTransfer });
    card(shadow, 'as_flyer').dispatchEvent(drag);
    const target = shadow.querySelector('[data-project="Brand"]') as HTMLElement;
    const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(over);
    await again(host);
    expect(target.hasAttribute('drop-target')).toBe(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(drop);
    await again(host);
    expect(model.entry('as_flyer')?.folder).toBe('Brand');
    expect(target.hasAttribute('drop-target')).toBe(false);
  });

  it('the project page: back, rename by clicking the name, delete with the inline confirm (designs go to No project)', async () => {
    const { host, shadow, model, pushed, root } = await mount({ view: { kind: 'project', name: 'Spring campaign' } });
    expect(shadow.querySelector('#project-title')?.textContent?.trim()).toBe('Spring campaign');
    expect([...shadow.querySelectorAll('[data-selectable-list] [data-asset]')].map((e) => e.getAttribute('data-asset'))).toEqual(['as_menu']);
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('button.title-button') as HTMLElement).click();
    await again(host);
    (shadow.querySelector('sf-inline-edit.project-rename') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'Summer', previous: 'Spring campaign' } }));
    await again(host);
    expect(model.entry('as_menu')?.folder).toBe('Summer');
    expect(pushed.at(-1)).toBe('/p/Summer');
    (shadow.querySelector('sf-menu.project-menu') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'delete' } }));
    await again(host);
    const confirm = shadow.querySelector('sf-confirm-row') as HTMLElement;
    expect(confirm.getAttribute('message')).toBe('Keep designs, delete project?');
    confirm.dispatchEvent(new CustomEvent('sf-confirm'));
    await again(host);
    expect(model.entry('as_menu')?.folder).toBeUndefined();
    expect(model.entry('as_menu')?.trashedAt).toBeUndefined();
    expect(model.projects()).toEqual([]);
    expect(pushed.at(-1)).toBe('/');
  });

  it('Files: filter, sort and list layout (remembered), bulk select with Shift and Mod+A, the bulk bar acts on the selection', async () => {
    const { host, shadow, model, shown, root } = await mount({ view: { kind: 'files' } });
    const listed = (): string[] => [...shadow.querySelectorAll('[data-selectable-list] [data-asset]')].map((e) => e.getAttribute('data-asset') as string);
    expect(listed()).toEqual(['as_flyer', 'as_menu', 'as_tpl', 'as_img']);
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('sf-segmented.filter') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'designs' } }));
    await again(host);
    expect(listed()).toEqual(['as_flyer', 'as_menu']);
    (shadow.querySelector('sf-segmented.filter') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'all' } }));
    (shadow.querySelector('sf-menu.sort') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'name' } }));
    await again(host);
    expect(listed()).toEqual(['as_img', 'as_flyer', 'as_tpl', 'as_menu']);
    (shadow.querySelector('sf-segmented.layout') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'list' } }));
    await again(host);
    expect(shadow.querySelectorAll('ul.list li.row[data-asset]')).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem('instaflow/ui/files') ?? '{}')).toEqual({ filter: 'all', sort: 'name', layout: 'list' });
    expect(auditA11y(root.container)).toEqual([]);
    const check = (asset: string, shift = false): void => void (card(shadow, asset).querySelector('input.check') as HTMLInputElement).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift }));
    check('as_img');
    check('as_tpl', true);
    await again(host);
    expect([...host.selection]).toEqual(['as_img', 'as_flyer', 'as_tpl']);
    expect(shadow.querySelector('.bulk [role="status"]')?.textContent).toBe('3 selected');
    (shadow.querySelector('.bulk sf-menu.bulk-move') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'move:Spring campaign' } }));
    await again(host);
    expect(['as_img', 'as_flyer', 'as_tpl'].map((a) => model.entry(a)?.folder)).toEqual(['Spring campaign', 'Spring campaign', 'Spring campaign']);
    expect(shown.at(-1)).toEqual({ message: 'Moved 3 files to Spring campaign', action: 'Undo' });
    (shadow.querySelector('ul.list') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    await again(host);
    expect(host.selection.size).toBe(4);
    (shadow.querySelector('.bulk sf-button.bulk-trash') as HTMLElement).click();
    await again(host);
    expect(model.trashed().map((e) => e.asset).sort()).toEqual(['as_flyer', 'as_img', 'as_menu', 'as_old', 'as_tpl']);
    expect(shown.at(-1)).toEqual({ message: 'Moved 4 files to trash', action: 'Undo' });
    expect(shadow.querySelector('.bulk')).toBeNull();
  });

  it('Files: trashing six or more asks first in the bulk bar', async () => {
    const many: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: Array.from({ length: 7 }, (_, i) => entry(`as_${i}`, 'composition', `Design ${i}`, `2026-10-2${i}T00:00:00.000Z`)) };
    const { host, shadow, model } = await mount({ index: many, view: { kind: 'files' } });
    (shadow.querySelector('[data-selectable-list]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }));
    await again(host);
    (shadow.querySelector('.bulk sf-button.bulk-trash') as HTMLElement).click();
    await again(host);
    const confirm = shadow.querySelector('.bulk sf-confirm-row') as HTMLElement;
    expect(confirm.getAttribute('message')).toBe('Move 7 files to trash?');
    expect(model.trashed()).toEqual([]);
    confirm.dispatchEvent(new CustomEvent('sf-confirm'));
    await again(host);
    expect(model.trashed()).toHaveLength(7);
  });

  it('Trash: rows by day, Restore (toast with Open), Delete forever and Empty trash confirm inline', async () => {
    const index: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [...INDEX.entries, entry('as_gone', 'image', 'Old photo', '2026-10-01T00:00:00.000Z', { trashedAt: '2026-10-20T10:00:00.000Z' })] };
    const { host, shadow, model, shown, root } = await mount({ index, view: { kind: 'trash' } });
    expect(shadow.querySelector('.muted')?.textContent).toBe('Items are kept for 30 days.');
    expect([...shadow.querySelectorAll('.trash-day')].map((d) => [...d.querySelectorAll('[data-asset]')].map((r) => r.getAttribute('data-asset')))).toEqual([['as_old'], ['as_gone']]);
    expect(auditA11y(root.container)).toEqual([]);
    (card(shadow, 'as_old').querySelector('sf-button.restore') as HTMLElement).click();
    await again(host);
    expect(model.entry('as_old')?.trashedAt).toBeUndefined();
    expect(shown.at(-1)).toEqual({ message: 'Restored “Old poster”', action: 'Open' });
    (card(shadow, 'as_gone').querySelector('sf-button.delete-forever') as HTMLElement).click();
    await again(host);
    const confirm = card(shadow, 'as_gone').querySelector('sf-confirm-row') as HTMLElement;
    expect(confirm.getAttribute('message')).toBe('Delete forever? This can’t be undone.');
    confirm.dispatchEvent(new CustomEvent('sf-confirm'));
    await again(host);
    expect(model.entry('as_gone')).toBeUndefined();
    expect(shadow.textContent).toContain('The trash is empty.');
    await model.trash(['as_img', 'as_menu']);
    await again(host);
    (shadow.querySelector('sf-button.empty-trash') as HTMLElement).click();
    await again(host);
    const empty = shadow.querySelector('sf-confirm-row') as HTMLElement;
    expect(empty.getAttribute('message')).toBe('Delete 2 files forever? This can’t be undone.');
    empty.dispatchEvent(new CustomEvent('sf-confirm'));
    await again(host);
    expect(model.trashed()).toEqual([]);
  });

  it('the nav switches pages through history; the Templates page lists templates', async () => {
    const { host, shadow, pushed } = await mount();
    const nav = (label: string): HTMLElement => [...shadow.querySelectorAll('nav .nav a')].find((a) => a.textContent === label) as HTMLElement;
    nav('Templates').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await again(host);
    expect(pushed).toEqual(['/templates']);
    expect(shadow.querySelector('#templates-title')?.textContent).toBe('Templates');
    expect([...shadow.querySelectorAll('[data-asset]')].map((c) => c.getAttribute('data-asset'))).toEqual(['as_tpl']);
    expect(nav('Templates').getAttribute('aria-current')).toBe('page');
    nav('Trash').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true })); // new tab: the browser's
    expect(pushed).toEqual(['/templates']);
  });

  it('search filters every list live and marks the match; no match says so with Clear; Enter opens Files with the query', async () => {
    const { host, shadow, pushed } = await mount();
    host.query = 'spring';
    await again(host);
    expect([...shadow.querySelectorAll('section[aria-labelledby="recent"] [data-asset]')].map((c) => c.getAttribute('data-asset'))).toEqual(['as_menu']);
    expect(card(shadow, 'as_menu').querySelector('mark')?.textContent).toBe('Spring');
    expect(shadow.querySelector('section[aria-labelledby="templates"]')).toBeNull();
    host.query = 'flyover';
    await again(host);
    expect(shadow.querySelector('.no-results')?.textContent).toContain('No results for “flyover”');
    (shadow.querySelector('.no-results sf-button') as HTMLElement).click();
    await again(host);
    expect(host.query).toBe('');
    host.query = 'flyer';
    await again(host);
    (shadow.querySelector('sf-text-field.search') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await again(host);
    expect(pushed).toEqual(['/files?q=flyer']);
    expect(shadow.querySelector('.muted[role="status"]')?.textContent).toBe('1 result for “flyer”');
  });

  it('`/` focuses the search; Escape clears the Files selection', async () => {
    const { host, shadow } = await mount({ view: { kind: 'files' } });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    await again(host);
    expect(shadow.activeElement?.classList.contains('search')).toBe(true);
    (shadow.activeElement as HTMLElement).blur();
    (card(shadow, 'as_flyer').querySelector('input.check') as HTMLInputElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await again(host);
    expect(host.selection.size).toBe(1);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await again(host);
    expect(host.selection.size).toBe(0);
  });

  it('import: a drop on the page imports images into the project on screen; others are refused with the reason', async () => {
    const stored: string[] = [];
    const importer: HomeImporter = {
      async importFile(file, asset) {
        stored.push(file.name);
        return ok({ asset, kind: 'image', title: file.name.replace(/\.\w+$/, ''), mime: 'image/png', size: file.size, content: { digest: `sha256:${file.name}`, size: file.size, mime: 'image/png' }, record: { digest: 'sha256:rec', size: 1, mime: 'application/json' }, width: 10, height: 20 });
      },
    };
    const { host, shadow, model, shown } = await mount({ importer, view: { kind: 'project', name: 'Spring campaign' } });
    const files = [new File([new Uint8Array([1])], 'lamp.png', { type: 'image/png' }), new File(['x'], 'notes.txt', { type: 'text/plain' })];
    const main = shadow.querySelector('main') as HTMLElement;
    const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none' } });
    main.dispatchEvent(over);
    await again(host);
    expect(main.classList.contains('drop')).toBe(true);
    expect(shadow.textContent).toContain('Drop files to import');
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files } });
    main.dispatchEvent(drop);
    await again(host, 5);
    expect(stored).toEqual(['lamp.png']);
    expect(model.entry('as_new1')).toMatchObject({ kind: 'image', title: 'lamp', folder: 'Spring campaign', format: { width: 10, height: 20 } });
    expect(shown.map((s) => s.message)).toEqual(['Imported “lamp”', 'Couldn’t import “notes.txt”. Images, SVG and fonts are supported.']);
    expect(shadow.querySelector('sf-progress-row')).toBeNull(); // gone once done
    expect(main.classList.contains('drop')).toBe(false);
    await host.importFiles([new File(['v'], 'clip.mp4', { type: 'video/mp4' })]);
    expect(shown.at(-1)?.message).toBe('Couldn’t import “clip.mp4”. Video arrives with the Timeline lens.');
  });

  it('import of several files: an inline progress row counts them; Cancel stops the rest, what is stored stays', async () => {
    const waiting: (() => void)[] = [];
    const importer: HomeImporter = {
      importFile: (file, asset) =>
        new Promise((resolve) =>
          waiting.push(() => resolve(ok({ asset, kind: 'image', title: file.name, mime: 'image/png', size: 1, content: { digest: `sha256:${file.name}`, size: 1, mime: 'image/png' }, record: { digest: 'sha256:r', size: 1, mime: 'x' } }))),
        ),
    };
    const { host, shadow, model } = await mount({ importer });
    const files = ['a.png', 'b.png', 'c.png'].map((n) => new File([new Uint8Array([1])], n, { type: 'image/png' }));
    const running = host.importFiles(files);
    await again(host);
    const row = (): HTMLElement & { label: string } => shadow.querySelector('sf-progress-row') as HTMLElement & { label: string };
    expect(row().label).toBe('Importing 0 of 3…');
    waiting.shift()?.();
    await again(host);
    expect(row().label).toBe('Importing 1 of 3…');
    row().dispatchEvent(new CustomEvent('sf-cancel'));
    waiting.shift()?.();
    const summary = await running;
    await again(host);
    expect(summary?.imported.map((e) => e.title)).toEqual(['a.png', 'b.png']);
    expect(model.files().filter((e) => e.kind === 'image').map((e) => e.title).sort()).toEqual(['a.png', 'b.png', 'Lantern photo'].sort());
    expect(shadow.querySelector('sf-progress-row')).toBeNull();
  });

  it('first run: one welcome card (Keep asks for persistence on the click), the formats hint; seen on the next visit', async () => {
    localStorage.removeItem(FIRST_RUN_KEY);
    const port = persistence(false);
    const { host, shadow, root } = await mount({ index: { schema: HOME_INDEX_SCHEMA, entries: [] }, storage: port });
    expect(shadow.querySelector('.welcome h2')?.textContent).toBe('Your designs live on this device');
    expect(shadow.querySelector('.first-run-hint')?.textContent).toBe('Pick a size to start. You can change it later.');
    expect(shadow.querySelector('section[aria-labelledby="recent"]')).toBeNull(); // the card replaces the empty section
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('.welcome sf-button.keep') as HTMLElement).click();
    await again(host);
    expect(port.asked).toBe(1);
    expect(shadow.querySelector('.welcome-status')?.textContent).toBe('Chrome may clear this workspace under storage pressure. Pin this site to keep it.');
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('seen');
  });

  it('first run: the card can be dismissed (seen); an empty workspace afterwards says where designs will appear', async () => {
    localStorage.removeItem(FIRST_RUN_KEY);
    const { host, shadow, root } = await mount({ index: { schema: HOME_INDEX_SCHEMA, entries: [] } });
    (shadow.querySelector('.welcome sf-icon-button.close') as HTMLElement).click();
    await again(host);
    expect(shadow.querySelector('.welcome')).toBeNull();
    expect([...shadow.querySelectorAll('.empty')].map((p) => p.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Your designs will appear here.', 'Group designs into projects ＋ New project']);
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('seen');
    expect(auditA11y(root.container)).toEqual([]);
  });

  it('speaks a failed action in the polite live region', async () => {
    const { host, shadow, model } = await mount();
    const status = shadow.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;
    const run = (host as unknown as { run(a: () => Promise<Result<unknown>>, t: string): Promise<void> }).run.bind(host);
    await run(() => model.open('as_gone'), 'Gone');
    await host.updateComplete;
    expect(status.textContent).toContain('no design with this asset id');
  });

  it('a failed write for lack of space shows the storage banner with Open Trash', async () => {
    const { host, shadow, model, pushed } = await mount();
    const attempt = (host as unknown as { attempt<T>(r: Promise<Result<T>>): Promise<{ value: T } | undefined> }).attempt.bind(host);
    await attempt(Promise.resolve(err({ ...HeadConflictError({ message: 'full' }), kind: 'quota' } as never)));
    await again(host);
    const banner = shadow.querySelector('sf-banner') as HTMLElement;
    expect(banner.getAttribute('message')).toContain('Storage is full');
    banner.dispatchEvent(new CustomEvent('sf-action'));
    await again(host);
    expect(pushed).toEqual(['/trash']);
    expect(model.view.kind).toBe('trash');
  });

  it('a failed read shows an alert with "Try again", which reads again', async () => {
    let calls = 0;
    const { host, shadow, root } = await mount({ source: { read: async () => ((calls += 1) === 1 ? err(HeadConflictError({ message: 'blocked' })) : ok(INDEX)) } });
    const alert = shadow.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Home could not read your workspace: blocked');
    expect(auditA11y(root.container)).toEqual([]);
    (alert.querySelector('sf-button') as HTMLElement).click();
    await again(host);
    expect(shadow.querySelector('[role="alert"]')).toBeNull();
    expect(shadow.querySelectorAll('section[aria-labelledby="recent"] sf-card')).toHaveLength(2);
  });

  it('loading: the main region is busy and says so', async () => {
    const { shadow } = await mount({ source: { read: () => new Promise(() => undefined) } });
    expect(shadow.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(shadow.querySelector('main [role="status"]')?.textContent).toBe('Loading your workspace…');
  });
});

describe('bootHome', () => {
  beforeEach(() => localStorage.setItem(FIRST_RUN_KEY, 'seen'));

  it('renders Home over a workspace store, journals file operations, reads again when visible, follows Back', async () => {
    const store = createMemoryDocumentStore();
    const signal = new AbortController().signal;
    const container = document.createElement('div');
    document.body.append(container);
    const scope = createScope('home-boot-test');
    const went: string[] = [];
    const pushed: string[] = [];
    const booted = await bootHome({ container, scope, store, host: { navigate: (h) => went.push(h), push: (h) => pushed.push(h) } });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    await settle();
    expect(booted.value.model.state).toBe('ready');
    expect(booted.value.model.recents()).toEqual([]);
    expect(document.head.querySelector('style')?.textContent).toContain('--sf-color-accent');
    expect(container.querySelector('sf-surface-layer')).not.toBeNull();
    expect((await store.writeHead('library', withHomeIndex(LIBRARY_HEAD, INDEX), null, signal)).ok).toBe(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    await settle();
    expect(booted.value.model.recents().map((e) => e.asset)).toEqual(['as_flyer', 'as_menu']);
    expect((await booted.value.model.rename('as_menu', 'Summer menu')).ok).toBe(true);
    const journal = await store.readHead('home-journal', signal);
    expect(journal.ok && (journal.value?.app?.['journal'] as { ops: unknown[] }).ops).toHaveLength(1);
    expect(await booted.value.model.newDesign('story')).toEqual(ok({ href: '/new?format=story' }));
    expect(went).toEqual(['/new?format=story']);
    history.pushState(null, '', '/trash');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(booted.value.model.view).toEqual({ kind: 'trash' });
    history.pushState(null, '', '/');
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
