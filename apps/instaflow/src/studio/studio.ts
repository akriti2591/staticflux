/**
 * The Studio controller (M1b B0, D16/D19): the spec runtime, its reactive layout model, the proposals
 * pipeline and the hand-driven actions of the Studio frame — switch lens (a spec change), set density
 * (a spec change), pick a tool, pin a panel — plus their keyboard paths. Headless: `<if-studio>` renders
 * from it; tests drive it without a DOM. Every path works by hand (D17: the agent is always a choice).
 *
 * Keyboard (UX §9): `1`–`5` switch lenses (each lens contribution's shortcut), tool letters pick tools,
 * `Alt+Enter` focuses the HUD, `Mod+K` the command bar, `Escape` returns to the canvas.
 */
import { defineShortcut, defineShortcutScope, type ShortcutRegistry } from '@staticflux/a11y';
import { box, err, ok, type Result, type Scope, type SfError, type Telemetry } from '@staticflux/core';
import { createSpecLayoutPort, createSpecRuntime, slotKey, type SpecApplied, type SpecLayoutPort, type SpecLayoutPortOptions, type SpecRuntime, type SpecSlotKey, SpecSlotError } from '@staticflux/shell/spec';
import type { DecidePort } from '@staticflux/ui';
import type { Density, LensContribution, LensContributionId, ToolId } from '../spec/contributions.js';
import type { SpecSubject } from '../spec/gate.js';
import { type Autonomy, createSpecProposals, type ProposalSource, type SpecProposal, type SpecProposals } from '../spec/proposals.js';
import { DEFAULT_DENSITY, EditorSection, type EditorRegistries, slotOf, toShellSpec } from '../spec/registries.js';
import type { EditorSpec } from '../spec/schema.js';
import { studioSpec, studioSpecFor } from '../spec/studio-spec.js';

export const StudioShortcutScope = /* @__PURE__ */ defineShortcutScope('instaflow/studio');

/** The person at the keyboard: hand-driven spec changes are theirs. */
export const PERSON: ProposalSource = Object.freeze({ kind: 'person', id: 'local', displayName: 'You' });
const PRESET: ProposalSource = Object.freeze({ kind: 'preset', id: 'instaflow/studio' });

export interface StudioOptions {
  readonly registries: EditorRegistries;
  /** Gating per subject (`(s) => gateSpecDecide(gate, s)`). */
  readonly decideFor: (subject: SpecSubject) => DecidePort;
  /** The spec to open (default: the Studio spec). */
  readonly spec?: EditorSpec;
  readonly autonomy?: Autonomy;
  readonly reducedMotion?: () => boolean;
  /** Motion waits of the layout model (tests inject a manual clock). */
  readonly wait?: SpecLayoutPortOptions['wait'];
  readonly telemetry?: Telemetry;
}

/** Where keyboard paths land (the element provides them). */
export interface StudioFocusTargets {
  focusHud(): void;
  focusCommandBar(): void;
  focusCanvas(): void;
}

export interface Studio {
  readonly registries: EditorRegistries;
  readonly port: SpecLayoutPort;
  readonly runtime: SpecRuntime;
  readonly proposals: SpecProposals;
  /** Reactive: the mounted editor spec. */
  readonly spec: EditorSpec | undefined;
  /** Reactive: the mounted lens. */
  readonly lens: LensContribution | undefined;
  /** Reactive. */
  readonly density: Density;
  /** Reactive: the picked tool (the first tool after each spec change, unless the picked one stays). */
  readonly activeTool: ToolId | undefined;
  /** Mount the initial spec (as a preset). */
  open(signal?: AbortSignal): Promise<Result<SpecApplied>>;
  switchLens(lens: LensContributionId, signal?: AbortSignal): Promise<Result<SpecProposal>>;
  setDensity(density: Density, signal?: AbortSignal): Promise<Result<SpecProposal>>;
  selectTool(tool: ToolId): Result<void>;
  /** Pin or unpin a mounted slot (`panel:instaflow/layers`). */
  togglePin(slot: SpecSlotKey): Result<boolean>;
  /** Register the Studio shortcuts (lenses, tools, HUD, command bar) for the lifetime of `scope`. */
  bindShortcuts(registry: ShortcutRegistry, targets: StudioFocusTargets, scope: Scope): Result<void>;
  dispose(): Promise<void>;
}

const settled = (proposal: SpecProposal): Result<SpecProposal> =>
  proposal.state === 'mounted' || proposal.error === undefined ? ok(proposal) : err(proposal.error as SfError);

