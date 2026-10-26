import { composeUnits } from '@staticflux/core';
import { createSpecRuntime, diffSpecs, EMPTY_LAYOUT, specIssues, validateSpec } from '@staticflux/shell/spec';
import { createTestInjector, recordingSpecPort } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import {
  DENSITY_RANK,
  defineEditorSpec,
  defineHudAction,
  defineLens,
  definePanel,
  defineTool,
  EDITOR_SECTIONS,
  editDocumentCapability,
  type EditorSpec,
  EditorRegistriesToken,
  editorRegistriesUnit,
  editorSpecJsonSchema,
  gateSpecDecide,
  HudActionContributionsToken,
  hudActionContribution,
  LensContributionsToken,
  lensContribution,
  PanelContributionsToken,
  panelContribution,
  parseEditorSpec,
  pixelTouchUpSpec,
  proposeSpecCapability,
  SCOPE_FIELDS,
  slotOf,
  STUDIO_LENS_HUD,
  STUDIO_LENS_TOOLS,
  StudioIds,
  studioContributionUnits,
  studioSpec,
  studioSpecFor,
  ToolContributionsToken,
  toolContribution,
  toShellSpec,
  createEditorRegistries,
} from './index.js';
import { BrandGate, editorGate, gatedStudioSpec, studioRegistries } from './testing/fixtures.js';

const vocabulary = () => studioRegistries().vocabulary;
const valid = async (spec: EditorSpec, gated = false, decide = editorGate('pro').gate) => validateSpec(toShellSpec(spec), studioRegistries({ gated }).vocabulary, { decide: gateSpecDecide(decide) });

describe('contributions', () => {
  it('define* freeze data with their kind; densities are ranked', () => {
    const lens = defineLens({ id: 'x/lens', label: 'X', palette: 'layout' });
    const tool = defineTool({ id: 'x/tool', label: 'Tool', glyph: 'T' });
    const panel = definePanel({ id: 'x/panel', label: 'Panel', placements: ['dock'], render: () => 'body' });
    const hud = defineHudAction({ id: 'x/hud', label: 'Hud', tone: 'direct' });
    expect([lens.kind, tool.kind, panel.kind, hud.kind]).toEqual(['instaflow/lens', 'instaflow/tool', 'instaflow/panel', 'instaflow/hud-action']);
    expect(panel.minDensity).toBe('focus');
    expect(Object.isFrozen(tool)).toBe(true);
    expect(DENSITY_RANK.focus < DENSITY_RANK.standard && DENSITY_RANK.standard < DENSITY_RANK.pro).toBe(true);
  });

  it('unit helpers contribute to the multi tokens and editorRegistriesUnit builds the vocabulary', async () => {
    const extra = defineTool({ id: 'x/extra', label: 'Extra', glyph: 'E' });
    const test = createTestInjector({ units: composeUnits([...studioContributionUnits, toolContribution(extra), editorRegistriesUnit]) });
    const registries = await test.get(EditorRegistriesToken);
    expect(registries.tool('x/extra')?.label).toBe('Extra');
    expect(registries.lenses.map((l) => l.label)).toEqual(['Canvas', 'Pixel', 'Timeline', 'Flow', 'Pages']);
    expect((await test.get(LensContributionsToken)).length).toBe(5);
    expect((await test.get(ToolContributionsToken)).length).toBe(16); // B11b: the shape family
    expect((await test.get(PanelContributionsToken)).length).toBe(10);
    expect((await test.get(HudActionContributionsToken)).length).toBe(5);
    expect([lensContribution, panelContribution, hudActionContribution].every((f) => typeof f === 'function')).toBe(true);
    await test.dispose();
  });
});

