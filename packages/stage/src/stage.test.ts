import type { PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { createSessionLayer, type StageLayer } from './layers.js';
import { createStaticAssets } from './source.js';
import { createStage, PROXY_SEPARATOR } from './stage.js';
import { agent, alice, docOf, unwrap } from './test-helpers.js';

const seedMeta = { actor: { kind: 'human', id: 'seed' }, label: 'Edit' };

/** Brand kit asset: classes `heading` (final fill) and `body`. */
const kitOps: PartOp[] = [
  { op: 'create', node: 'kit', kind: 'composition', parent: null },
  { op: 'create', node: 'heading', kind: 'group', parent: 'kit', props: { 'text.size': 48, 'style.fill': 'navy', 'policy.final': ['style.fill'] } },
  { op: 'create', node: 'body', kind: 'group', parent: 'kit', props: { 'text.size': 16, 'text.weight': 400 } },
  { op: 'create', node: 'tokens', kind: 'group', parent: 'kit', props: { 'color.primary': '#ff0066' } },
];

/** Component asset: a card with a title and a nested instance of a badge component. */
const cardOps: PartOp[] = [
  { op: 'create', node: 'croot', kind: 'composition', parent: null },
  { op: 'create', node: 'frame', kind: 'group', parent: 'croot', props: { 'spatial.w': 200, 'style.fill': 'white' } },
  { op: 'create', node: 'title', kind: 'text', parent: 'frame', props: { 'text.size': 20 } },
  { op: 'create', node: 'nested', kind: 'instance', parent: 'croot', props: { 'instance.ref': { asset: 'as_badge', at: 'latest' } } },
];
const badgeOps: PartOp[] = [
  { op: 'create', node: 'broot', kind: 'composition', parent: null },
  { op: 'create', node: 'dot', kind: 'shape', parent: 'broot', props: { 'style.fill': 'red' } },
];

const designOps: PartOp[] = [
  { op: 'create', node: 'comp', kind: 'composition', parent: null },
  { op: 'create', node: 'page', kind: 'page', parent: 'comp' },
  {
    op: 'create',
    node: 'h1',
    kind: 'text',
    parent: 'page',
    props: {
      'spatial.x': 10,
      'text.size': 60,
      'style.inherit': { kit: { asset: 'as_kit', at: 'latest' }, class: 'heading' },
      'style.fill': 'pink',
      'variants.opinions.format=story': { 'spatial.x': 99, 'text.size': 30 },
      'variants.opinions.theme=dark': { 'style.stroke': 'white', 'text.size': 25 },
    },
  },
  { op: 'create', node: 'p', kind: 'text', parent: 'page', props: { 'style.inherit': { class: 'localClass' } } },
  { op: 'create', node: 'localClass', kind: 'group', parent: 'comp', props: { 'text.size': 12, name: 'Local' } },
  {
    op: 'create',
    node: 'inst',
    kind: 'instance',
    parent: 'page',
    props: { 'spatial.x': 300, 'instance.ref': { asset: 'as_card', at: 'ms_v1' }, 'instance.overrides.title': { 'text.size': 22 } },
  },
  { op: 'create', node: 'tok', kind: 'shape', parent: 'page', props: { 'style.fill': { token: 'color.primary' } } },
];

function setup() {
  const design = docOf('as_design', designOps);
  const kit = docOf('as_kit', kitOps);
  const card = docOf('as_card@ms_v1', cardOps);
  const badge = docOf('as_badge', badgeOps);
  const assets = createStaticAssets({ as_kit: kit.doc, 'as_card@ms_v1': card.doc, as_badge: badge.doc });
  const session = createSessionLayer();
  const stage = createStage({
    root: design.doc,
    session,
    assets,
    rules: { token: { match: (v) => (typeof v === 'object' && v !== null && 'token' in v ? { ref: { asset: 'as_kit', at: 'latest' }, node: 'tokens', path: String(v['token']) } : undefined) } },
  });
  return { design, kit, card, badge, assets, session, stage };
}

describe('stage: layers and arcs', () => {
  it('composes local > variant > inherit > reference with provenance', () => {
    const { stage } = setup();
    const h1 = stage.read('h1');
    expect(h1?.kind).toBe('text');
    expect(h1?.parent).toBe('page');
    expect(h1?.values['text.size']).toBe(60); // local beats inherit
    expect(h1?.provenance['text.size']).toMatchObject({ layer: 'local', arc: 'local', asset: 'as_design', node: 'h1' });
    expect(stage.read('p')?.values['text.size']).toBe(12); // inherit from a class in the same asset
    expect(stage.read('p')?.provenance['text.size']).toMatchObject({ arc: 'inherit', asset: 'as_design', node: 'localClass' });
    expect(stage.read('p')?.values['name']).toBeUndefined(); // identity is never inherited
    expect(stage.value('h1', 'text.weight')).toBeUndefined();
  });

  it('applies the session’s variant selection (earlier selections are stronger)', () => {
    const { stage, session } = setup();
    expect(stage.value('h1', 'spatial.x')).toBe(10);
    session.select('format', 'story');
    expect(stage.value('h1', 'spatial.x')).toBe(10); // local still beats variant
    expect(stage.value('h1', 'text.size')).toBe(60);
    expect(stage.read('h1')?.values['spatial.x']).toBe(10);
    session.select('theme', 'dark');
    expect(stage.value('h1', 'style.stroke')).toBe('white');
    expect(stage.explain('h1', 'style.stroke').winner).toMatchObject({ arc: 'variant', variant: 'theme=dark', storedAt: 'variants.opinions.theme=dark' });
    expect(session.selection()).toEqual([
      ['format', 'story'],
      ['theme', 'dark'],
    ]);
    session.select('format', undefined);
    expect(session.selection()).toEqual([['theme', 'dark']]);
  });

  it('variant beats inherit when there is no local opinion', () => {
    const { stage, session, design } = setup();
    unwrap(design.part.transact(seedMeta, [{ op: 'set', node: 'h1', path: 'text.size', value: null }]));
    expect(stage.value('h1', 'text.size')).toBe(48); // from the kit class
    session.select('theme', 'dark');
    session.select('format', 'story');
    expect(stage.value('h1', 'text.size')).toBe(25); // theme selected first → stronger
    const why = stage.explain('h1', 'text.size');
    expect(why.overridden.map((o) => [o.arc, o.variant ?? o.node])).toEqual([
      ['variant', 'format=story'],
      ['inherit', 'heading'],
    ]);
  });

  it('final paths win regardless of strength and the beaten opinions are flagged', () => {
    const { stage } = setup();
    const h1 = stage.read('h1');
    expect(h1?.values['style.fill']).toBe('navy');
    const why = stage.explain('h1', 'style.fill');
    expect(why.winner).toMatchObject({ arc: 'inherit', asset: 'as_kit', node: 'heading', final: true });
    expect(why.ignored).toHaveLength(1);
    expect(why.ignored[0]).toMatchObject({ arc: 'local', value: 'pink', reason: 'final' });
    expect(h1?.flags).toContainEqual(expect.objectContaining({ kind: 'ignored', path: 'style.fill' }));
  });

  it('session opinions beat local ones, and proposal layers sit between them (M2 seam)', () => {
    const { stage, session } = setup();
    session.set('h1', 'spatial.x', 50);
    expect(stage.value('h1', 'spatial.x')).toBe(50);
    expect(stage.explain('h1', 'spatial.x').winner?.layer).toBe('session');
    const listeners = new Set<(n: readonly string[]) => void>();
    const proposal: StageLayer = {
      id: 'proposal/cs_1',
      opinions: (n) => (n === 'h1' ? { 'spatial.x': 70, 'spatial.y': 5 } : undefined),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const remove = stage.addLayer(proposal);
    expect(stage.layers()).toEqual(['session', 'proposal/cs_1', 'local']);
    expect(stage.value('h1', 'spatial.x')).toBe(50);
    expect(stage.value('h1', 'spatial.y')).toBe(5);
    expect(stage.explain('h1', 'spatial.x').overridden.map((o) => o.layer)).toEqual(['proposal/cs_1', 'local']);
    for (const l of listeners) l(['h1']);
    remove();
    remove();
    expect(stage.value('h1', 'spatial.y')).toBeUndefined();
    session.clear('h1', 'spatial.x');
    expect(stage.value('h1', 'spatial.x')).toBe(10);
  });

  it('a policy lock keeps the local value against session and proposal opinions (flagged)', () => {
    const { stage, session, design } = setup();
    unwrap(design.part.transact(seedMeta, [{ op: 'set', node: 'h1', path: 'lock.policy', value: { by: { asset: 'as_kit' }, reason: 'Brand' } }, { op: 'set', node: 'h1', path: 'lock.scope', value: 'position' }]));
    session.set('h1', 'spatial.x', 50);
    session.set('h1', 'text.size', 70);
    expect(stage.value('h1', 'spatial.x')).toBe(10);
    expect(stage.explain('h1', 'spatial.x').ignored[0]).toMatchObject({ layer: 'session', reason: 'policy-lock' });
    expect(stage.value('h1', 'text.size')).toBe(70); // not covered by a position lock
  });

  it('resolves token values through the token rule, with provenance', () => {
    const { stage, kit } = setup();
    expect(stage.value('tok', 'style.fill')).toBe('#ff0066');
    expect(stage.explain('tok', 'style.fill').winner?.token).toEqual({ asset: 'as_kit', node: 'tokens', path: 'color.primary' });
    unwrap(kit.part.transact(seedMeta, [{ op: 'set', node: 'tokens', path: 'color.primary', value: '#00ff00' }]));
    expect(stage.value('tok', 'style.fill')).toBe('#00ff00'); // following reference: Latest changes flow in
  });
});

describe('stage: references and instances', () => {
  it('shows a pinned instance as proxies with overrides as local opinions', () => {
    const { stage } = setup();
    const kids = stage.children('inst');
    expect(kids).toEqual([`inst${PROXY_SEPARATOR}frame`, `inst${PROXY_SEPARATOR}nested`]);
    expect(stage.children('inst/frame')).toEqual(['inst/title']);
    const title = stage.read('inst/title');
    expect(title?.source).toEqual({ asset: 'as_card@ms_v1', node: 'title' });
    expect(title?.parent).toBe('inst/frame');
    expect(stage.read('inst/frame')?.parent).toBe('inst');
    expect(title?.values['text.size']).toBe(22);
    expect(title?.provenance['text.size']).toMatchObject({ arc: 'local', node: 'inst', storedAt: 'instance.overrides.title' });
    expect(stage.explain('inst/title', 'text.size').overridden[0]).toMatchObject({ arc: 'reference', asset: 'as_card@ms_v1', node: 'title', value: 20 });
    expect(stage.value('inst/frame', 'style.fill')).toBe('white');
  });

  it('nests instances (a proxy that is itself an instance) and follows Latest', () => {
    const { stage, badge, assets } = setup();
    expect(stage.children('inst/nested')).toEqual(['inst/nested/dot']);
    expect(stage.value('inst/nested/dot', 'style.fill')).toBe('red');
    expect(stage.read('inst/nested/dot')?.parent).toBe('inst/nested');
    unwrap(badge.part.transact(seedMeta, [{ op: 'set', node: 'dot', path: 'style.fill', value: 'green' }]));
    expect(stage.value('inst/nested/dot', 'style.fill')).toBe('green');
    assets.set('as_badge', undefined);
    expect(stage.read('inst/nested/dot')).toBeUndefined();
    expect(stage.children('inst/nested')).toEqual([]);
  });

  it('builds override ops for proxies and refuses non-proxies', () => {
    const { stage, design } = setup();
    const op = unwrap(stage.overrideOp('inst/title', 'style.fill', 'blue'));
    expect(op).toEqual({ op: 'set', node: 'inst', path: 'instance.overrides.title', value: { 'text.size': 22, 'style.fill': 'blue' } });
    unwrap(design.part.transact(seedMeta, [op]));
    expect(stage.value('inst/title', 'style.fill')).toBe('blue');
    const cleared = unwrap(stage.overrideOp('inst/frame', 'x', null));
    expect(cleared.value).toBeNull();
    expect(stage.overrideOp('h1', 'x', 1).ok).toBe(false);
    expect(stage.overrideOp('inst/nested/dot', 'x', 1).ok).toBe(false);
  });

  it('flags missing targets and cycles instead of failing', () => {
    const { stage, design } = setup();
    unwrap(
      design.part.transact(seedMeta, [
        { op: 'create', node: 'loopA', kind: 'group', parent: 'comp', props: { 'style.inherit': { class: 'loopB' }, a: 1 } },
        { op: 'create', node: 'loopB', kind: 'group', parent: 'comp', props: { 'style.inherit': { class: 'loopA' }, b: 2 } },
        { op: 'create', node: 'lost', kind: 'text', parent: 'page', props: { 'style.inherit': { kit: { asset: 'as_none' }, class: 'x' } } },
        { op: 'create', node: 'gone', kind: 'text', parent: 'page', props: { 'style.inherit': { class: 'nothing' } } },
        { op: 'create', node: 'badInst', kind: 'instance', parent: 'page', props: { 'instance.ref': { asset: 'as_none', at: 'latest' } } },
      ]),
    );
    expect(stage.read('loopA')?.values).toMatchObject({ a: 1, b: 2 });
    expect(stage.read('loopA')?.flags).toContainEqual({ kind: 'cycle', arc: 'inherit', target: 'as_design#loopB' });
    expect(stage.read('lost')?.flags).toContainEqual({ kind: 'missing', arc: 'inherit', target: 'as_none#x' });
    expect(stage.read('gone')?.flags).toContainEqual({ kind: 'missing', arc: 'inherit', target: 'as_design#nothing' });
    expect(stage.children('badInst')).toEqual([]);
    expect(stage.read('badInst/x')).toBeUndefined();
    expect(stage.read('h1/x')).toBeUndefined();
    expect(stage.read('nope')).toBeUndefined();
    expect(stage.explain('nope', 'x')).toEqual({ node: 'nope', path: 'x', value: undefined, winner: undefined, overridden: [], ignored: [] });
  });
});

describe('stage: incremental composition', () => {
  it('recomposes only the dependents of a change', () => {
    const { stage, design, kit } = setup();
    for (const id of ['h1', 'p', 'tok', 'inst/title', 'page']) stage.read(id);
    const invalidated: string[][] = [];
    stage.onInvalidate((nodes) => invalidated.push([...nodes].sort()));
    const before = stage.stats().recomposed;
    for (const id of ['h1', 'p', 'tok', 'inst/title', 'page']) stage.read(id);
    expect(stage.stats().recomposed).toBe(before); // all cached

    unwrap(design.part.transact(seedMeta, [{ op: 'set', node: 'localClass', path: 'text.size', value: 13 }]));
    expect(invalidated.at(-1)).toEqual(['p']); // only the node inheriting from the class
    expect(stage.value('p', 'text.size')).toBe(13);
    expect(stage.value('h1', 'text.size')).toBe(60);
    expect(stage.stats().recomposed).toBe(before + 2); // p and the class; h1 and the rest stay cached

    unwrap(kit.part.transact(seedMeta, [{ op: 'set', node: 'heading', path: 'text.weight', value: 800 }]));
    expect(invalidated.at(-1)).toEqual(['h1']);

    unwrap(design.part.transact(seedMeta, [{ op: 'set', node: 'inst', path: 'instance.overrides.title', value: { 'text.size': 1 } }]));
    expect(invalidated.at(-1)).toEqual(['inst', 'inst/title']);
    expect(stage.value('inst/title', 'text.size')).toBe(1);
    expect(stage.stats().cached).toBeGreaterThan(0);
    expect(stage.stats().dependencies).toBeGreaterThan(0);
  });

  it('names root-document nodes created since (nothing read them yet), once', () => {
    const { stage, design } = setup();
    stage.read('page');
    const seen: string[][] = [];
    stage.onInvalidate((nodes) => seen.push([...nodes]));
    unwrap(design.part.transact(seedMeta, [{ op: 'create', node: 'fresh', kind: 'shape', parent: 'page', props: {} }, { op: 'set', node: 'fresh', path: 'spatial.x', value: 1 }]));
    expect(seen.at(-1)).toEqual(['fresh']);
    expect(stage.children('page')).toContain('fresh');
  });

  it('a session change or a variant selection invalidates only what reads it', () => {
    const { stage, session } = setup();
    stage.read('h1');
    stage.read('p');
    const seen: string[][] = [];
    stage.onInvalidate((nodes) => seen.push([...nodes]));
    session.set('p', 'spatial.x', 1);
    expect(seen.at(-1)).toEqual(['p']);
    stage.read('p');
    session.select('format', 'story');
    expect(seen.at(-1)).toEqual(['h1']); // p has no variant opinions
    session.clear();
    expect(seen.at(-1)).toEqual(['p']);
    session.clear('zzz');
  });

  it('follows part attach and detach', () => {
    const { stage, design } = setup();
    const extra = docOf('tmp', [{ op: 'create', node: 'p2', kind: 'page', parent: null, props: { 'spatial.x': 1 } }]);
    expect(stage.read('p2')).toBeUndefined();
    const detach = design.doc.attach(extra.part, { id: 'page:p2' });
    expect(stage.value('p2', 'spatial.x')).toBe(1);
    detach();
    expect(stage.read('p2')).toBeUndefined();
  });
});

describe('stage: locks', () => {
  function locked() {
    const s = setup();
    unwrap(
      s.design.part.transact(seedMeta, [
        { op: 'set', node: 'page', path: 'lock.scope', value: 'content' },
        { op: 'set', node: 'h1', path: 'lock.scope', value: 'position' },
        { op: 'set', node: 'tok', path: 'lock.policy', value: { by: { asset: 'as_kit' }, reason: 'Brand' } },
      ]),
    );
    return s;
  }

  it('reports effective locks from the node and its ancestors', () => {
    const { stage } = locked();
    expect(stage.lockOf('h1')).toEqual({ position: true, content: true, policy: false, from: ['h1', 'page'] });
    expect(stage.lockOf('tok')).toEqual({ position: true, content: true, policy: true, from: ['tok', 'page'] });
    expect(stage.lockOf('comp')).toEqual({ position: false, content: false, policy: false, from: [] });
    expect(stage.lockOf('nope').from).toEqual([]);
  });

  it('rejects locked writes and allows unlocking a UX lock', () => {
    const { stage } = locked();
    const code = (ops: PartOp[], actor = alice, confirmPolicyUnlock?: boolean) => {
      const r = stage.checkWrite(ops, { actor, ...(confirmPolicyUnlock === undefined ? {} : { confirmPolicyUnlock }) });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code([{ op: 'set', node: 'h1', path: 'spatial.x', value: 1 }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'set', node: 'p', path: 'text.size', value: 1 }])).toBe('SF-STAGE-001'); // page content lock
    expect(code([{ op: 'set', node: 'comp', path: 'text.size', value: 1 }])).toBe('ok');
    expect(code([{ op: 'create', node: 'n', kind: 'shape', parent: 'page' }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'create', node: 'n', kind: 'shape', parent: 'comp' }])).toBe('ok');
    expect(code([{ op: 'create', node: 'n', kind: 'shape', parent: null }])).toBe('ok');
    expect(code([{ op: 'delete', node: 'h1' }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'delete', node: 'localClass' }])).toBe('ok');
    expect(code([{ op: 'move', node: 'h1', parent: 'comp' }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'move', node: 'localClass', parent: 'page' }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'move', node: 'localClass', parent: null }])).toBe('ok');
    expect(code([{ op: 'text.insert', node: 'p', path: 'text.content', at: 0, text: 'x' }])).toBe('SF-STAGE-001');
    expect(code([{ op: 'set', node: 'h1', path: 'lock.scope', value: null }])).toBe('ok'); // UX lock: anyone
    expect(code([{ op: 'set', node: 'h1', path: 'style.fill', value: 'x' }])).toBe('SF-STAGE-001'); // under the content-locked page
  });

  it('a policy lock: never for agents, humans only with confirmation', () => {
    const { stage } = locked();
    const unlock: PartOp[] = [{ op: 'set', node: 'tok', path: 'lock.policy', value: null }];
    const agentTry = stage.checkWrite(unlock, { actor: agent, confirmPolicyUnlock: true });
    expect(agentTry.ok ? '' : agentTry.error.code).toBe('SF-STAGE-002');
    const unconfirmed = stage.checkWrite(unlock, { actor: alice });
    expect(unconfirmed.ok ? '' : unconfirmed.error.details?.['needs']).toBe('confirmation');
    expect(stage.checkWrite(unlock, { actor: alice, confirmPolicyUnlock: true }).ok).toBe(true);
  });

  it('rejects writes to final paths (IF-CS-013)', () => {
    const { stage } = setup();
    const r = stage.checkWrite([{ op: 'set', node: 'h1', path: 'style.fill', value: 'red' }], { actor: alice });
    expect(r.ok ? '' : r.error.code).toBe('SF-STAGE-003');
    expect(stage.checkWrite([{ op: 'set', node: 'h1', path: 'text.size', value: 1 }], { actor: alice }).ok).toBe(true);
  });

  it('is unusable after dispose', () => {
    const { stage } = setup();
    stage.read('h1');
    stage.dispose();
    stage.dispose();
    expect(stage.disposed).toBe(true);
    expect(stage.read('h1')).toBeUndefined();
    expect(stage.children(null)).toEqual([]);
    expect(stage.lockOf('h1').from).toEqual([]);
    expect(stage.explain('h1', 'x').winner).toBeUndefined();
    const r = stage.checkWrite([], { actor: alice });
    expect(r.ok ? '' : r.error.code).toBe('SF-STAGE-005');
  });

  it('lists top-level nodes', () => {
    const { stage } = setup();
    expect(stage.children(null)).toEqual(['comp']);
    expect(stage.children('page')).toEqual(['h1', 'p', 'inst', 'tok']);
  });
});
