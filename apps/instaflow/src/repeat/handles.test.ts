// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { authoringBuilt, human, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { RP } from './components.js';
import { beginHandleDrag, handlePatch, RepeatHandleDragLifecycle, repeatHandles } from './handles.js';
import type { RadialParams } from './params.js';
import { createRepeatFixture } from './testing/fixtures.js';

const fill = [{ paint: '#ff5c39' }];
/** A radial repeat inside a group moved by (1000, 0), so page and local space differ. */
const radialScene = () => [
  shape('frame', { [P.x]: 1000 }, 'p1', 'group'),
  shape('r', { [RP.kind]: 'radial', [RP.count]: 4, [RP.radius]: 50 }, 'frame', 'group'),
  shape('a', { [P.x]: 100, [P.y]: 100, [P.w]: 40, [P.h]: 20, [P.fills]: fill }, 'r'),
];
const close = (a: readonly number[], b: readonly number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 6));

describe('handle drag machine', () => {
  it('is declared for LIFECYCLES §27', () => {
    expect(RepeatHandleDragLifecycle.id).toBe('instaflow/repeat-handle-drag');
    expect(RepeatHandleDragLifecycle.terminal).toEqual(['committed', 'cancelled', 'failed']);
  });
});

describe.skipIf(!authoringBuilt)('repeat handles', () => {
  it('places handles in page space per generator', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [
      ...radialScene(),
      shape('grid', { [RP.kind]: 'grid', [RP.rows]: 2, [RP.columns]: 3, [RP.gapX]: 10, [RP.gapY]: 10 }, 'p1', 'group'),
      shape('cell', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'grid'),
      shape('mirror', { [RP.kind]: 'mirror', [RP.offset]: 4 }, 'p1', 'group'),
      shape('half', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'mirror'),
    ]);
    const ctx = f.rctx();
    const radial = unwrap(repeatHandles(ctx, 'r'));
    expect(radial.map((h) => h.id)).toEqual(['radius', 'count']);
    close(radial[0]!.position, [1120, 160]); // the circle centre
    close(radial[0]!.direction, [0, -1]);
    close(radial[1]!.position, [1170, 160]); // the second instance, at 3 o'clock
    const grid = unwrap(repeatHandles(ctx, 'grid'));
    expect(grid.map((h) => [h.id, ...h.position])).toEqual([
      ['columns', 85, 10],
      ['rows', 10, 55],
    ]);
    const mirror = unwrap(repeatHandles(ctx, 'mirror'));
    expect(mirror[0]?.id).toBe('offset');
    close(mirror[0]!.position, [24, 10]);
    expect(!repeatHandles(ctx, 'a').ok).toBe(true);
  });

  it('maps drags to parameters', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [
      ...radialScene(),
      shape('grid', { [RP.kind]: 'grid', [RP.rows]: 2, [RP.columns]: 3, [RP.gapX]: 10, [RP.gapY]: 10 }, 'p1', 'group'),
      shape('cell', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'grid'),
      shape('mirror', { [RP.kind]: 'mirror' }, 'p1', 'group'),
      shape('half', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'mirror'),
    ]);
    const ctx = f.rctx();
    expect(unwrap(handlePatch(ctx, 'r', 'radius', [1120, 190]))).toEqual({ radius: 80 });
    expect(unwrap(handlePatch(ctx, 'r', 'radius', [1120, 50]))).toEqual({ radius: 0 });
    expect(unwrap(handlePatch(ctx, 'r', 'count', [1120 + 50 * Math.sin(Math.PI / 4), 160 - 50 * Math.cos(Math.PI / 4)]))).toEqual({ count: 8 });
    expect(unwrap(handlePatch(ctx, 'grid', 'columns', [150, 10]))).toEqual({ columns: 5 });
    expect(unwrap(handlePatch(ctx, 'grid', 'rows', [10, -100]))).toEqual({ rows: 1 });
    expect(unwrap(handlePatch(ctx, 'mirror', 'offset', [30, 10]))).toEqual({ offset: 10 });
    const wrong = handlePatch(ctx, 'grid', 'radius', [0, 0]);
    expect(!wrong.ok && wrong.error.code).toBe('IF-REP-005');
  });

  it('previews a drag in the session layer, commits one undo step, and cancels cleanly', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, radialScene());
    const env = { context: f.rctx(), session: f.stage.session, target: f.target };
    const controller = new AbortController();
    const drag = unwrap(beginHandleDrag(env, 'r', 'radius', { signal: controller.signal }));
    expect(drag.state).toBe('dragging');
    expect(unwrap(drag.move([1120, 190]))).toEqual({ radius: 80 });
    expect(f.view.params('r')).toMatchObject({ radius: 80 }); // the live instances follow the preview
    expect(unwrap(drag.move([1120, 170]))).toEqual({ radius: 60 }); // positions map against the start state
    expect(f.undo.history(human.id).undo).toHaveLength(0);
    unwrap(drag.commit(human));
    expect(drag.state).toBe('committed');
    expect(f.stage.explain('r', RP.radius).winner?.layer).toBe('local');
    expect(f.view.params('r')).toMatchObject({ radius: 60 });
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    const late = drag.move([0, 0]);
    expect(!late.ok && late.error.code).toBe('IF-REP-005');
    expect(!drag.commit(human).ok).toBe(true);

    const cancelled = unwrap(beginHandleDrag(env, 'r', 'count', { signal: controller.signal }));
    unwrap(cancelled.move([1120, 210]));
    expect((f.view.params('r') as RadialParams | undefined)?.count).not.toBe(4);
    controller.abort();
    expect(cancelled.state).toBe('cancelled');
    expect((f.view.params('r') as RadialParams | undefined)?.count).toBe(4);
    expect(!beginHandleDrag(env, 'r', 'count', { signal: controller.signal }).ok).toBe(true);

    const idle = unwrap(beginHandleDrag(env, 'r', 'radius', { signal: new AbortController().signal }));
    unwrap(idle.commit(human)); // no move: nothing to write
    expect(idle.state).toBe('cancelled');
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    const locked = await createRepeatFixture(g, [shape('lr', { [RP.kind]: 'radial', [P.lockScope]: 'content' }, 'p1', 'group'), shape('la', { [P.w]: 10, [P.h]: 10, [P.fills]: fill }, 'lr')]);
    const fail = unwrap(beginHandleDrag({ context: locked.rctx(), session: locked.stage.session, target: locked.target }, 'lr', 'radius', { signal: new AbortController().signal }));
    unwrap(fail.move([0, 0]));
    expect(fail.commit(human).ok).toBe(false);
    expect(fail.state).toBe('failed');
    expect((locked.view.params('lr') as RadialParams | undefined)?.radius).toBe(120);
  });
});
