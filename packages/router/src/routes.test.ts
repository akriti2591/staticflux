import { featureRef } from '@staticflux/runtime';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  bindCapability,
  buildPath,
  classifyNavigation,
  compilePattern,
  createRouteTable,
  defineDialog,
  defineRoute,
  defineStage,
  diffChains,
  isMatchOf,
  type JoinPaths,
  matchPattern,
  type PathParams,
  planStages,
  type RouteMatch,
  type RouteParams,
  searchParam,
  serializeSearch,
  parseSearch,
  validateStages,
  requirementsOf,
} from './index.js';

declare module './routes.js' {
  interface RouteRequirements {
    auth?: 'required' | 'optional';
    resource?: string;
  }
}

const studio = featureRef('studio/desktop');
const studioMobile = featureRef('studio/mobile');

const root = defineRoute({ id: 'app/root', path: '/' });
const studioRoute = defineRoute({
  id: 'studio/root',
  path: 'studio',
  abstract: true,
  requires: { auth: 'required' },
  feature: bindCapability('studio/editor', [{ feature: studio }, { feature: studioMobile }]),
});
const docRoute = defineRoute({
  id: 'studio/doc',
  path: 'doc/:id',
  parent: studioRoute,
  search: { tab: searchParam.enum(['comments', 'history'], { kind: 'view' }), rev: searchParam.number() },
  requires: { resource: 'doc' },
});
const commentRoute = defineRoute({ id: 'studio/comment', path: 'comment/:commentId', parent: docRoute, view: true });
const newDoc = defineRoute({ id: 'studio/new', path: 'doc/new', parent: studioRoute });
const share = defineDialog({ id: 'studio/share', key: 'share', owner: docRoute });
const upsell = defineDialog({ id: 'billing/upsell', key: 'upsell' });

const table = (() => {
  const r = createRouteTable([root, studioRoute, docRoute, commentRoute, newDoc], [share, upsell]);
  if (!r.ok) throw r.error;
  return r.value;
})();

describe('path types', () => {
  it('joins paths and extracts params at the type level', () => {
    expectTypeOf<JoinPaths<'/studio', 'doc/:id'>>().toEqualTypeOf<'/studio/doc/:id'>();
    expectTypeOf<JoinPaths<'', '/'>>().toEqualTypeOf<'/'>();
    expectTypeOf<PathParams<'/a/:x/b/:y'>>().toEqualTypeOf<{ readonly x: string; readonly y: string }>();
    expectTypeOf(commentRoute.path).toEqualTypeOf<'/studio/doc/:id/comment/:commentId'>();
    expectTypeOf<RouteParams<typeof commentRoute>>().toEqualTypeOf<{ readonly id: string; readonly commentId: string }>();
    expect(commentRoute.path).toBe('/studio/doc/:id/comment/:commentId');
    expect(root.path).toBe('/');
  });

  it('types merged search params', () => {
    const match = table.match('/studio/doc/1/comment/2?tab=history');
    expect(isMatchOf(match, commentRoute)).toBe(true);
    if (isMatchOf(match, commentRoute)) {
      expectTypeOf(match.search.tab).toEqualTypeOf<'comments' | 'history' | undefined>();
      expect(match.search.tab).toBe('history');
      expect(match.params.commentId).toBe('2');
    }
  });
});

describe('patterns', () => {
  it('matches, decodes, scores and builds', () => {
    const p = compilePattern('/doc/:id');
    expect(matchPattern(p, ['doc', 'a%20b'])).toEqual({ id: 'a b' });
    expect(matchPattern(p, ['doc'])).toBeUndefined();
    expect(compilePattern('/doc/new').score).toBeGreaterThan(p.score);
    expect(buildPath(p, { id: 'a b' })).toEqual({ ok: true, value: '/doc/a%20b' });
    const missing = buildPath(p, {});
    expect(!missing.ok && missing.error.code).toBe('SF-NAV-011');
  });
});

describe('search params', () => {
  it('parses leniently with fallbacks and reports invalid keys', () => {
    const schema = {
      n: searchParam.number({ default: 1 }),
      b: searchParam.boolean(),
      s: searchParam.string(),
      e: searchParam.enum(['x', 'y'], { default: 'x' }),
      c: searchParam.custom({ decode: (raw) => (raw.startsWith('#') ? raw.slice(1) : 'invalid'), encode: (v: string) => `#${v}` }),
    };
    const parsed = parseSearch(schema, new URLSearchParams('n=abc&b=1&s=hi&e=z&c=%23ok'));
    expect(parsed.values).toEqual({ n: 1, b: true, s: 'hi', e: 'x', c: 'ok' });
    expect(parsed.invalid).toEqual(['n', 'e']);
    expect(serializeSearch(schema, { n: 1, b: false, s: 'x y', e: 'y', c: 'v' })).toBe('?b=0&s=x+y&e=y&c=%23v');
    expect(serializeSearch(schema, {})).toBe('');
    expect(serializeSearch(schema, undefined)).toBe('');
  });
});

