/**
 * Respawn re-wire end to end (SF-Δ19 + SF-Δ18): two supervised workers (editor,
 * render) joined by a brokered peer channel. The render worker crashes; the
 * supervisor respawns it, the broker re-wires the peer channel, the editor
 * re-sends its delta-stream endpoint in `onConnect`, and the respawned reader
 * asks for a snapshot — the new render state equals the editor's, including
 * edits made while it was down.
 */
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createSupervisedWorker,
  defineProtocol,
  inMemorySpawner,
  type PortPair,
  request,
  runWorker,
} from './index.js';
import {
  acceptPeer,
  attachDeltaStream,
  createDeltaStream,
  createPeerBroker,
  defineDeltaStream,
  definePeer,
  type DeltaStreamReader,
  isRegionEndpoint,
  memoryWire,
  type PeerChannel,
  workerHost,
} from './pipeline.js';

const EditorRender = definePeer('test/editor-render');
const Scene = defineDeltaStream({ id: 'test/scene', capacityBytes: 4096 });
const PipesChannel = 'test/pipes' as const;

const Proto = defineProtocol({
  id: 'test/pipeline-worker',
  version: 1,
  requests: {
    commit: request<{ readonly id: number; readonly value: number }, number>(),
    state: request<null, readonly (readonly [number, number])[]>({ idempotent: true }),
  },
  events: {},
});
type P = typeof Proto;

const encode = (pairs: readonly (readonly [number, number])[]): Uint8Array => new Uint8Array(new Int32Array(pairs.flat()).buffer);
const decode = (bytes: Uint8Array): [number, number][] => {
  const words = new Int32Array(bytes.slice().buffer);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < words.length; i += 2) out.push([words[i] as number, words[i + 1] as number]);
  return out;
};
const sorted = (pairs: Iterable<readonly [number, number]>): [number, number][] => [...pairs].map(([k, v]) => [k, v] as [number, number]).sort((x, y) => x[0] - y[0]);

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label}: last value ${JSON.stringify(value)}`);
    await tick();
  }
}

describe('respawn re-wire (editor ↔ render over a brokered peer channel)', () => {
  it('re-wires the peer, re-sends the pipe endpoint and resnapshots the respawned reader', async () => {
    const editorPeers: PeerChannel[] = [];
    const renderPairs: PortPair[] = [];
    let renderInstances = 0;

    const editor = createSupervisedWorker<P>({
      id: 'test/editor',
      protocol: Proto,
      heartbeat: false,
      restart: { baseDelayMs: 0, jitter: 'none' },
      fallback: { description: 'none' },
      spawn: inMemorySpawner(
        (port) => {
          const doc = new Map<number, number>();
          let version = 0;
          const stream = createDeltaStream(Scene, { medium: 'shared' });
          if (!stream.ok) throw stream.error;
          const deltas = stream.value;
          deltas.onResnapshot(() => deltas.snapshot({ version, payload: encode([...doc]) }));
          deltas.snapshot({ version, payload: encode([]) });
          void runWorker<P>({
            port,
            protocol: Proto,
            forwardTelemetry: false,
            handlers: () => ({
              commit: ({ id, value }) => {
                version += 1;
                doc.set(id, value);
                deltas.append({ version, payload: encode([[id, value]]) });
                return ok(version);
              },
              state: () => ok(sorted(doc)),
            }),
            setup: (runtime) => {
              const peer = acceptPeer(runtime.link, EditorRender);
              editorPeers.push(peer);
              // Every (re)connection: hand the render module the stream endpoint.
              peer.onConnect((link) => {
                const endpoint = deltas.endpoint();
                if (endpoint.ok) link.send(PipesChannel, endpoint.value);
              });
              return ok();
            },
          });
        },
        { clone: false },
      ),
    });

    const render = createSupervisedWorker<P>({
      id: 'test/render',
      protocol: Proto,
      heartbeat: false,
      restart: { baseDelayMs: 0, jitter: 'none' },
      fallback: { description: 'none' },
      spawn: inMemorySpawner(
        (port, context) => {
          renderPairs.push(context.pair);
          renderInstances += 1;
          const mirror = new Map<number, number>();
          let reader: DeltaStreamReader | undefined;
          void runWorker<P>({
            port,
            protocol: Proto,
            forwardTelemetry: false,
            handlers: () => ({
              commit: () => ok(0),
              state: () => {
                reader?.apply((record) => {
                  if (record.kind === 'snapshot') mirror.clear();
                  for (const [id, value] of decode(record.payload)) mirror.set(id, value);
                });
                return ok(sorted(mirror));
              },
            }),
            setup: (runtime) => {
              const peer = acceptPeer(runtime.link, EditorRender);
              peer.on(PipesChannel, (endpoint) => {
                if (!isRegionEndpoint(endpoint)) return;
                void attachDeltaStream(Scene, endpoint).then((attached) => {
                  if (attached.ok) reader = attached.value;
                });
              });
              return ok();
            },
          });
        },
        { clone: false },
      ),
    });

    const broker = createPeerBroker({ wire: memoryWire() });
    const connection = broker.connect(EditorRender, workerHost(editor), workerHost(render));
    expect((await editor.start()).ok).toBe(true);
    expect((await render.start()).ok).toBe(true);

    for (let id = 1; id <= 5; id++) await editor.request('commit', { id, value: id * 10 });
    const editorState = async () => {
      const state = await editor.request('state', null);
      return state.ok ? state.value : [];
    };
    const renderState = async () => {
      const state = await render.request('state', null);
      return state.ok ? state.value : [];
    };
    const expected = await editorState();
    await eventually(renderState, (s) => JSON.stringify(s) === JSON.stringify(expected), 'render mirrors the editor');
    const firstGeneration = editorPeers[0]?.generation ?? 0;
    expect(connection.connected).toBe(true);

    renderPairs[0]?.crash(new Error('GPU process gone'));
    await editor.request('commit', { id: 2, value: 99 }); // an edit while render is down
    await editor.request('commit', { id: 6, value: 60 });
    await eventually(async () => render.state, (state) => state === 'ready', 'render respawned');
    expect(renderInstances).toBe(2);

    const after = await editorState();
    await eventually(renderState, (s) => JSON.stringify(s) === JSON.stringify(after), 'the respawned render converges');
    expect(after).toContainEqual([2, 99]);
    expect(editorPeers).toHaveLength(1); // the editor's PeerChannel object survived the re-wire
    expect(editorPeers[0]?.generation).toBeGreaterThan(firstGeneration);
    expect(connection.wirings).toBeGreaterThanOrEqual(2);

    broker.dispose();
    await render.stop();
    await editor.stop();
  });
});
