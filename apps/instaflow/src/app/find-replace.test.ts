// @vitest-environment node
/**
 * B11c slice 3: find and replace over a real two-page Studio document (STUDIO §9.1): text across pages (case, marks
 * kept), fonts, colours (fills, strokes, text, page backgrounds), scopes, locked elements skipped and counted, one
 * undo step for Replace all.
 */
import { ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { placeTextOps } from '../text/commands.js';
import { readTextBlock, setCharMarkOps } from '../text/rich-text.js';
import { FindCapability, findMatches, type FindEnv, implementFindReplace, ReplaceCapability, replaceLabel, resolvedHex, runReplace } from './find-replace.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const rect = (node: string, page: string, fill: string, stroke?: string): PartOp => ({
  op: 'create',
  node,
  kind: 'shape',
  parent: page,
  props: { [P.x]: 0, [P.y]: 0, [P.w]: 50, [P.h]: 50, [P.fills]: [{ paint: fill }], ...(stroke === undefined ? {} : { [P.strokes]: [{ paint: stroke, width: 2 }] }) },
});

async function rig() {
  const f = await createStudioFixture({ pages: 2 });
  const doc = f.document;
  let open: NodeId = 'p1';
  const env: FindEnv = { document: doc, page: () => open, defaultFamily: () => 'Noto Sans', name: (n) => (n.startsWith('t') ? `Text ${n}` : `Rectangle ${n}`) };
  unwrap(doc.commitOps('p1', person, 'Seed', unwrap(placeTextOps({ node: 't1', parent: 'p1', x: 0, y: 0, text: 'Spring sale: spring prices' }))));
  unwrap(doc.commitOps('p1', person, 'Seed', unwrap(placeTextOps({ node: 't3', parent: 'p1', x: 0, y: 90, text: 'Spring is locked' }))));
  unwrap(doc.commitOps('p2', person, 'Seed', unwrap(placeTextOps({ node: 't2', parent: 'p2', x: 0, y: 0, text: 'SPRING' }))));
  // Bold "Spring" at the start of t1; a coloured run in t2.
  const block = (n: NodeId, page: NodeId) => unwrap(readTextBlock(doc.part(page) as never, n));
  unwrap(doc.commitOps('p1', person, 'Bold', unwrap(setCharMarkOps(block('t1', 'p1'), 0, 6, 'bold', true))));
  unwrap(doc.commitOps('p2', person, 'Colour', unwrap(setCharMarkOps(block('t2', 'p2'), 0, 6, 'color', '#ff5c39'))));
  unwrap(commitEdit(doc.target('p2'), person, 'Seed', ok([rect('r1', 'p2', '#FF5C39', '#ff5c39'), rect('r2', 'p2', '#00b37e')])));
  unwrap(doc.commitOps('p1', person, 'Lock', [{ op: 'set', node: 't3', path: P.lockScope, value: 'all' }]));
  return { f, doc, env, block, show: (page: NodeId) => (open = page) };
}

