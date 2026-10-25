/**
 * Store worker of one tab in the leader-kill scenario. Every tab runs one;
 * `createStoreLeader` picks the leader with a Web Lock, followers relay over
 * BroadcastChannel. The leader journals with sync access handles (append
 * mode), compacts every `compactMs`, and acks only after the journal flushed.
 * Every worker also reads the head without a lock every 20 ms and reports a
 * torn or regressed head.
 */
import { ok, type Result } from '@staticflux/core';
import { globalBroadcastFactory } from '@staticflux/storage';
import { createHeadStore, createStoreLeader, type LeaderSession } from '../index.js';
import { type DocNode, opfsDir, openDocNode } from './fixtures.js';

interface Commit {
  readonly id: string;
  readonly part: string;
}

interface Init {
  readonly type: 'init';
  readonly ws: string;
  readonly peer: string;
  readonly verify: boolean;
  readonly compactMs: number;
}

const post = (message: Record<string, unknown>): void => self.postMessage(message);
let leader: ReturnType<typeof createStoreLeader<Commit>> | undefined;

async function lead(init: Init, signal: AbortSignal): Promise<Result<LeaderSession<Commit>>> {
  const root = await opfsDir(['sf-browser-tests', init.ws]);
  const started = performance.now();
  let node: DocNode;
  try {
    node = await openDocNode(root, { peer: init.peer, lockPrefix: init.ws, journalMode: 'append' });
  } catch (error) {
    return { ok: false, error: error as never };
  }
  if (!node.recovery.ok) return node.recovery;
  const report = node.recovery.value.report;
  post({ type: 'leader', recoveryMs: performance.now() - started, generation: node.recovery.value.head?.generation ?? 0, ...report });
  const tick = async (): Promise<void> => {
    if (signal.aborted) return;
    const compacted = await node.latest.compact();
    if (!compacted.ok) post({ type: 'error', where: 'compact', code: compacted.error.code, message: compacted.error.message });
    else if (!compacted.value.skipped) post({ type: 'compacted', generation: compacted.value.generation, logFrom: compacted.value.logFrom });
    else post({ type: 'compact-skipped', reason: compacted.value.reason });
    setTimeout(() => void tick(), init.compactMs);
  };
  setTimeout(() => void tick(), init.compactMs);
  return ok({
    async apply(batch) {
      try {
        await node.commit(batch);
        return ok(batch.map((c) => c.id));
      } catch (error) {
        return { ok: false, error: error as never };
      }
    },
    close: () => node.latest.close(),
  });
}

async function verify(init: Init): Promise<void> {
  const root = await opfsDir(['sf-browser-tests', init.ws]);
  const node = await openDocNode(root, { peer: init.peer, lockPrefix: init.ws, journalMode: 'append' });
  if (!node.recovery.ok) {
    post({ type: 'verify', error: node.recovery.error.code, ids: [] });
    return;
  }
  post({ type: 'verify', ids: [...node.ids()], generation: node.recovery.value.head?.generation ?? 0, report: node.recovery.value.report });
  await node.latest.close();
}

async function probe(init: Init): Promise<void> {
  const root = await opfsDir(['sf-browser-tests', init.ws]);
  const heads = createHeadStore(root, { locks: navigator.locks as never, lockPrefix: init.ws });
  let reads = 0;
  let torn = 0;
  let regress = 0;
  let last = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 20));
    const head = await heads.read('as_doc');
    reads += 1;
    if (!head.ok) {
      if (head.error.code === 'SF-BLOB-010') torn += 1;
    } else if (head.value !== undefined) {
      if (head.value.generation < last) regress += 1;
      last = Math.max(last, head.value.generation);
    }
    if (reads % 25 === 0) post({ type: 'probe', reads, torn, regress });
  }
}

self.onmessage = (event: MessageEvent<Init | { type: 'commit'; c: Commit } | { type: 'pending' }>) => {
  const message = event.data;
  if (message.type === 'init') {
    if (message.verify) {
      void verify(message);
      return;
    }
    const channels = globalBroadcastFactory();
    if (channels === undefined) throw new Error('BroadcastChannel missing');
    const created = createStoreLeader<Commit>({
      name: message.ws,
      peer: message.peer,
      locks: navigator.locks as never,
      channels,
      idOf: (c) => c.id,
      lead: (signal) => lead(message, signal),
      onError: (error, where) => post({ type: 'error', where, code: (error as { code?: string }).code ?? String(error) }),
    });
    if (!created.ok) throw created.error;
    leader = created;
    void probe(message);
    post({ type: 'ready' });
  } else if (message.type === 'commit') {
    const current = leader;
    if (current === undefined || !current.ok) return;
    void current.value.commit(message.c).then((result) => {
      if (result.ok) post({ type: 'ack', id: message.c.id });
    });
  } else if (message.type === 'pending') {
    post({ type: 'pending', n: leader?.ok === true ? leader.value.pending : -1 });
  }
};
