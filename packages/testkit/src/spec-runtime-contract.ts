/**
 * `SpecRuntime` contract suite (R13.25–R13.29, Instaflow D16). Runs against any spec runtime factory
 * (the reference `createSpecRuntime` from `@staticflux/shell/spec`, or an app's wrapper around it).
 *
 * Covers: closed vocabulary (unknown ids rejected with every issue listed, port untouched), context
 * mismatches, gating denials (SF-SHELL-012), port call order (unmounts in reverse display order, moves,
 * context, mounts in display order), 120–200 ms motion and 0 ms under reduced motion, disposal, and two
 * properties over random spec sequences: **minimality** (no slot both unmounted and mounted, mounts and
 * unmounts are exactly the set differences, moves are the minimum for the reorder, and the port's view
 * equals the runtime layout) and **pin preservation** (a pinned slot is never removed by a new spec).
 *
 * @example
 * runSpecRuntimeContract('reference', { runtime: (options) => createSpecRuntime(options) }, { describe, it });
 */
import { ok } from '@staticflux/core';
import {
  createSpecVocabulary,
  defineSpecContribution,
  defineSpecSection,
  groupKey,
  type ResolvedSlot,
  type ShellSpec,
  type SpecContributionId,
  type SpecMountPort,
  type SpecMotionStep,
  type SpecRuntime,
  type SpecRuntimeOptions,
  type SpecSlotKey,
  type SpecSlotRequest,
  type SpecVocabulary,
} from '@staticflux/shell/spec';
import { type DecidePort, gateResource } from '@staticflux/ui';
import fc from 'fast-check';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue } from './contract-runner.js';

export interface SpecRuntimeContractSubject {
  readonly runtime: (options: SpecRuntimeOptions) => SpecRuntime;
}

export interface SpecRuntimeContractOptions {
  readonly skip?: readonly string[];
  /** Property-test runs (default 40). */
  readonly numRuns?: number;
  readonly seed?: number;
}

export interface SpecRuntimeContractCase {
  readonly name: string;
  run(subject: SpecRuntimeContractSubject, options: SpecRuntimeContractOptions): Promise<void>;
}

const LENSES = ['contract/lens-a', 'contract/lens-b'] as const;
const TOOLS = ['contract/t0', 'contract/t1', 'contract/t2', 'contract/t3', 'contract/t4', 'contract/t5'] as const;
const PANELS = ['contract/p0', 'contract/p1', 'contract/p2', 'contract/p3'] as const;
const PLACEMENTS = ['dock', 'inspector'] as const;
const GATED = gateResource('ui-slot', 'contract/p3');

/** The suite's vocabulary: one lens section, pinnable tools and panels (two placements), one gated panel, one lens-b-only tool. */
export function specContractVocabulary(): SpecVocabulary {
  return okValue(
    createSpecVocabulary({
      sections: [
        defineSpecSection({ id: 'lens', cardinality: 'one' }),
        defineSpecSection({ id: 'tool', pinnable: true }),
        defineSpecSection({ id: 'panel', pinnable: true, placements: PLACEMENTS }),
      ],
      contributions: [
        ...LENSES.map((id) => defineSpecContribution({ section: 'lens', id })),
        ...TOOLS.map((id) => defineSpecContribution({ section: 'tool', id })),
        defineSpecContribution({ section: 'tool', id: 'contract/lens-b-only', when: { lens: ['contract/lens-b'] } }),
        ...PANELS.map((id) => defineSpecContribution({ section: 'panel', id, ...(id === GATED.id ? { gate: GATED } : {}) })),
      ],
    }),
    'contract vocabulary',
  );
}

interface PortCall {
  readonly op: 'mount' | 'move' | 'unmount' | 'context';
  readonly key: string;
  readonly step: SpecMotionStep;
}