export function createStudio(options: StudioOptions): Studio {
  const port = createSpecLayoutPort(options.wait === undefined ? {} : { wait: options.wait });
  const runtime = createSpecRuntime({
    vocabulary: options.registries.vocabulary,
    port,
    decide: options.decideFor('principal'),
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  });
  const proposals = createSpecProposals({ runtime, decideFor: options.decideFor, ...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }) });
  const picked = box<ToolId | undefined>(undefined);

  const mountedTools = (): ToolId[] => runtime.layout.slots.filter((s) => s.section === EditorSection.tool).map((s) => s.id);
  const activeTool = (): ToolId | undefined => {
    const tools = mountedTools();
    const choice = picked.get();
    return choice !== undefined && tools.includes(choice) ? choice : tools[0];
  };
  const change = async (next: (base: EditorSpec) => EditorSpec, signal?: AbortSignal): Promise<Result<SpecProposal>> => {
    const base = proposals.current ?? options.spec ?? studioSpec;
    const spec = next(base);
    // Record the person's pins that the next spec names (saved specs keep them); the runtime retains the others anyway.
    const named = new Set(toShellSpec(spec).slots.map((s) => slotKey(s.section, s.id)));
    const pins = [...runtime.pinned].filter((key) => named.has(key));
    const proposal = await proposals.propose({ ...spec, pinned: pins }, PERSON, signal === undefined ? {} : { signal });
    return settled(proposal);
  };

  const studio: Studio = {
    registries: options.registries,
    port,
    runtime,
    proposals,
    get spec() {
      return proposals.current;
    },
    get lens() {
      const id = proposals.current?.lens;
      return id === undefined ? undefined : options.registries.lens(id);
    },
    get density() {
      return proposals.current?.density ?? DEFAULT_DENSITY;
    },
    get activeTool() {
      return activeTool();
    },
    async open(signal) {
      const proposal = await proposals.propose(options.spec ?? studioSpec, PRESET, signal === undefined ? {} : { signal });
      if (proposal.applied !== undefined && proposal.state === 'mounted') return ok(proposal.applied);
      return err(proposal.error as SfError);
    },
    switchLens: (lens, signal) => change((base) => studioSpecFor(lens, base), signal),
    setDensity: (density, signal) => change((base) => ({ ...base, density }), signal),
    selectTool(tool) {
      if (!mountedTools().includes(tool)) return err(SpecSlotError({ message: `Tool ${tool} is not in this editor.`, details: { slot: slotOf('tool', tool) } }));
      picked.set(tool);
      return ok();
    },
    togglePin(slot) {
      if (runtime.pinned.has(slot)) {
        const unpinned = runtime.unpin(slot);
        return unpinned.ok ? ok(false) : unpinned;
      }
      const pinned = runtime.pin(slot);
      return pinned.ok ? ok(true) : pinned;
    },
    bindShortcuts(registry, targets, scope) {
      const bindings: { def: ReturnType<typeof defineShortcut>; run: () => void; when?: () => boolean }[] = [
        ...options.registries.lenses.flatMap((lens) =>
          lens.shortcut === undefined
            ? []
            : [{ def: defineShortcut({ id: `${lens.id}-shortcut`, keys: [lens.shortcut], scope: StudioShortcutScope, description: `Switch to ${lens.label}` }), run: () => void studio.switchLens(lens.id) }],
        ),
        ...[...new Set(mountedToolsAll(options.registries))].flatMap((tool) =>
          tool.shortcut === undefined
            ? []
            : [
                {
                  def: defineShortcut({ id: `${tool.id}-shortcut`, keys: [tool.shortcut], scope: StudioShortcutScope, description: `${tool.label} tool` }),
                  run: () => void studio.selectTool(tool.id),
                  when: () => mountedTools().includes(tool.id),
                },
              ],
        ),
        { def: defineShortcut({ id: 'instaflow/focus-hud', keys: ['Alt+Enter'], scope: StudioShortcutScope, description: 'Focus the HUD' }), run: () => targets.focusHud() },
        { def: defineShortcut({ id: 'instaflow/focus-command-bar', keys: ['Mod+K'], scope: StudioShortcutScope, description: 'Ask or type a command', allowInInputs: true }), run: () => targets.focusCommandBar() },
        { def: defineShortcut({ id: 'instaflow/focus-canvas', keys: ['Escape'], scope: StudioShortcutScope, description: 'Back to the canvas', allowInInputs: true }), run: () => targets.focusCanvas() },
      ];
      for (const binding of bindings) {
        const registered = registry.register(binding.def, () => binding.run(), { scope, ...(binding.when === undefined ? {} : { when: binding.when }) });
        if (!registered.ok) return registered;
      }
      registry.activate(StudioShortcutScope, scope);
      return ok();
    },
    dispose: () => runtime.dispose(),
  };
  return studio;
}

/** Every registered tool (shortcuts are registered once; `when` checks the tool is mounted). */
function mountedToolsAll(registries: EditorRegistries) {
  return registries.vocabulary.list(EditorSection.tool).flatMap((c) => {
    const tool = registries.tool(c.id);
    return tool === undefined ? [] : [tool];
  });
}