describe('route table', () => {
  it('matches nested routes; static beats params; abstract never matches', () => {
    expect(table.match('/studio/doc/new')?.route).toBe(newDoc);
    const m = table.match('/studio/doc/42?rev=3#x');
    expect(m?.route).toBe(docRoute);
    expect(m?.chain).toEqual([studioRoute, docRoute]);
    expect(m?.params).toEqual({ id: '42' });
    expect(m?.search).toEqual({ tab: undefined, rev: 3 });
    expect(m?.location).toEqual({ pathname: '/studio/doc/42', search: '?rev=3', hash: '#x', href: '/studio/doc/42?rev=3#x' });
    expect(table.match('/studio')).toBeUndefined();
    expect(table.match('/nope')).toBeUndefined();
    expect(table.match('/studio/doc/42/')?.route).toBe(docRoute);
  });

  it('matches feature-level and app-level dialogs (R7.16)', () => {
    const m = table.match('/studio/doc/42/d/share?rev=1');
    expect(m?.route).toBe(docRoute);
    expect(m?.dialog).toBe(share);
    expect(m?.baseHref).toBe('/studio/doc/42?rev=1');
    expect(table.match('/d/upsell')?.dialog).toBe(upsell);
    expect(table.match('/studio/doc/42/d/upsell')?.dialog).toBe(upsell);
    // share is owned by the doc route; not available at root
    expect(table.match('/d/share')).toBeUndefined();
    expect(table.match('/studio/doc/42/d/unknown')).toBeUndefined();
  });

  it('builds typed hrefs including dialogs', () => {
    expect(table.build({ to: docRoute, params: { id: '7' }, search: { tab: 'comments', rev: 2 }, hash: 'top' })).toEqual({
      ok: true,
      value: '/studio/doc/7?tab=comments&rev=2#top',
    });
    expect(table.build({ to: docRoute, params: { id: '7' }, dialog: share })).toEqual({ ok: true, value: '/studio/doc/7/d/share' });
    expect(table.build({ to: root, dialog: upsell })).toEqual({ ok: true, value: '/d/upsell' });
    const wrongOwner = table.build({ to: root, dialog: share });
    expect(!wrongOwner.ok && wrongOwner.error.code).toBe('SF-NAV-008');
  });

  it('rejects invalid definitions (SF-NAV-007)', () => {
    const dup = createRouteTable([root, root]);
    expect(!dup.ok && dup.error.code).toBe('SF-NAV-007');
    const orphan = createRouteTable([docRoute]);
    expect(!orphan.ok && orphan.error.code).toBe('SF-NAV-007');
    const samePath = createRouteTable([root, defineRoute({ id: 'x/y', path: '' })]);
    expect(!samePath.ok && samePath.error.code).toBe('SF-NAV-007');
    const badKey = createRouteTable([root], [defineDialog({ id: 'a/b', key: 'Bad Key' })]);
    expect(!badKey.ok && badKey.error.code).toBe('SF-NAV-007');
    const dupKey = createRouteTable([root], [upsell, defineDialog({ id: 'a/c', key: 'upsell' })]);
    expect(!dupKey.ok && dupKey.error.code).toBe('SF-NAV-007');
    const badView = createRouteTable([root, defineRoute({ id: 'v/x', path: 'x', parent: root, view: true, loaders: [() => ({ ok: true, value: { kind: 'continue' } })] })]);
    expect(!badView.ok && badView.error.code).toBe('SF-NAV-007');
    const badOwner = createRouteTable([root], [share]);
    expect(!badOwner.ok && badOwner.error.code).toBe('SF-NAV-007');
  });

  it('merges requirements outer → inner, then the dialog', () => {
    const m = table.match('/studio/doc/1') as RouteMatch;
    expect(requirementsOf(m.chain, undefined)).toEqual({ auth: 'required', resource: 'doc' });
    const d = defineDialog({ id: 'a/d', key: 'k', requires: { auth: 'optional' } });
    expect(requirementsOf(m.chain, d)).toEqual({ auth: 'optional', resource: 'doc' });
  });
});

