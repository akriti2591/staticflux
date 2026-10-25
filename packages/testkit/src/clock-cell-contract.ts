/**
 * Clock cell contract (SF-Δ18, for M3): `createClockCell` / `attachClockCell` on
 * every pipe medium. Readers extrapolate the published position in their own
 * time without messages; state changes, rate and epoch arrive intact.
 *
 * @example
 * for (const medium of availablePipeMedia()) runClockCellContract(medium, { describe, it });
 */
import { attachClockCell, createClockCell, defineClockCell } from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, okValue, within } from './contract-runner.js';
import { mediumOptions, type PipeContractMedium, settle } from './pipe-contract-support.js';

const Playhead = defineClockCell({ id: 'contract/playhead' });

export interface ClockCellContractCase {
  readonly name: string;
  run(medium: PipeContractMedium): Promise<void>;
}

const TIMEOUT = 2_000;

async function open(medium: PipeContractMedium) {
  const writer = okValue(createClockCell(Playhead, mediumOptions(medium)), 'create');
  const reader = okValue(await within(attachClockCell(Playhead, okValue(writer.endpoint(), 'endpoint')), TIMEOUT, 'attach'), 'attach');
  return { writer, reader };
}

export const clockCellContractCases: readonly ClockCellContractCase[] = [
  {
    name: 'samples nothing before the first publish',
    async run(medium) {
      const { writer, reader } = await open(medium);
      assertEqual(reader.sample(0), undefined, 'no clock yet');
      writer.close();
    },
  },
  {
    name: 'extrapolates a playing clock and holds a paused one',
    async run(medium) {
      const { writer, reader } = await open(medium);
      okValue(writer.publish({ position: 10, state: 'playing', rate: 2, anchor: 1_000 }), 'publish');
      await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT + 500, 'wait');
      await settle();
      const playing = reader.sample(1_500);
      assertEqual({ position: playing?.position, state: playing?.state, rate: playing?.rate }, { position: 11, state: 'playing', rate: 2 }, '10 s + 2 × 0.5 s');
      okValue(writer.publish({ position: 11, state: 'paused', anchor: 1_500 }), 'pause');
      await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT + 500, 'wait');
      await settle();
      assertEqual(reader.sample(9_000)?.position, 11, 'paused clocks do not move');
      assertEqual(reader.sample(9_000)?.rate, 2, 'unspecified fields keep their value');
      writer.close();
    },
  },
  {
    name: 'carries epochs and generations for discontinuities',
    async run(medium) {
      const { writer, reader } = await open(medium);
      okValue(writer.publish({ position: 0, state: 'playing', anchor: 0 }), 'publish');
      okValue(writer.publish({ position: 42, state: 'seeking', anchor: 10, epoch: 3 }), 'seek');
      await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT + 500, 'wait');
      await settle();
      const sample = reader.sample(20);
      assertEqual({ position: sample?.position, state: sample?.state, epoch: sample?.epoch, generation: sample?.generation }, { position: 42, state: 'seeking', epoch: 3, generation: 2 }, 'seek published');
      assertTrue(writer.generation === 2, 'writer generation');
      writer.close();
    },
  },
];

export function runClockCellContract(
  medium: PipeContractMedium,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`clock cell contract: ${medium.name}`, () => {
    for (const testCase of clockCellContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(medium));
    }
  });
}
