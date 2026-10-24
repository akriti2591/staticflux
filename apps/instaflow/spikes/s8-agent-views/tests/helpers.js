import { Replica, replicaState } from '../src/store.js';
import { AgentSession } from '../src/session.js';
import { SEEDS } from '../src/seeds.js';

let PEER = 1000;
export function fresh(seedName, { mode = 'accept-edits' } = {}) {
  const seed = typeof seedName === 'string' ? SEEDS[seedName]() : seedName;
  const human = Replica.fromSeed(seed, PEER++, 'human:guest');
  const agent = new AgentSession(human, { peer: PEER++, name: 'test', mode });
  return { human, agent, seed };
}
/** strip derived read-only facts and parser-only fields so models compare structurally */
export function norm(nodes) {
  const n1 = (n) => {
    const o = { id: n.id, kind: n.kind, attrs: n.attrs };
    if (n.text !== undefined) o.text = n.text;
    if (n.children && n.children.length) o.children = n.children.map(n1);
    return o;
  };
  return nodes.map(n1);
}
export const scopes = {
  flyer: [['markup', 'page:fl-page'], ['json', 'page:fl-page']],
  deck: [['markup', 'doc'], ['json', 'doc'], ['markup', 'page:dk-s3']],
  reel: [['markup', 'page:rl-page'], ['json', 'page:rl-page'], ['timeline', 'page:rl-page'], ['graph', 'flow:fw-captions']],
  big: [['markup', 'page:bp-page'], ['json', 'page:bp-page']],
};
export { replicaState };
/** find a handle by node name in a view model index */
export function byName(view, name) {
  for (const [h, e] of view.model.index) if (e.node.attrs?.name === name) return h;
  throw new Error('no node named ' + name);
}
