/**
 * Record ring contract (SF-Δ18, SF-Δ22): `createRecordRing` / `attachRecordRing`
 * on every pipe medium. Lossless in order for every reader, back-pressure queues
 * instead of dropping, readers are independent, closed or released readers stop
 * holding the writer back.
 *
 * @example
 * for (const medium of availablePipeMedia()) runRecordRingContract(medium, { describe, it });
 */
import { defineLayout, type Layout } from '@staticflux/worker/channels';
import {
  attachRecordRing,
  createRecordRing,
  defineRecordRing,
  PipeEndpointTakenError,
  PipeMismatchError,
  PipeOverflowError,
  type RecordRingReader,
} from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';
import { eventually, mediumOptions, type PipeContractMedium, settle } from './pipe-contract-support.js';

const SampleLayout = defineLayout({ name: 'ContractSample', fields: { ts: 'f64', value: 'u32', kind: 'u8' } });
const Samples = defineRecordRing({ id: 'contract/samples', layout: SampleLayout, capacity: 8, readers: 2 });
const OtherSamples = defineRecordRing({ id: 'contract/other-samples', layout: SampleLayout, capacity: 8, readers: 2 });

export interface RecordRingContractCase {
  readonly name: string;
  run(medium: PipeContractMedium): Promise<void>;
}

const TIMEOUT = 2_000;

type SampleFields = typeof SampleLayout extends Layout<infer F> ? F : never;
type SampleReader = RecordRingReader<SampleFields>;

/** Drain until `count` values arrived (waiting between batches). */
async function collect(reader: SampleReader, count: number): Promise<number[]> {
  const values: number[] = [];
  const deadline = Date.now() + TIMEOUT;
  while (values.length < count) {
    if (Date.now() > deadline) throw new Error(`collected ${values.length} of ${count} records`);
    reader.drain((record) => {
      values.push(record.value);
    });
    if (values.length < count) await within(reader.wait({ timeoutMs: 50 }), TIMEOUT, 'wait');
  }
  return values;
}

const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);

export const recordRingContractCases: readonly RecordRingContractCase[] = [
  {
    name: 'delivers records in order with sequence numbers and field values',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      const reader = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(0), 'endpoint')), 'attach');
      for (const i of range(5)) {
        okValue(
          ring.push((r) => {
            r.ts = 1000 + i / 4;
            r.value = i * 10;
            r.kind = i % 3;
          }),
          'push',
        );
      }
      await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT + 500, 'wait');
      await settle();
      const seen: { seq: number; ts: number; value: number; kind: number }[] = [];
      reader.drain((r, seq) => {
        seen.push({ seq, ts: r.ts, value: r.value, kind: r.kind });
      });
      assertEqual(
        seen,
        range(5).map((i) => ({ seq: i, ts: 1000 + i / 4, value: i * 10, kind: i % 3 })),
        'all records, in order',
      );
      assertEqual(reader.available, 0, 'drained');
      ring.close();
    },
  },
  {
    name: 'queues under back-pressure and loses nothing',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      const reader = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(0), 'endpoint')), 'attach');
      const outcomes = range(30).map((i) =>
        okValue(
          ring.push((r) => {
            r.value = i;
          }),
          'push',
        ),
      );
      assertEqual(outcomes.slice(0, 8), Array(8).fill('written'), 'the first capacity records are written');
      assertTrue(outcomes.slice(8).every((o) => o === 'queued'), 'the rest is queued');
      assertTrue(ring.stats.pending > 0, 'pending records');
      assertEqual(await collect(reader, 30), range(30), 'every record, in order');
      await eventually(() => ring.stats.pending === 0, TIMEOUT, 'queue flushed');
      assertEqual(ring.stats.maxPending, 22, 'largest queue');
      ring.close();
    },
  },
  {
    name: 'gives each reader every record independently',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      const one = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(0), 'e0')), 'r0');
      const two = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(1), 'e1')), 'r1');
      for (const i of range(12)) ring.push((r) => void (r.value = i));
      // Lossless SPMC: the slowest reader holds the writer back, so both drain concurrently.
      const [first, second] = await Promise.all([collect(one, 12), collect(two, 12)]);
      assertEqual(first, range(12), 'reader 0');
      assertEqual(second, range(12), 'reader 1');
      ring.close();
    },
  },
  {
    name: 'a reader sees records pushed after its endpoint was made',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      for (const i of range(3)) ring.push((r) => void (r.value = i));
      const late = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(1), 'e1')), 'late');
      ring.push((r) => void (r.value = 99));
      assertEqual(await collect(late, 1), [99], 'only the new record');
      ring.close();
    },
  },
  {
    name: 'closed and released readers stop holding the writer back',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      const slow = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(0), 'e0')), 'slow');
      for (const i of range(8)) ring.push((r) => void (r.value = i));
      assertEqual(okValue(ring.push((r) => void (r.value = 8)), 'full'), 'queued', 'full ring queues');
      slow.close();
      await eventually(() => ring.stats.pending === 0, TIMEOUT, 'queue flushed after close');
      assertEqual(okValue(ring.push((r) => void (r.value = 9)), 'push'), 'written', 'no reader holds it back');

      const dead = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(1), 'e1')), 'dead');
      void dead; // a reader that crashed: it never closes
      for (const i of range(9)) ring.push((r) => void (r.value = i));
      assertTrue(ring.stats.pending > 0, 'the dead reader holds the writer back');
      ring.release(1);
      assertEqual(ring.stats.pending, 0, 'release flushes');
      const fresh = okValue(await attachRecordRing(Samples, okValue(ring.endpoint(1), 'e1 again')), 'respawned reader');
      ring.push((r) => void (r.value = 77));
      assertEqual(await collect(fresh, 1), [77], 'the respawned reader gets new records');
      ring.close();
    },
  },
  {
    name: 'fails beyond maxPending with SF-WK-036 and counts drops',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, { ...mediumOptions(medium), maxPending: 2 }), 'create');
      okValue(await attachRecordRing(Samples, okValue(ring.endpoint(0), 'e0')), 'attach');
      for (const i of range(10)) ring.push((r) => void (r.value = i));
      const overflow = ring.push((r) => void (r.value = 99));
      assertEqual(errOf(overflow, 'overflow').code, PipeOverflowError.code, 'overflow error');
      assertTrue(ring.stats.dropped >= 1, 'drops counted');
      ring.close();
    },
  },
  {
    name: 'validates reader indices and endpoints',
    async run(medium) {
      const ring = okValue(createRecordRing(Samples, mediumOptions(medium)), 'create');
      assertEqual(errOf(ring.endpoint(2), 'out of range').code, PipeMismatchError.code, 'index out of range');
      okValue(ring.endpoint(0), 'first');
      assertEqual(errOf(ring.endpoint(0), 'twice').code, PipeEndpointTakenError.code, 'one endpoint per reader');
      const other = await attachRecordRing(OtherSamples, okValue(ring.endpoint(1), 'e1'));
      assertEqual(errOf(other, 'other ring').code, PipeMismatchError.code, 'another ring');
      ring.close();
    },
  },
];

export function runRecordRingContract(
  medium: PipeContractMedium,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`record ring contract: ${medium.name}`, () => {
    for (const testCase of recordRingContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(medium));
    }
  });
}
