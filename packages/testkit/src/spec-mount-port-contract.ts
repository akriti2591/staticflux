/**
 * `SpecMountPort` contract suite (R13.27–R13.28): any port the spec runtime drives — the reactive
 * `createSpecLayoutPort`, an app's DOM shell — must show exactly the runtime's layout after every
 * `apply` resolves, whatever the sequence of specs, with motion on or off, and be empty after dispose.
 * The suite drives the port with the reference runtime (`createSpecRuntime`) over the suite vocabulary
 * (`specContractVocabulary()`: sections `lens`, `tool`, `panel` with placements `dock` and `inspector`).
 *
 * @example
 * runSpecMountPortContract('layout model', {
 *   create: async () => { const port = createSpecLayoutPort(); return { port, groups: () => port.groups(), dispose: async () => {} }; },
 * }, { describe, it });
 */
import { createSpecRuntime, type ShellSpec, type SpecContributionId, type SpecMountPort, type SpecRuntime, type SpecSlotKey } from '@staticflux/shell/spec';
import fc from 'fast-check';
import { assertEqual, type ContractRunner, okValue } from './contract-runner.js';
import { specContractVocabulary } from './spec-runtime-contract.js';

export interface SpecMountPortHandle {
  readonly port: SpecMountPort;
  /** What the port shows: slot keys per `<section>@<placement>` group, in order (exiting slots excluded). */
  groups(): Readonly<Record<string, readonly SpecSlotKey[]>> | Promise<Readonly<Record<string, readonly SpecSlotKey[]>>>;
  dispose(): Promise<void>;
}

export interface SpecMountPortContractSubject {
  readonly create: () => Promise<SpecMountPortHandle>;
}

export interface SpecMountPortContractOptions {
  readonly skip?: readonly string[];
  /** Property-test runs (default 15). */
  readonly numRuns?: number;
  readonly seed?: number;
}

export interface SpecMountPortContractCase {
  readonly name: string;
  run(subject: SpecMountPortContractSubject, options: SpecMountPortContractOptions): Promise<void>;
}

const TOOLS = ['contract/t0', 'contract/t1', 'contract/t2', 'contract/t3', 'contract/t4', 'contract/t5'] as const;
const PANELS = ['contract/p0', 'contract/p1', 'contract/p2'] as const;

const spec = (n: number, lens: 0 | 1, tools: readonly number[], panels: readonly [number, 'dock' | 'inspector'][] = []): ShellSpec => {
  const lensId = (lens === 0 ? 'contract/lens-a' : 'contract/lens-b') as SpecContributionId;
  return {
    id: `contract/port-${n}`,
    context: { lens: lensId },
    slots: [
      { section: 'lens', id: lensId },
      ...tools.map((t) => ({ section: 'tool', id: TOOLS[t] as SpecContributionId })),
      ...panels.map(([p, placement]) => ({ section: 'panel', id: PANELS[p] as SpecContributionId, placement })),
    ],
  };
};

const expected = (runtime: SpecRuntime): Record<string, SpecSlotKey[]> => {
  const out: Record<string, SpecSlotKey[]> = {};
  for (const slot of [...runtime.layout.slots].sort((a, b) => a.index - b.index)) (out[`${slot.section}@${slot.placement}`] ??= []).push(slot.key);
  return out;
};

const sameGroups = async (handle: SpecMountPortHandle, runtime: SpecRuntime, message: string): Promise<void> => {
  const shown = await handle.groups();
  const normalized = Object.fromEntries(Object.entries(shown).filter(([, keys]) => keys.length > 0).map(([g, keys]) => [g, [...keys]]));
  assertEqual(normalized, expected(runtime), message);
};