describe('EditorSpec schema', () => {
  it('parses a well-formed spec and freezes presets', () => {
    const parsed = parseEditorSpec(JSON.parse(JSON.stringify(studioSpec)));
    expect(parsed.ok && parsed.value.lens).toBe(StudioIds.lens.canvas);
    expect(Object.isFrozen(defineEditorSpec({ ...studioSpec }))).toBe(true);
    expect(editorSpecJsonSchema.type).toBe('object');
    expect(Object.keys(editorSpecJsonSchema.properties ?? {})).toEqual(expect.arrayContaining(['lens', 'scope', 'tools', 'panels', 'hud', 'capabilities', 'density', 'pinned']));
  });

  it('rejects malformed input with IF-SPEC-001 and JSON paths', () => {
    const cases: unknown[] = [
      null,
      { ...studioSpec, lens: 'Not An Id' },
      { ...studioSpec, extra: true },
      { ...studioSpec, panels: [{ panel: 'instaflow/layers', dock: 'floating' }] },
      { ...studioSpec, scope: { kind: 'selection' } },
      { ...studioSpec, scope: { kind: 'time-range', start: 5, end: 2 } },
      { ...studioSpec, pinned: ['lens:instaflow/lens-canvas'] },
    ];
    for (const value of cases) {
      const parsed = parseEditorSpec(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('IF-SPEC-001');
        expect(Array.isArray((parsed.error.details as { issues?: unknown }).issues)).toBe(true);
      }
    }
    expect(SCOPE_FIELDS['time-range']).toEqual(['start', 'end']);
  });
});

describe('registries', () => {
  it('compile contributions into the five sections; slotOf names slots', () => {
    const registries = studioRegistries();
    expect(EDITOR_SECTIONS.map((s) => [s.id, s.cardinality, s.pinnable])).toEqual([
      ['lens', 'one', false],
      ['tool', 'many', true],
      ['panel', 'many', true],
      ['hud', 'many', true],
      ['capability', 'many', false],
    ]);
    expect(registries.vocabulary.contribution('tool', StudioIds.tool.brush)?.when).toEqual({ lens: [StudioIds.lens.pixel] });
    expect(registries.vocabulary.contribution('capability', proposeSpecCapability.id)?.gate).toMatchObject({ level: 'capability', id: proposeSpecCapability.id });
    expect(registries.panel(StudioIds.panel.properties)?.minDensity).toBe('pro');
    expect(registries.hud(StudioIds.hud.ask)?.tone).toBe('agent');
    expect(registries.capability(editDocumentCapability.id)?.title).toBe('Edit the document');
    expect(registries.lens(StudioIds.lens.pixel)?.palette).toBe('pixel');
    expect(slotOf('panel', StudioIds.panel.layers)).toBe('panel:instaflow/layers');
  });

  it('IF-SPEC-002 for duplicate ids and unknown lenses', () => {
    const base = { lenses: [], tools: [], panels: [], hud: [], capabilities: [] };
    const tool = defineTool({ id: 'x/t', label: 'T', glyph: 'T' });
    const dup = createEditorRegistries({ ...base, tools: [tool, tool] });
    expect(!dup.ok && dup.error.code).toBe('IF-SPEC-002');
    const lensless = createEditorRegistries({ ...base, tools: [defineTool({ id: 'x/u', label: 'U', glyph: 'U', lenses: ['x/none'] })] });
    expect(!lensless.ok && lensless.error.code).toBe('IF-SPEC-002');
  });

  it('toShellSpec: context, slot order and placements, pins', () => {
    const shell = toShellSpec({ ...studioSpec, pinned: ['panel:instaflow/layers'] });
    expect(shell.context).toEqual({ lens: StudioIds.lens.canvas, scope: 'asset', density: 'standard' });
    expect(shell.slots[0]).toEqual({ section: 'lens', id: StudioIds.lens.canvas });
    expect(shell.slots.find((s) => s.id === StudioIds.panel.typography)?.placement).toBe('inspector');
    expect(shell.slots.find((s) => s.id === StudioIds.panel.milestones)?.placement).toBe('dock');
    expect(shell.slots.at(-1)).toEqual({ section: 'capability', id: proposeSpecCapability.id });
    expect(shell.pinned).toEqual(['panel:instaflow/layers']);
    expect(toShellSpec({ ...studioSpec, density: undefined as never }).context['density']).toBe('focus');
  });
});

