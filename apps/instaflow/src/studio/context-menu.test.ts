/** B11b slice 4: the context menu's groups per target (STUDIO §8.2) and its value grammar. */
import { describe, expect, it } from 'vitest';
import type { SelectionSummary } from '../app/scene-summary.js';
import { contextMenuGroups, parseContextValue, type ContextEntry, type ContextEnv } from './context-menu.js';

const ENV: ContextEnv = { canPaste: false, styleCopied: false, pages: 1 };

const summary = (over: Partial<SelectionSummary>): SelectionSummary => ({
  kind: 'shape',
  nodes: ['r1'],
  label: 'Rectangle',
  typeLabel: 'Rectangle',
  locked: false,
  anyLocked: false,
  hidden: false,
  common: 'rectangle',
  actions: [],
  ...over,
});

const values = (groups: readonly (readonly ContextEntry[])[]): string[] => groups.flat().flatMap((e) => [e.value, ...(e.children ?? []).map((c) => c.value)]);

describe('contextMenuGroups', () => {
  it('the empty canvas: Select all, zoom, Add page; Paste only with something copied', () => {
    expect(values(contextMenuGroups({ kind: 'canvas' }, ENV))).toEqual(['cmd:select-all', 'cmd:zoom-fit', 'cmd:zoom-100', 'cmd:add-page']);
    expect(values(contextMenuGroups({ kind: 'canvas' }, { ...ENV, canPaste: true })).slice(0, 2)).toEqual(['cmd:paste', 'cmd:paste-in-place']);
  });

  it('a selection lists only the capabilities its actions include', () => {
    const s = summary({ actions: ['instaflow/duplicate', 'instaflow/delete', 'instaflow/copy-style', 'instaflow/paste-style', 'instaflow/lock', 'instaflow/bring-to-front', 'instaflow/flatten'] });
    const v = values(contextMenuGroups({ kind: 'selection', summary: s }, ENV));
    expect(v).toEqual(expect.arrayContaining(['cmd:cut', 'cmd:copy', 'cap:instaflow/duplicate', 'cap:instaflow/delete', 'cap:instaflow/copy-style', 'cap:instaflow/lock?locked=true', 'cmd:rename', 'cap:instaflow/flatten']));
    expect(v).not.toContain('cap:instaflow/group');
    expect(v).not.toContain('cap:instaflow/paste-style'); // nothing copied yet
    expect(v).not.toContain('cmd:paste');
    const later = values(contextMenuGroups({ kind: 'selection', summary: s }, { ...ENV, styleCopied: true }));
    expect(later).toEqual(expect.arrayContaining(['cap:instaflow/paste-style', 'cap:instaflow/paste-style?only=fill', 'cap:instaflow/paste-style?only=layer']));
  });

  it('locked and hidden flip their items; a locked selection offers Copy and Unlock only', () => {
    const hidden = values(contextMenuGroups({ kind: 'selection', summary: summary({ hidden: true, actions: ['instaflow/hide'] }) }, ENV));
    expect(hidden).toContain('cap:instaflow/hide?hidden=false');
    const locked = contextMenuGroups({ kind: 'selection', summary: summary({ kind: 'locked', locked: true }) }, ENV);
    expect(values(locked)).toEqual(['cmd:copy', 'cap:instaflow/lock?locked=false']);
  });

  it('kind items: text, image, multi (align only for several), mask release names the mask', () => {
    const text = values(contextMenuGroups({ kind: 'selection', summary: summary({ kind: 'text', common: 'text' }) }, ENV));
    expect(text).toEqual(expect.arrayContaining(['cmd:edit-text', 'cmd:text-style', 'cmd:fit-to-box', 'cmd:copy-as-text']));
    const image = values(contextMenuGroups({ kind: 'selection', summary: summary({ kind: 'image', common: 'image' }) }, ENV));
    expect(image).toEqual(expect.arrayContaining(['cmd:replace-image', 'cmd:fit:cover', 'cmd:fit:contain']));
    const multi = values(contextMenuGroups({ kind: 'selection', summary: summary({ kind: 'multi', nodes: ['a', 'b'], actions: ['instaflow/align-left', 'instaflow/distribute-h-spacing', 'instaflow/boolean-union'] }) }, ENV));
    expect(multi).toEqual(expect.arrayContaining(['cap:instaflow/align-left', 'cap:instaflow/distribute-h-spacing', 'cap:instaflow/boolean-union']));
    expect(multi).not.toContain('cmd:rename');
    const mask = values(contextMenuGroups({ kind: 'selection', summary: summary({ kind: 'mask', mask: { node: 'm1', mode: 'alpha', invert: false } }) }, ENV));
    expect(mask).toContain('cap:instaflow/mask-release?node=m1');
  });

  it('the page label: Delete page only with two pages; sizes as WxH', () => {
    const one = values(contextMenuGroups({ kind: 'page' }, ENV));
    expect(one).not.toContain('cmd:page-delete');
    expect(one.some((v) => /^cmd:page-size:\d+x\d+$/.test(v))).toBe(true);
    expect(values(contextMenuGroups({ kind: 'page' }, { ...ENV, pages: 2 }))).toContain('cmd:page-delete');
  });

  it('drops empty groups', () => {
    for (const g of contextMenuGroups({ kind: 'selection', summary: summary({}) }, ENV)) expect(g.length).toBeGreaterThan(0);
  });
});

describe('parseContextValue', () => {
  it('reads capabilities with typed query values and commands with an argument', () => {
    expect(parseContextValue('cap:instaflow/lock?locked=false')).toEqual({ kind: 'cap', id: 'instaflow/lock', input: { locked: false } });
    expect(parseContextValue('cap:instaflow/paste-style?only=fill')).toEqual({ kind: 'cap', id: 'instaflow/paste-style', input: { only: 'fill' } });
    expect(parseContextValue('cmd:page-size:1080x1350')).toEqual({ kind: 'cmd', name: 'page-size', arg: '1080x1350' });
    expect(parseContextValue('cmd:copy')).toEqual({ kind: 'cmd', name: 'copy' });
    expect(parseContextValue('other')).toBeUndefined();
  });
});