export const specMountPortContractCases: readonly SpecMountPortContractCase[] = [
  {
    name: 'shows the mounted slots per group in display order',
    async run(subject) {
      const handle = await subject.create();
      const runtime = createSpecRuntime({ vocabulary: specContractVocabulary(), port: handle.port, reducedMotion: () => true });
      okValue(await runtime.apply(spec(0, 0, [2, 0, 1], [[0, 'dock'], [1, 'inspector']])), 'apply');
      await sameGroups(handle, runtime, 'first spec');
      await runtime.dispose();
      await handle.dispose();
    },
  },
  {
    name: 'follows reorders, placement moves, lens swaps and removals',
    async run(subject) {
      const handle = await subject.create();
      const runtime = createSpecRuntime({ vocabulary: specContractVocabulary(), port: handle.port, reducedMotion: () => true });
      const steps = [
        spec(0, 0, [0, 1, 2, 3], [[0, 'dock'], [1, 'dock']]),
        spec(1, 1, [3, 0, 4], [[1, 'inspector'], [0, 'dock']]),
        spec(2, 1, [4, 5, 0, 3], [[2, 'dock'], [0, 'inspector']]),
        spec(3, 0, [], []),
      ];
      for (const [n, s] of steps.entries()) {
        okValue(await runtime.apply(s), `apply ${n}`);
        await sameGroups(handle, runtime, `after spec ${n}`);
      }
      await runtime.dispose();
      await handle.dispose();
    },
  },
  {
    name: 'with motion on: after `apply` resolves, exiting slots are gone and entering ones are shown',
    async run(subject) {
      const handle = await subject.create();
      const runtime = createSpecRuntime({ vocabulary: specContractVocabulary(), port: handle.port, motion: { enterMs: 120, exitMs: 120, moveMs: 120, contextMs: 120 } });
      okValue(await runtime.apply(spec(0, 0, [0, 1, 2])), 'apply');
      okValue(await runtime.apply(spec(1, 1, [2, 4])), 'apply with motion');
      await sameGroups(handle, runtime, 'after motion');
      await runtime.dispose();
      await handle.dispose();
    },
  },
  {
    name: 'is empty after the runtime disposes',
    async run(subject) {
      const handle = await subject.create();
      const runtime = createSpecRuntime({ vocabulary: specContractVocabulary(), port: handle.port, reducedMotion: () => true });
      okValue(await runtime.apply(spec(0, 0, [0, 1], [[0, 'dock']])), 'apply');
      await runtime.dispose();
      const shown = await handle.groups();
      assertEqual(Object.values(shown).flat().length, 0, 'nothing shown');
      await handle.dispose();
    },
  },
  {
    name: 'property: random spec sequences always show the runtime layout',
    async run(subject, options) {
      const shapeArb = fc.record({
        lens: fc.constantFrom(0 as const, 1 as const),
        tools: fc.uniqueArray(fc.nat(TOOLS.length - 1), { maxLength: TOOLS.length }),
        panels: fc.uniqueArray(fc.tuple(fc.nat(PANELS.length - 1), fc.constantFrom('dock' as const, 'inspector' as const)), { maxLength: 3, selector: (p) => p[0] }),
      });
      await fc.assert(
        fc.asyncProperty(fc.array(shapeArb, { minLength: 1, maxLength: 6 }), async (shapes) => {
          const handle = await subject.create();
          const runtime = createSpecRuntime({ vocabulary: specContractVocabulary(), port: handle.port, reducedMotion: () => true });
          for (const [n, shape] of shapes.entries()) {
            okValue(await runtime.apply(spec(n, shape.lens, shape.tools, shape.panels)), `apply ${n}`);
            await sameGroups(handle, runtime, `after spec ${n}`);
          }
          await runtime.dispose();
          await handle.dispose();
        }),
        { numRuns: options.numRuns ?? 15, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
    },
  },
];

export function runSpecMountPortContract(name: string, subject: SpecMountPortContractSubject, runner: ContractRunner, options: SpecMountPortContractOptions = {}): void {
  runner.describe(`SpecMountPort contract: ${name}`, () => {
    for (const c of specMountPortContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(subject, options));
    }
  });
}
