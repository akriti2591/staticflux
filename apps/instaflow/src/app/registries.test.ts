// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STUDIO_SCOPE_HUD, STUDIO_SCOPE_PANELS, studioSpec, studioSpecFor } from '../spec/studio-spec.js';
import { StudioIds, studioPanels } from '../spec/studio-contributions.js';
import { toShellSpec } from '../spec/registries.js';
import { validateSpec } from '@staticflux/shell/spec';
import { replaceById, studioAppRegistries, studioContributions } from './registries.js';
import { unwrap } from './test-helpers.js';

describe('Studio registries with the M1b contributions', () => {
  it('replaceById keeps order, replaces by id and appends new ids', () => {
    expect(replaceById([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }])).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'c', v: 2 },
    ]);
  });

  it('replaces B0 placeholders (never duplicates them) and places every M1b panel and HUD action', () => {
    const registries = unwrap(studioAppRegistries());
    const c = studioContributions();
    for (const id of [StudioIds.panel.pages, StudioIds.panel.assets, StudioIds.panel.typography, StudioIds.panel.milestones]) {
      expect(c.panels.filter((p) => p.id === id)).toHaveLength(1);
      expect(registries.panel(id)?.render).not.toBe(studioPanels.find((p) => p.id === id)?.render);
    }
    expect(registries.tool(StudioIds.tool.select)?.description).toContain('marquee');
    // Every HUD action of the features is named by a Studio table (asset rows or the selection rows).
    const placed = new Set(Object.values(STUDIO_SCOPE_HUD.selection ?? {}).flat());
    for (const action of c.hud.filter((h) => h.capability !== undefined)) expect(placed.has(action.id), action.id).toBe(true);
    const inspectors = new Set(Object.values(STUDIO_SCOPE_PANELS.selection ?? {}).flatMap((rows) => rows.map((r) => r.panel)));
    expect([...inspectors]).toEqual([StudioIds.panel.transform, StudioIds.panel.appearance, StudioIds.panel.repeat]);
    // Free transform is an editor command (no capability) and is placed too.
    expect(placed.has('instaflow/free-transform-hud')).toBe(true);
  });

  it('Studio validates in the asset scope and in the selection scope under every layout lens', async () => {
    const registries = unwrap(studioAppRegistries());
    const check = (spec: typeof studioSpec) => validateSpec(toShellSpec(spec), registries.vocabulary);
    expect((await check(studioSpec)).ok).toBe(true);
    for (const lens of [StudioIds.lens.canvas, StudioIds.lens.pages, StudioIds.lens.pixel]) {
      const selected = studioSpecFor(lens, { ...studioSpec, scope: { kind: 'selection', nodes: ['n1'] } });
      const result = await check(selected);
      expect(result.ok, `${lens}: ${result.ok ? '' : JSON.stringify(result.error.details)}`).toBe(true);
    }
    const canvas = studioSpecFor(StudioIds.lens.canvas, { ...studioSpec, scope: { kind: 'selection', nodes: ['n1'] } });
    expect(canvas.hud).toContain('instaflow/repeat-radial');
    expect(canvas.panels.map((p) => p.panel)).toEqual(expect.arrayContaining([StudioIds.panel.appearance, StudioIds.panel.repeat, StudioIds.panel.typography, StudioIds.panel.milestones]));
  });
});
