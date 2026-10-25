// @vitest-environment node
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { PeerId } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { TEXT_MARK_EXPAND } from '../text/model.js';
import { createTextOps } from '../text/rich-text.js';
import { partTextSource } from './text-source.js';

describe('partTextSource (B2 → B6)', () => {
  it('reads the plain text of text elements and nothing for other nodes', () => {
    const part = createLoroEngine({ marks: TEXT_MARK_EXPAND }).create({ peer: '7' as PeerId });
    const ops = createTextOps({ node: 't1', parent: 'page', text: 'Big sale\nToday only' });
    expect(ops.ok).toBe(true);
    const done = part.transact({ actor: { kind: 'human', id: 'tester' }, label: 'Seed' }, [{ op: 'create', node: 'page', kind: 'page', parent: null, props: {} }, { op: 'create', node: 'r', kind: 'shape', parent: 'page', props: {} }, ...(ops.ok ? ops.value : [])]);
    expect(done.ok).toBe(true);
    const text = partTextSource(part);
    expect(text('t1')).toBe('Big sale\nToday only');
    expect(text('r')).toBeUndefined();
    expect(text('missing')).toBeUndefined();
    part.dispose();
  });
});