describe('Studio and example specs', () => {
  it('Studio is valid under every lens (modes are well-known specs)', async () => {
    expect((await valid(studioSpec)).ok).toBe(true);
    for (const lens of Object.values(StudioIds.lens)) {
      const spec = studioSpecFor(lens);
      expect(spec.tools).toEqual(STUDIO_LENS_TOOLS[lens]);
      expect(spec.hud).toEqual(STUDIO_LENS_HUD[lens]);
      const result = await valid(spec);
      expect(result.ok, lens).toBe(true);
    }
  });

  it('a lens switch is a small diff: shared panels and tools stay, only lens-specific slots change', async () => {
    const canvas = await valid(studioSpec);
    const pixel = await valid(studioSpecFor(StudioIds.lens.pixel));
    if (!canvas.ok || !pixel.ok) throw new Error('invalid');
    const diff = diffSpecs(diffSpecs(EMPTY_LAYOUT, canvas.value).target, pixel.value);
    const T = StudioIds.tool;
    expect(diff.unmount.map((s) => s.id)).toEqual([StudioIds.panel.typography, T.text, T.line, T.star, T.polygon, T.ellipse, T.shape, T.frame, StudioIds.lens.canvas]);
    expect(diff.mount.map((s) => s.id)).toEqual([StudioIds.lens.pixel, T.brush, T.heal, T.crop, StudioIds.panel.adjust, StudioIds.hud.removeBackground, StudioIds.hud.ask]);
    expect(diff.move).toEqual([]);
    expect(diff.kept).toEqual(expect.arrayContaining(['panel:instaflow/pages', 'panel:instaflow/milestones', 'tool:instaflow/select', 'tool:instaflow/hand']));
  });

  it('the pixel touch-up mini editor validates; out-of-scope and unknown slots are rejected', async () => {
    expect((await valid(pixelTouchUpSpec(['img-1']))).ok).toBe(true);
    const wrongScope = await valid({ ...pixelTouchUpSpec(['img-1']), scope: { kind: 'page', page: 'p1' } });
    expect(!wrongScope.ok && specIssues(wrongScope.error).map((i) => [i.code, i.slot])).toEqual([['SF-SHELL-011', 'lens:instaflow/lens-pixel']]);
    const wrongLens = await valid({ ...pixelTouchUpSpec(['img-1']), lens: StudioIds.lens.canvas });
    expect(!wrongLens.ok && specIssues(wrongLens.error).map((i) => i.slot)).toEqual(['tool:instaflow/brush', 'tool:instaflow/heal', 'panel:instaflow/adjust']);
    const unknown = await valid({ ...studioSpec, tools: [...studioSpec.tools, 'instaflow/teleport'], panels: [...studioSpec.panels, { panel: 'acme/ads', dock: 'dock' }] });
    expect(!unknown.ok && specIssues(unknown.error).map((i) => [i.code, i.slot])).toEqual([
      ['SF-SHELL-010', 'tool:instaflow/teleport'],
      ['SF-SHELL-010', 'panel:acme/ads'],
    ]);
  });
});

describe('gateSpecDecide (through @staticflux/gate)', () => {
  it('denies a gated panel with the policy reason, per subject', async () => {
    const free = editorGate('free');
    const denied = await valid(gatedStudioSpec, true, free.gate);
    expect(!denied.ok && specIssues(denied.error)).toMatchObject([{ code: 'SF-SHELL-012', slot: 'panel:instaflow/brand', details: { reason: 'upgrade' } }]);
    free.setPlan('pro');
    expect((await valid(gatedStudioSpec, true, free.gate)).ok).toBe(true);
    const asAgent = gateSpecDecide(free.gate, 'agent');
    expect(asAgent.decide(BrandGate)).toEqual({ effect: 'allow' });
    expect(asAgent.decide({ kind: 'gate-resource', level: 'ui-slot', id: 'instaflow/undelegated' })).toMatchObject({ effect: 'deny' });
    expect(gateSpecDecide(free.gate).decide({ kind: 'gate-resource', level: 'nowhere', id: 'x/y' })).toEqual({ effect: 'deny', reason: 'unavailable', code: 'SF-GATE-001' });
  });

  it('a runtime over the Studio vocabulary mounts Studio and keeps a pinned panel across a narrow spec', async () => {
    const port = recordingSpecPort();
    const runtime = createSpecRuntime({ vocabulary: vocabulary(), port });
    expect((await runtime.apply(toShellSpec(gatedStudioSpec))).ok).toBe(true);
    expect(runtime.pin('panel:instaflow/layers').ok).toBe(true);
    const narrow = await runtime.apply(toShellSpec({ ...pixelTouchUpSpec(['img-1']), scope: { kind: 'asset' } }));
    expect(narrow.ok && narrow.value.diff.retained).toEqual(['panel:instaflow/layers']);
    expect(port.groups()['panel@dock']).toEqual(['panel:instaflow/layers']);
  });
});