describe('classification (R7.7, R7.17)', () => {
  const m = (href: string): RouteMatch => table.match(href) as RouteMatch;
  it('view for view search / child view routes / hash inside one feature', () => {
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1?tab=comments'))).toBe('view');
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1#x'))).toBe('view');
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1?utm=1'))).toBe('view');
  });
  it('view when only view sub-routes are entered/left; full when a normal segment changes', () => {
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1/comment/3'))).toBe('view');
    expect(classifyNavigation(m('/studio/doc/1/comment/3'), m('/studio/doc/1/comment/4'))).toBe('view');
    expect(classifyNavigation(m('/studio/doc/1/comment/3'), m('/studio/doc/1'))).toBe('view');
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/2'))).toBe('full');
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1?rev=2'))).toBe('full');
  });
  it('full for route-kind search on the feature route, other features, or no feature', () => {
    const featureDoc = defineRoute({
      id: 'f/doc',
      path: 'f/:id',
      search: { q: searchParam.string() },
      feature: bindCapability('f/cap', [{ feature: studio }]),
    });
    const t = createRouteTable([root, featureDoc]);
    if (!t.ok) throw t.error;
    const tm = (h: string): RouteMatch => t.value.match(h) as RouteMatch;
    expect(classifyNavigation(tm('/f/1'), tm('/f/1?q=a'))).toBe('full');
    expect(classifyNavigation(tm('/f/1'), tm('/f/2'))).toBe('full');
    expect(classifyNavigation(tm('/f/1'), tm('/'))).toBe('full');
    expect(classifyNavigation(undefined, tm('/'))).toBe('full');
  });
  it('dialog when only the dialog differs', () => {
    expect(classifyNavigation(m('/studio/doc/1'), m('/studio/doc/1/d/share'))).toBe('dialog');
    expect(classifyNavigation(m('/studio/doc/1/d/share'), m('/studio/doc/1'))).toBe('dialog');
    expect(classifyNavigation(m('/studio/doc/1/d/share'), m('/studio/doc/1/d/upsell'))).toBe('dialog');
    expect(classifyNavigation(m('/studio/doc/1/d/share'), m('/studio/doc/2'))).toBe('full');
  });
  it('diffs chains by route and params', () => {
    const d = diffChains(m('/studio/doc/1/comment/3'), m('/studio/doc/2'));
    expect(d.leaving).toEqual([commentRoute, docRoute]);
    expect(d.entering).toEqual([docRoute]);
    expect(diffChains(undefined, m('/')).entering).toEqual([root]);
  });
});

describe('stage plans (R7.6)', () => {
  it('orders built-ins and splices custom stages before/after anchors', () => {
    const consent = defineStage({ id: 'app/consent', position: 'after:auth-boundary' });
    const early = defineStage({ id: 'app/early', position: 'before:authorize', order: 1 });
    const earlier = defineStage({ id: 'app/earlier', position: 'before:authorize', order: 0 });
    const post = defineStage({ id: 'app/post', position: 'after:commit', pipelines: ['full', 'view'] });
    const plan = planStages('full', [consent, early, earlier, post]).map((s) => s.name);
    expect(plan).toEqual([
      'resolve', 'exit', 'availability', 'transient', 'pre-auth', 'auth-boundary', 'app/consent', 'post-auth',
      'app/earlier', 'app/early', 'authorize', 'load', 'prefetch', 'enter', 'render', 'commit', 'app/post',
    ]);
    const view = planStages('view', [consent, post]);
    expect(view.map((s) => s.name)).toEqual(['exit', 'enter', 'commit', 'app/post']);
    expect(view.find((s) => s.name === 'app/post')?.postCommit).toBe(true);
    const full = planStages('full', []);
    expect(full.filter((s) => s.uninterruptible).map((s) => s.name)).toEqual(['render', 'commit']);
    expect(planStages('dialog', []).map((s) => s.name)).toEqual(['exit', 'availability', 'authorize', 'load', 'enter', 'commit']);
  });
  it('validates custom stages', () => {
    expect(validateStages([defineStage({ id: 'a/b', position: 'before:nope' as never })]).ok).toBe(false);
    const s = defineStage({ id: 'a/b', position: 'before:load' });
    expect(validateStages([s, s]).ok).toBe(false);
    expect(validateStages([s]).ok).toBe(true);
  });
});
