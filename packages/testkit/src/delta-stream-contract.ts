/**
 * Delta stream contract (SF-Δ18, ARCHITECTURE §4 E-1): `createDeltaStream` /
 * `attachDeltaStream` on every pipe medium, checked against an oracle (the
 * writer's state). Ordered apply, apply up to a version, gap → resnapshot,
 * lossless back-pressure, overflow healing, blob refs blocking the stream, and a
 * respawned reader recovering from a snapshot.
 *
 * @example
 * for (const medium of availablePipeMedia()) runDeltaStreamContract(medium, { describe, it });
 */
import {
  attachDeltaStream,
  type BlobResolver,
  createDeltaStream,
  defineDeltaStream,
  DeltaOrderError,
  type DeltaRecord,
  type DeltaStreamDefinition,
  type DeltaStreamReader,
  type DeltaStreamWriter,
  PipeMismatchError,
  PipeOverflowError,
  RecordTooLargeError,
} from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';
import { mediumOptions, type PipeContractMedium } from './pipe-contract-support.js';

const Scene = defineDeltaStream({ id: 'contract/scene', capacityBytes: 4096 });
const TinyScene = defineDeltaStream({ id: 'contract/tiny-scene', capacityBytes: 256 });
const OtherScene = defineDeltaStream({ id: 'contract/other-scene', capacityBytes: 4096 });

export interface DeltaStreamContractCase {
  readonly name: string;
  run(medium: PipeContractMedium): Promise<void>;
}

const TIMEOUT = 3_000;

/** Oracle document: id → value. Payloads are u32 pairs (id, value). */
type Doc = Map<number, number>;

const encode = (pairs: readonly (readonly [number, number])[]): Uint8Array => {
  const words = new Uint32Array(pairs.length * 2);
  pairs.forEach(([id, value], i) => {
    words[2 * i] = id;
    words[2 * i + 1] = value;
  });
  return new Uint8Array(words.buffer);
};
const decode = (payload: Uint8Array): [number, number][] => {
  const copy = payload.slice();
  const words = new Uint32Array(copy.buffer, 0, copy.byteLength / 4);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < words.length; i += 2) out.push([words[i] as number, words[i + 1] as number]);
  return out;
};
const snapshotOf = (doc: Doc): Uint8Array => encode([...doc]);

/** Reader-side state rebuilt only from the stream. */
function replica(): { doc: Doc; apply(record: DeltaRecord): void; records: DeltaRecord['kind'][] } {
  const doc: Doc = new Map();
  const records: DeltaRecord['kind'][] = [];
  return {
    doc,
    records,
    apply(record) {
      records.push(record.kind);
      if (record.kind === 'snapshot') doc.clear();
      for (const [id, value] of decode(record.payload)) doc.set(id, value);
    },
  };
}

/** Apply until `done()` (waiting for more records in between). */
async function pump(
  reader: DeltaStreamReader,
  handler: (record: DeltaRecord) => void,
  done: () => boolean,
  options: Parameters<DeltaStreamReader['apply']>[1] = {},
): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  for (;;) {
    reader.apply(handler, options);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`stream did not converge (state ${reader.state}, version ${reader.version})`);
    await within(reader.wait({ timeoutMs: 10 }), TIMEOUT, 'wait');
  }
}

/** Writer + oracle: every committed change goes to both. */
function author(writer: DeltaStreamWriter): {
  doc: Doc;
  commit(pairs: readonly (readonly [number, number])[]): void;
  /** Commit, but announce a base the reader never saw (a lost delta). */
  commitAfterLoss(pairs: readonly (readonly [number, number])[]): void;
  snapshot(): void;
} {
  const doc: Doc = new Map();
  let version = 0;
  return {
    doc,
    commit(pairs) {
      version += 1;
      for (const [id, value] of pairs) doc.set(id, value);
      okValue(writer.append({ version, payload: encode(pairs) }), 'append');
    },
    commitAfterLoss(pairs) {
      version += 2;
      for (const [id, value] of pairs) doc.set(id, value);
      okValue(writer.append({ version, base: version - 1, payload: encode(pairs) }), 'append after loss');
    },
    snapshot() {
      okValue(writer.snapshot({ version, payload: snapshotOf(doc) }), 'snapshot');
    },
  };
}

const sameDoc = (a: Doc, b: Doc): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

async function open(medium: PipeContractMedium, definition: DeltaStreamDefinition = Scene, extra: { readonly maxPendingBytes?: number } = {}) {
  const writer = okValue(createDeltaStream(definition, { ...mediumOptions(medium), ...extra }), 'create');
  const reader = okValue(await within(attachDeltaStream(definition, okValue(writer.endpoint(), 'endpoint')), TIMEOUT, 'attach'), 'attach');
  return { writer, reader };
}