/** A port that records calls and keeps its own view of the groups (insert after the anchor, like a DOM port). */
export function recordingSpecPort(): SpecMountPort & { readonly calls: PortCall[]; groups(): Record<string, SpecSlotKey[]> } {
  const calls: PortCall[] = [];
  const groups = new Map<string, SpecSlotKey[]>();
  const where = new Map<SpecSlotKey, string>();
  const remove = (key: SpecSlotKey): void => {
    const group = where.get(key);
    if (group === undefined) return;
    groups.set(group, (groups.get(group) ?? []).filter((k) => k !== key));
    where.delete(key);
  };
  const insert = (slot: ResolvedSlot, after: SpecSlotKey | undefined): void => {
    const group = groupKey(slot);
    const list = groups.get(group) ?? [];
    list.splice(after === undefined ? 0 : list.indexOf(after) + 1, 0, slot.key);
    groups.set(group, list);
    where.set(slot.key, group);
  };
  return {
    calls,
    groups: () => Object.fromEntries([...groups].filter(([, list]) => list.length > 0).map(([g, list]) => [g, [...list]])),
    mount(slot, after, step) {
      calls.push({ op: 'mount', key: slot.key, step });
      insert(slot, after);
      return ok();
    },
    move(move, step) {
      calls.push({ op: 'move', key: move.slot.key, step });
      remove(move.slot.key);
      insert(move.slot, move.after);
      return ok();
    },
    unmount(slot, step) {
      calls.push({ op: 'unmount', key: slot.key, step });
      remove(slot.key);
      return ok();
    },
    context(changes, _context, step) {
      calls.push({ op: 'context', key: changes.map((c) => c.key).join(','), step });
      return ok();
    },
  };
}

const runtimeGroups = (runtime: SpecRuntime): Record<string, SpecSlotKey[]> => {
  const out: Record<string, SpecSlotKey[]> = {};
  for (const slot of [...runtime.layout.slots].sort((a, b) => a.index - b.index)) (out[groupKey(slot)] ??= []).push(slot.key);
  return out;
};

const key = (section: string, id: string): SpecSlotKey => `${section}:${id}` as SpecSlotKey;

interface SpecShape {
  readonly lens: 0 | 1;
  readonly tools: readonly number[];
  readonly panels: readonly { readonly panel: number; readonly placement: 0 | 1 }[];
}

const toSpec = (shape: SpecShape, n: number, pinned: readonly SpecSlotKey[] = []): ShellSpec => {
  const lens = LENSES[shape.lens];
  const slots: SpecSlotRequest[] = [
    { section: 'lens', id: lens },
    ...shape.tools.map((t) => ({ section: 'tool', id: TOOLS[t] as SpecContributionId })),
    ...shape.panels.map((p) => ({ section: 'panel', id: PANELS[p.panel] as SpecContributionId, placement: PLACEMENTS[p.placement] })),
  ];
  return { id: `contract/spec-${n}`, context: { lens }, slots, pinned };
};

const shapeArb: fc.Arbitrary<SpecShape> = fc.record({
  lens: fc.constantFrom(0 as const, 1 as const),
  tools: fc.uniqueArray(fc.nat(TOOLS.length - 1), { maxLength: TOOLS.length }),
  // p3 is gated in some runs; the property suites only use p0–p2.
  panels: fc.uniqueArray(fc.record({ panel: fc.nat(2), placement: fc.constantFrom(0 as const, 1 as const) }), { maxLength: 3, selector: (p) => p.panel }),
});

/** Minimum moves for a reorder: group size minus the longest increasing run of old indices (O(n²) reference). */
const minimumMoves = (oldIndices: readonly number[]): number => {
  const best = oldIndices.map(() => 1);
  for (let i = 0; i < oldIndices.length; i++) {
    for (let j = 0; j < i; j++) if ((oldIndices[j] as number) < (oldIndices[i] as number)) best[i] = Math.max(best[i] as number, (best[j] as number) + 1);
  }
  return oldIndices.length - Math.max(0, ...best);
};

const fresh = (subject: SpecRuntimeContractSubject, extra: Partial<SpecRuntimeOptions> = {}) => {
  const port = recordingSpecPort();
  const runtime = subject.runtime({ vocabulary: specContractVocabulary(), port, ...extra });
  return { port, runtime };
};

const denyGated: DecidePort = { decide: (r) => (r.id === GATED.id ? { effect: 'deny', reason: 'forbidden' } : { effect: 'allow' }) };

const issueCodes = (error: { details: Readonly<Record<string, unknown>> }): string[] =>
  ((error.details as { issues?: { code: string }[] }).issues ?? []).map((i) => i.code);

