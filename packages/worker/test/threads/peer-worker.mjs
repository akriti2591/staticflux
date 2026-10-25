// Thread fixture: one end of a brokered peer channel in a real worker thread.
// role 'editor': pings the render peer on every (re)connection and reports pongs.
// role 'render': answers pings with its instance id.
import './register.mjs';
import { parentPort, workerData } from 'node:worker_threads';

const { createLink, fromMessagePort } = await import('@staticflux/worker');
const { acceptPeer, definePeer } = await import('@staticflux/worker/pipeline');
const { ok } = await import('@staticflux/core');

const EditorRender = definePeer('threads/editor-render');
const link = createLink({ port: fromMessagePort(parentPort), name: `${workerData.role}-${workerData.instance}` });
const peer = acceptPeer(link, EditorRender);

if (workerData.role === 'editor') {
  const pongs = [];
  peer.on('threads/pong', (payload) => pongs.push(payload));
  peer.onConnect((peerLink, generation) => {
    peerLink.send('threads/ping', { generation });
  });
  link.handle('threads/status', () => ok({ generation: peer.generation, state: peer.state, pongs }));
} else {
  peer.on('threads/ping', (payload) => {
    peer.send('threads/pong', { from: workerData.instance, generation: payload.generation });
  });
}