export const deltaStreamContractCases: readonly DeltaStreamContractCase[] = [
  {
    name: 'applies a snapshot, then deltas in order',
    async run(medium) {
      const { writer, reader } = await open(medium);
      const editor = author(writer);
      editor.commit([[1, 10]]);
      editor.snapshot();
      editor.commit([[2, 20]]);
      editor.commit([[1, 11]]);
      const render = replica();
      await pump(reader, render.apply, () => reader.version === 3);
      assertEqual({ state: reader.state, epoch: reader.epoch, version: reader.version }, { state: 'live', epoch: 1, version: 3 }, 'live at v3');
      assertTrue(sameDoc(render.doc, editor.doc), 'render state equals the oracle');
      assertEqual(render.records, ['snapshot', 'delta', 'delta'], 'the pre-snapshot delta is skipped');
      writer.close();
    },
  },
  {
    name: 'applies only up to the view frame version',
    async run(medium) {
      const { writer, reader } = await open(medium);
      const editor = author(writer);
      editor.snapshot();
      for (let i = 1; i <= 5; i++) editor.commit([[i, i]]);
      const render = replica();
      await pump(reader, render.apply, () => reader.version === 3, { upTo: 3 });
      assertEqual(reader.peek()?.version, 4, 'the next delta waits for a newer frame');
      const report = reader.apply(render.apply, { upTo: 3 });
      assertEqual({ applied: report.applied, outcome: report.outcome }, { applied: 0, outcome: 'limit' }, 'limit reached');
      await pump(reader, render.apply, () => reader.version === 5, { upTo: 5 });
      assertTrue(sameDoc(render.doc, editor.doc), 'converges');
      writer.close();
    },
  },
  {
    name: 'gap → resyncing → resnapshot at a new epoch (E-1)',
    async run(medium) {
      const { writer, reader } = await open(medium);
      const editor = author(writer);
      const reasons: string[] = [];
      writer.onResnapshot((reason) => {
        reasons.push(reason);
        editor.snapshot();
      });
      editor.snapshot();
      editor.commit([[1, 1]]);
      editor.commitAfterLoss([[2, 2]]); // v3 on base v2: the reader is at v1, v2 was "lost"
      editor.commit([[3, 3]]);
      const render = replica();
      let resyncSeen = false;
      reader.machine.onTransition((t) => {
        if (t.to === 'resyncing') resyncSeen = true;
      });
      await pump(reader, render.apply, () => reader.state === 'live' && reader.epoch === 2 && reader.version === writer.version);
      assertTrue(resyncSeen, 'the reader went through resyncing');
      assertEqual(reader.stats.gaps, 1, 'one gap');
      assertEqual(reasons, ['reader'], 'the writer was asked by the reader');
      assertTrue(sameDoc(render.doc, editor.doc), 'state equals the oracle after the resnapshot');
      writer.close();
    },
  },
  {
    name: 'refuses non-increasing versions and oversized records',
    async run(medium) {
      const { writer } = await open(medium, TinyScene);
      okValue(writer.snapshot({ version: 5 }), 'snapshot');
      assertEqual(errOf(writer.append({ version: 5 }), 'same version').code, DeltaOrderError.code, 'SF-WK-034');
      assertEqual(errOf(writer.append({ version: 4 }), 'older').code, DeltaOrderError.code, 'SF-WK-034');
      const big = new Uint8Array(200);
      assertEqual(errOf(writer.append({ version: 6, payload: big }), 'big').code, RecordTooLargeError.code, 'SF-WK-035');
      writer.close();
    },
  },
  {
    name: 'queues under back-pressure without losing or reordering records',
    async run(medium) {
      const { writer, reader } = await open(medium, TinyScene, { maxPendingBytes: 8192 });
      const editor = author(writer);
      editor.snapshot();
      for (let i = 1; i <= 60; i++) editor.commit([[i % 7, i]]);
      assertTrue(writer.stats.pendingBytes > 0, 'records are queued');
      const render = replica();
      await pump(reader, render.apply, () => reader.version === 60);
      assertTrue(sameDoc(render.doc, editor.doc), 'every record applied in order');
      assertEqual(reader.stats.gaps, 0, 'no gaps');
      writer.close();
    },
  },
  {
    name: 'overflow drops the queue, asks for a snapshot and heals (SF-WK-036)',
    async run(medium) {
      const writer = okValue(createDeltaStream(TinyScene, { ...mediumOptions(medium), maxPendingBytes: 128 }), 'create');
      const reader = okValue(await attachDeltaStream(TinyScene, okValue(writer.endpoint(), 'endpoint')), 'attach');
      const doc: Doc = new Map();
      const reasons: string[] = [];
      writer.onResnapshot((reason) => reasons.push(reason));
      okValue(writer.snapshot({ version: 0 }), 'snapshot');
      let overflowed = false;
      for (let v = 1; v <= 40; v++) {
        doc.set(1, v);
        const appended = writer.append({ version: v, payload: encode([[1, v]]) });
        if (!appended.ok) {
          assertEqual(appended.error.code, PipeOverflowError.code, 'overflow code');
          overflowed = true;
        }
      }
      assertTrue(overflowed, 'the queue overflowed');
      assertEqual(reasons[0], 'overflow', 'the app is asked for a snapshot');
      assertTrue(writer.resnapshotRequested, 'a snapshot is owed');
      okValue(writer.snapshot({ version: 40, payload: snapshotOf(doc) }), 'healing snapshot');
      const render = replica();
      await pump(reader, render.apply, () => reader.version === 40 && reader.state === 'live');
      assertTrue(sameDoc(render.doc, doc), 'healed to the oracle');
      writer.close();
    },
  },
  {
    name: 'blocks on missing blobs, resumes when they arrive, resyncs when one is gone',
    async run(medium) {
      const { writer, reader } = await open(medium);
      const have = new Set<string>();
      const gone = new Set<string>();
      const requested: string[] = [];
      const blobs: BlobResolver = {
        has: (d) => have.has(d),
        gone: (d) => gone.has(d),
        request: (ds) => void requested.push(...ds),
      };
      writer.onResnapshot(() => writer.snapshot({ version: writer.version }));
      okValue(writer.snapshot({ version: 0 }), 'snapshot');
      okValue(writer.append({ version: 1, refs: ['blob-a'] }), 'append with ref');
      okValue(writer.append({ version: 2 }), 'append');
      await within(reader.wait({ timeoutMs: TIMEOUT }), TIMEOUT, 'wait');
      const kinds: string[] = [];
      let report = reader.apply((r) => kinds.push(r.kind), { blobs });
      for (let i = 0; i < 20 && report.outcome !== 'blocked'; i++) {
        await within(reader.wait({ timeoutMs: 10 }), TIMEOUT, 'wait');
        report = reader.apply((r) => kinds.push(r.kind), { blobs });
      }
      assertEqual({ outcome: report.outcome, blockedOn: report.blockedOn, version: reader.version }, { outcome: 'blocked', blockedOn: ['blob-a'], version: 0 }, 'blocked on blob-a');
      assertEqual(requested, ['blob-a'], 'the missing blob was requested');
      have.add('blob-a');
      await pump(reader, () => undefined, () => reader.version === 2, { blobs });
      okValue(writer.append({ version: 3, refs: ['blob-b'] }), 'append with a gone ref');
      gone.add('blob-b');
      await pump(reader, () => undefined, () => reader.epoch === 2 && reader.state === 'live', { blobs });
      assertTrue(reader.stats.gaps >= 1, 'a gone blob forces a resnapshot');
      writer.close();
    },
  },
  {
    name: 'a reader joining a running stream asks for a snapshot (respawn)',
    async run(medium) {
      const { writer, reader } = await open(medium);
      const editor = author(writer);
      writer.onResnapshot(() => editor.snapshot());
      editor.snapshot();
      for (let i = 1; i <= 4; i++) editor.commit([[i, i * i]]);
      const first = replica();
      await pump(reader, first.apply, () => reader.version === 4);
      reader.close(); // the render worker crashed
      editor.commit([[9, 9]]);
      const respawned = okValue(await attachDeltaStream(Scene, okValue(writer.endpoint(), 'endpoint')), 'respawned reader');
      const second = replica();
      await pump(respawned, second.apply, () => respawned.state === 'live' && respawned.version === writer.version);
      assertTrue(sameDoc(second.doc, editor.doc), 'the respawned reader recovered the full state');
      writer.close();
    },
  },
  {
    name: 'wraps around the ring many times',
    async run(medium) {
      const { writer, reader } = await open(medium, TinyScene);
      const editor = author(writer);
      editor.snapshot();
      const render = replica();
      for (let i = 1; i <= 200; i++) {
        editor.commit([[i % 5, i]]);
        if (i % 3 === 0) await pump(reader, render.apply, () => reader.version === i);
      }
      await pump(reader, render.apply, () => reader.version === 200);
      assertTrue(sameDoc(render.doc, editor.doc), 'converges after wrapping');
      writer.close();
    },
  },
  {
    name: 'refuses endpoints of another stream (SF-WK-032)',
    async run(medium) {
      const writer = okValue(createDeltaStream(Scene, mediumOptions(medium)), 'create');
      const other = await attachDeltaStream(OtherScene, okValue(writer.endpoint(), 'endpoint'));
      assertEqual(errOf(other, 'other').code, PipeMismatchError.code, 'another stream');
      const sized = await attachDeltaStream(TinyScene, okValue(writer.endpoint(), 'endpoint 2'));
      assertEqual(errOf(sized, 'size').code, PipeMismatchError.code, 'another capacity');
      writer.close();
    },
  },
];

export function runDeltaStreamContract(
  medium: PipeContractMedium,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`delta stream contract: ${medium.name}`, () => {
    for (const testCase of deltaStreamContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(medium));
    }
  });
}