export const specRuntimeContractCases: readonly SpecRuntimeContractCase[] = [
  {
    name: 'rejects unknown ids with every issue listed and leaves the port untouched',
    async run(subject) {
      const { port, runtime } = fresh(subject);
      const result = await runtime.apply({ id: 'x', context: { lens: LENSES[0] }, slots: [{ section: 'lens', id: LENSES[0] }, { section: 'tool', id: 'contract/missing' }, { section: 'nope', id: 'contract/t0' }] });
      const error = errOf(result, 'unknown ids');
      assertEqual(error.code, 'SF-SHELL-009', 'spec invalid');
      assertEqual(issueCodes(error), ['SF-SHELL-010', 'SF-SHELL-010'], 'one issue per unknown id');
      assertEqual(port.calls.length, 0, 'nothing mounted');
      assertEqual(runtime.layout.slots.length, 0, 'layout empty');
    },
  },
  {
    name: 'rejects slots outside the spec context (SF-SHELL-011)',
    async run(subject) {
      const { runtime } = fresh(subject);
      const error = errOf(await runtime.apply({ id: 'x', context: { lens: LENSES[0] }, slots: [{ section: 'lens', id: LENSES[0] }, { section: 'tool', id: 'contract/lens-b-only' }] }), 'context');
      assertEqual(issueCodes(error), ['SF-SHELL-011'], 'context mismatch');
      okValue(await runtime.apply({ id: 'y', context: { lens: LENSES[1] }, slots: [{ section: 'lens', id: LENSES[1] }, { section: 'tool', id: 'contract/lens-b-only' }] }), 'applies under lens b');
    },
  },
  {
    name: 'gates every slot: denials are SF-SHELL-012 and nothing mounts',
    async run(subject) {
      const { port, runtime } = fresh(subject, { decide: denyGated });
      const spec: ShellSpec = { id: 'g', context: { lens: LENSES[0] }, slots: [{ section: 'lens', id: LENSES[0] }, { section: 'panel', id: GATED.id as SpecContributionId }] };
      assertEqual(issueCodes(errOf(await runtime.apply(spec), 'gated')), ['SF-SHELL-012'], 'denied');
      assertEqual(port.calls.length, 0, 'port untouched');
    },
  },
  {
    name: 'drives the port in order: unmounts (reverse display order), moves, context, mounts (display order)',
    async run(subject) {
      const { port, runtime } = fresh(subject);
      okValue(await runtime.apply(toSpec({ lens: 0, tools: [0, 1, 2, 3], panels: [] }, 0)), 'first');
      port.calls.length = 0;
      okValue(await runtime.apply(toSpec({ lens: 1, tools: [3, 1, 4], panels: [] }, 1)), 'second');
      const ops = port.calls.map((c) => c.op);
      const last = (op: PortCall['op']): number => ops.lastIndexOf(op);
      const first = (op: PortCall['op']): number => ops.indexOf(op);
      assertTrue(last('unmount') < first('move') && last('move') < first('context') && last('context') < first('mount'), `order: ${ops.join(' ')}`);
      assertEqual(
        port.calls.filter((c) => c.op === 'unmount').map((c) => c.key),
        [key('tool', TOOLS[2]), key('tool', TOOLS[0]), key('lens', LENSES[0])],
        'unmounts in reverse display order',
      );
      assertEqual(port.calls.filter((c) => c.op === 'mount').map((c) => c.key), [key('lens', LENSES[1]), key('tool', TOOLS[4])], 'mounts in display order');
      assertEqual(port.groups(), runtimeGroups(runtime), 'port view equals the layout');
    },
  },
  {
    name: 'motion is 120–200 ms per change and 0 ms under reduced motion',
    async run(subject) {
      const normal = fresh(subject);
      okValue(await normal.runtime.apply(toSpec({ lens: 0, tools: [0, 1], panels: [] }, 0)), 'apply');
      okValue(await normal.runtime.apply(toSpec({ lens: 1, tools: [1, 0], panels: [] }, 1)), 'apply 2');
      assertTrue(normal.port.calls.every((c) => c.step.durationMs >= 120 && c.step.durationMs <= 200 && !c.step.reduced), 'within 120–200 ms');
      const reduced = fresh(subject, { reducedMotion: () => true });
      okValue(await reduced.runtime.apply(toSpec({ lens: 0, tools: [0, 1], panels: [] }, 0)), 'apply reduced');
      assertTrue(reduced.port.calls.every((c) => c.step.durationMs === 0 && c.step.reduced), '0 ms under reduced motion');
    },
  },
  {
    name: 'dispose unmounts everything and rejects later applies (SF-SHELL-015)',
    async run(subject) {
      const { port, runtime } = fresh(subject);
      okValue(await runtime.apply(toSpec({ lens: 0, tools: [0], panels: [{ panel: 0, placement: 0 }] }, 0)), 'apply');
      await runtime.dispose();
      assertEqual(port.groups(), {}, 'port empty');
      assertEqual(runtime.state, 'disposed', 'state');
      assertEqual(errOf(await runtime.apply(toSpec({ lens: 0, tools: [], panels: [] }, 1)), 'late').code, 'SF-SHELL-015', 'disposed');
    },
  },
  {
    name: 'property: diffs are minimal and the port view always equals the layout',
    async run(subject, options) {
      await fc.assert(
        fc.asyncProperty(fc.array(shapeArb, { minLength: 1, maxLength: 8 }), async (shapes) => {
          const { port, runtime } = fresh(subject);
          for (const [n, shape] of shapes.entries()) {
            const before = new Map(runtime.layout.slots.map((s) => [s.key, s] as const));
            port.calls.length = 0;
            const applied = okValue(await runtime.apply(toSpec(shape, n)), `apply ${n}`);
            const after = new Map(runtime.layout.slots.map((s) => [s.key, s] as const));
            const mounted = port.calls.filter((c) => c.op === 'mount').map((c) => c.key);
            const unmounted = port.calls.filter((c) => c.op === 'unmount').map((c) => c.key);
            assertEqual([...mounted].sort(), [...after.keys()].filter((k) => !before.has(k)).sort(), 'mounts = new \\ old');
            assertEqual([...unmounted].sort(), [...before.keys()].filter((k) => !after.has(k)).sort(), 'unmounts = old \\ new');
            assertTrue(!mounted.some((k) => unmounted.includes(k)), 'no slot is remounted');
            // Minimum moves: placement changes + per-group (size − longest kept run).
            let expected = 0;
            const groups = new Map<string, number[]>();
            for (const slot of runtime.layout.slots) {
              const old = before.get(slot.key);
              if (old === undefined) continue;
              if (old.placement !== slot.placement) expected += 1;
              else groups.set(groupKey(slot), [...(groups.get(groupKey(slot)) ?? []), old.index]);
            }
            for (const [group, olds] of groups) {
              const ordered = runtime.layout.slots.filter((s) => groupKey(s) === group && before.get(s.key)?.placement === s.placement).sort((a, b) => a.index - b.index);
              expected += minimumMoves(ordered.map((s) => (before.get(s.key) as ResolvedSlot).index));
              assertEqual(olds.length, ordered.length, 'group bookkeeping');
            }
            assertEqual(applied.diff.move.length, expected, 'moves are minimal');
            assertEqual(port.calls.filter((c) => c.op === 'move').length, expected, 'port saw the minimal moves');
            assertEqual(port.groups(), runtimeGroups(runtime), 'port view equals the layout');
          }
          await runtime.dispose();
        }),
        { numRuns: options.numRuns ?? 40, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
    },
  },
  {
    name: 'property: a pinned slot is never removed by a new spec',
    async run(subject, options) {
      const step = fc.record({ shape: shapeArb, pin: fc.option(fc.nat(20), { nil: undefined }), unpin: fc.boolean() });
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
          const { port, runtime } = fresh(subject);
          for (const [n, s] of steps.entries()) {
            const pinnedBefore = [...runtime.pinned];
            okValue(await runtime.apply(toSpec(s.shape, n)), `apply ${n}`);
            const present = new Set(runtime.layout.slots.map((slot) => slot.key));
            for (const pinned of pinnedBefore) assertTrue(present.has(pinned), `pinned ${pinned} survived spec ${n}`);
            assertEqual(port.groups(), runtimeGroups(runtime), 'port view equals the layout');
            const candidates = runtime.layout.slots.filter((slot) => slot.section !== 'lens');
            if (s.pin !== undefined && candidates.length > 0) okValue(runtime.pin((candidates[s.pin % candidates.length] as ResolvedSlot).key), 'pin');
            if (s.unpin && runtime.pinned.size > 3) okValue(runtime.unpin([...runtime.pinned][0] as SpecSlotKey), 'unpin');
          }
          await runtime.dispose();
        }),
        { numRuns: options.numRuns ?? 40, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
    },
  },
];

export function runSpecRuntimeContract(name: string, subject: SpecRuntimeContractSubject, runner: ContractRunner, options: SpecRuntimeContractOptions = {}): void {
  runner.describe(`SpecRuntime contract: ${name}`, () => {
    for (const c of specRuntimeContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(subject, options));
    }
  });
}