describe.skipIf(!authoringBuilt)('find and replace (B11c, STUDIO §9.1)', () => {
  it('finds text on every page, case-insensitive by default, Aa matches case; scopes narrow it', async () => {
    const { f, env, show } = await rig();
    const all = findMatches(env, { kind: 'text', query: 'spring' });
    expect(all.pages).toBe(2);
    expect(all.matches.map((m) => [m.node, m.page, m.from, m.to, m.locked])).toEqual([
      ['t1', 'p1', 0, 6, false],
      ['t1', 'p1', 13, 19, false],
      ['t3', 'p1', 0, 6, true],
      ['t2', 'p2', 0, 6, false],
    ]);
    expect(all.matches[0]?.label).toBe('Text t1');
    expect(findMatches(env, { kind: 'text', query: 'Spring', matchCase: true }).matches.map((m) => m.id)).toEqual(['t1:text:0', 't3:text:0']);
    show('p2');
    expect(findMatches(env, { kind: 'text', query: 'spring', scope: 'page' }).matches.map((m) => m.node)).toEqual(['t2']);
    expect(findMatches(env, { kind: 'text', query: 'spring', scope: 'selection', nodes: ['t3'] }).matches.map((m) => m.node)).toEqual(['t3']);
    expect(findMatches(env, { kind: 'text', query: 'autumn' }).matches).toEqual([]);
    await f.scope.dispose();
  });

  it('Replace all is one undo step across pages, keeps the run’s marks, skips locked elements and counts them', async () => {
    const { f, doc, env, block } = await rig();
    const done = unwrap(runReplace(env, person, { kind: 'text', query: 'spring' }, 'Autumn'));
    expect(done).toMatchObject({ replaced: 3, skipped: 1, label: "Replace 'spring' with 'Autumn'" });
    expect(block('t1', 'p1').text).toBe('Autumn sale: Autumn prices');
    expect(block('t1', 'p1').paragraphs[0]?.runs[0]?.style.bold).toBe(true); // the bold run stays bold
    expect(block('t2', 'p2').text).toBe('Autumn');
    expect(block('t3', 'p1').text).toBe('Spring is locked');
    expect(doc.undo.history(person.id).undo[0]?.label).toBe("Replace 'spring' with 'Autumn'");
    unwrap(await doc.undo.undo(person, f.signal));
    expect([block('t1', 'p1').text, block('t2', 'p2').text]).toEqual(['Spring sale: spring prices', 'SPRING']);
    // Replace one match (the find bar's Replace): only that one.
    const first = findMatches(env, { kind: 'text', query: 'spring' }).matches[1] as { id: string };
    unwrap(runReplace(env, person, { kind: 'text', query: 'spring' }, 'fall', { only: new Set([first.id]) }));
    expect(block('t1', 'p1').text).toBe('Spring sale: fall prices');
    await f.scope.dispose();
  });

  it('colour: fills, strokes, text colour and page backgrounds by resolved hex; replace writes the new hex', async () => {
    const { f, doc, env, block } = await rig();
    expect(resolvedHex('#ff5c39', doc.kit)).toBe('#FF5C39');
    expect(resolvedHex('rgb(255 92 57 / 50%)', doc.kit)).toBe('#FF5C39');
    expect(findMatches(env, { kind: 'colour', query: '#FF5C39' }).matches.map((m) => [m.node, m.where])).toEqual([
      ['t2', 'text-colour'],
      ['r1', 'fill'],
      ['r1', 'stroke'],
    ]);
    expect(findMatches(env, { kind: 'colour', query: '#ffffff' }).matches.map((m) => [m.node, m.where])).toEqual([
      ['p1', 'background'],
      ['p2', 'background'],
    ]);
    unwrap(runReplace(env, person, { kind: 'colour', query: '#ff5c39' }, '#3D5AFE'));
    expect(doc.view.value('r1', P.fills)).toEqual([{ paint: '#3d5afe' }]);
    expect((doc.view.value('r1', P.strokes) as { paint: string }[])[0]?.paint).toBe('#3d5afe');
    expect(doc.view.value('r2', P.fills)).toEqual([{ paint: '#00b37e' }]);
    expect(block('t2', 'p2').paragraphs[0]?.runs[0]?.style.color).toBe('#3d5afe');
    const bad = runReplace(env, person, { kind: 'colour', query: '#00b37e' }, 'not a colour');
    expect(!bad.ok && bad.error.code).toBe('IF-EL-004');
    await f.scope.dispose();
  });

  it('font: runs with no font mark use the default face; replacing sets the new face on those runs', async () => {
    const { f, env, block } = await rig();
    expect(findMatches(env, { kind: 'font', query: 'noto sans' }).matches.map((m) => [m.node, m.where])).toEqual([
      ['t1', 'font'],
      ['t3', 'font'],
      ['t2', 'font'],
    ]);
    const font = { font: 'sha256:abc123abc123' as const, family: 'Inter' };
    expect(runReplace(env, person, { kind: 'font', query: 'Noto Sans' }, 'Inter').ok).toBe(false); // no face given
    const done = unwrap(runReplace(env, person, { kind: 'font', query: 'Noto Sans' }, 'Inter', { font }));
    expect(done).toMatchObject({ replaced: 2, skipped: 1, label: "Replace 'Noto Sans' with 'Inter'" });
    expect(block('t1', 'p1').paragraphs[0]?.runs.every((r) => (r.style.font as { family?: string } | undefined)?.family === 'Inter')).toBe(true);
    expect(findMatches(env, { kind: 'font', query: 'inter' }).matches.map((m) => m.node)).toEqual(['t1', 't2']);
    await f.scope.dispose();
  });

  it('the capabilities run it (the bar, the command bar and agents) and name their step', async () => {
    const { f, env } = await rig();
    const impls = new Map(implementFindReplace({ ...env, actorFor: () => ok(person) }).map((i) => [i.capability.id as string, i]));
    const runIt = async (id: string, input: unknown) => (await (impls.get(id) as { run(i: unknown, r: unknown): Promise<Result<unknown>> | Result<unknown> }).run(input, {})) as Result<{ matches?: unknown[]; replaced?: number }>;
    const found = unwrap(await runIt(FindCapability.id, { kind: 'text', query: 'sale' }));
    expect(found.matches).toHaveLength(1);
    const replaced = unwrap(await runIt(ReplaceCapability.id, { kind: 'text', query: 'sale', replacement: 'deal' }));
    expect(replaced.replaced).toBe(1);
    expect(replaceLabel({ query: 'a very long phrase that goes on and on' }, 'b')).toBe("Replace 'a very long phrase that…' with 'b'");
    await f.scope.dispose();
  });
});
