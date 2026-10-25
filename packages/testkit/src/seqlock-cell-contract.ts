/**
 * Seqlock cell contract (SF-Δ18): `createCell` / `attachCell` on every pipe
 * medium. Latest wins, readers get private stable copies, waits wake on new
 * generations, mismatched endpoints are refused.
 *
 * @example
 * import { describe, it } from 'vitest';
 * for (const medium of availablePipeMedia()) runSeqlockCellContract(medium, { describe, it });
 */
import { defineLayout } from '@staticflux/worker/channels';
import {
  attachCell,
  type CellReader,
  createCell,
  defineCell,
  PipeClosedError,
  PipeMismatchError,
} from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';
import { mediumOptions, type PipeContractMedium, settle } from './pipe-contract-support.js';

const FrameLayout = defineLayout({ name: 'ContractFrame', fields: { seq: 'u32', x: 'f64', y: 'f64', flags: 'u8' } });
const Frame = defineCell({ id: 'contract/frame', layout: FrameLayout, checksum: true });
const OtherFrame = defineCell({ id: 'contract/other-frame', layout: FrameLayout });
const FrameV2 = defineCell({ id: 'contract/frame', layout: FrameLayout, checksum: true, version: 2 });

export interface SeqlockCellContractCase {
  readonly name: string;
  run(medium: PipeContractMedium): Promise<void>;
}

const TIMEOUT = 2_000;

async function readAfterWait(reader: Pick<CellReader, 'wait'>, label: string): Promise<void> {
  okValue(await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT + 500, label), label);
}

async function open(medium: PipeContractMedium) {
  const writer = okValue(createCell(Frame, mediumOptions(medium)), 'createCell');
  const reader = okValue(await within(attachCell(Frame, okValue(writer.endpoint(), 'endpoint')), TIMEOUT, 'attachCell'), 'attachCell');
  return { writer, reader };
}

export const seqlockCellContractCases: readonly SeqlockCellContractCase[] = [
  {
    name: 'reads nothing before the first write',
    async run(medium) {
      const { writer, reader } = await open(medium);
      assertEqual(reader.read(), undefined, 'no value yet');
      assertEqual(reader.generation, 0, 'generation 0');
      writer.close();
    },
  },
  {
    name: 'publishes layout values with increasing generations (latest wins)',
    async run(medium) {
      const { writer, reader } = await open(medium);
      for (let i = 1; i <= 3; i++) {
        const generation = okValue(
          writer.write(({ record }) => {
            record.seq = i;
            record.x = i * 1.5;
            record.y = -i;
            record.flags = i & 1;
          }),
          'write',
        );
        assertEqual(generation, i, 'write returns the generation');
      }
      await readAfterWait(reader, 'wait');
      await settle();
      const snapshot = reader.read();
      assertTrue(snapshot !== undefined, 'a value');
      assertEqual(
        { generation: snapshot?.generation, seq: snapshot?.record.seq, x: snapshot?.record.x, y: snapshot?.record.y, flags: snapshot?.record.flags },
        { generation: 3, seq: 3, x: 4.5, y: -3, flags: 1 },
        'the latest value',
      );
      assertEqual({ torn: snapshot?.torn, stale: snapshot?.stale }, { torn: false, stale: false }, 'stable');
      assertEqual(reader.stats.torn, 0, 'no torn reads with the seqlock');
      writer.close();
    },
  },
  {
    name: 'gives readers a private copy that later writes do not change',
    async run(medium) {
      const { writer, reader } = await open(medium);
      writer.write(({ record }) => {
        record.seq = 7;
      });
      await readAfterWait(reader, 'wait');
      const first = reader.read();
      writer.write(({ record }) => {
        record.seq = 8;
      });
      await settle();
      assertEqual(first?.record.seq, 7, 'the copy is stable until the next read');
      assertEqual(reader.read()?.record.seq, 8, 'the next read sees the new value');
      writer.close();
    },
  },
  {
    name: 'wait() wakes on a new generation, times out, and reports latest',
    async run(medium) {
      const { writer, reader } = await open(medium);
      assertEqual(okValue(await reader.wait({ timeoutMs: 10 }), 'timeout'), false, 'times out without writes');
      const waiting = reader.wait({ timeoutMs: TIMEOUT });
      writer.write(({ record }) => {
        record.seq = 1;
      });
      assertEqual(okValue(await within(waiting, TIMEOUT + 500, 'wake'), 'wake'), true, 'woken by the write');
      await settle();
      assertEqual(reader.latest, 1, 'latest generation without copying');
      reader.read();
      assertEqual(okValue(await reader.wait({ timeoutMs: 10 }), 'no new'), false, 'nothing newer than the last read');
      const controller = new AbortController();
      const aborted = reader.wait({ signal: controller.signal });
      controller.abort();
      assertEqual(errOf(await aborted, 'abort').kind, 'aborted', 'abort ends the wait');
      writer.close();
    },
  },
  {
    name: 'serves several readers from one writer',
    async run(medium) {
      const writer = okValue(createCell(Frame, mediumOptions(medium)), 'createCell');
      const one = okValue(await attachCell(Frame, okValue(writer.endpoint(), 'e1')), 'r1');
      const two = okValue(await attachCell(Frame, okValue(writer.endpoint(), 'e2')), 'r2');
      writer.write(({ record }) => {
        record.seq = 42;
      });
      await readAfterWait(one, 'w1');
      await readAfterWait(two, 'w2');
      assertEqual([one.read()?.record.seq, two.read()?.record.seq], [42, 42], 'both readers');
      writer.close();
    },
  },
  {
    name: 'refuses endpoints of another cell, version or size (SF-WK-032)',
    async run(medium) {
      const writer = okValue(createCell(Frame, mediumOptions(medium)), 'createCell');
      const other = await attachCell(OtherFrame, okValue(writer.endpoint(), 'e1'));
      assertEqual(errOf(other, 'other id').code, PipeMismatchError.code, 'another cell id');
      const v2 = await attachCell(FrameV2, okValue(writer.endpoint(), 'e2'));
      assertEqual(errOf(v2, 'version').code, PipeMismatchError.code, 'another schema version');
      const small = defineCell({ id: 'contract/frame', bytes: 8 });
      const sized = await attachCell(small, okValue(writer.endpoint(), 'e3'));
      assertEqual(errOf(sized, 'size').code, PipeMismatchError.code, 'another size');
      writer.close();
    },
  },
  {
    name: 'close: writes fail with SF-WK-033 and readers see closed',
    async run(medium) {
      const { writer, reader } = await open(medium);
      writer.close();
      assertEqual(errOf(writer.write(() => undefined), 'write after close').code, PipeClosedError.code, 'write after close');
      await settle();
      assertTrue(reader.closed, 'reader sees closed');
      assertEqual(errOf(writer.endpoint(), 'endpoint after close').code, PipeClosedError.code, 'no endpoints after close');
    },
  },
];

export function runSeqlockCellContract(
  medium: PipeContractMedium,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`seqlock cell contract: ${medium.name}`, () => {
    for (const testCase of seqlockCellContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(medium));
    }
  });
}
