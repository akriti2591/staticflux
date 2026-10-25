import { describe, expect, it } from 'vitest';
import { createSessionLayer, LOCAL_LAYER, SESSION_LAYER } from './layers.js';

describe('session layer', () => {
  it('holds ephemeral opinions and reports the nodes it changes', () => {
    const layer = createSessionLayer();
    expect(layer.id).toBe(SESSION_LAYER);
    expect(LOCAL_LAYER).toBe('local');
    const seen: string[][] = [];
    const stop = layer.subscribe((nodes) => seen.push([...nodes]));
    layer.set('a', 'view.hidden', true);
    layer.set('a', 'spatial.x', 3);
    layer.set('b', 'spatial.x', 4);
    expect(layer.opinions('a')).toEqual({ 'view.hidden': true, 'spatial.x': 3 });
    expect(layer.opinions('zzz')).toBeUndefined();
    layer.clear('a', 'view.hidden');
    expect(layer.opinions('a')).toEqual({ 'spatial.x': 3 });
    layer.clear('a', 'spatial.x');
    expect(layer.opinions('a')).toBeUndefined();
    layer.clear('nothing');
    layer.set('a', 'k', 1);
    layer.clear('a');
    layer.clear();
    expect(layer.opinions('b')).toBeUndefined();
    expect(seen).toEqual([['a'], ['a'], ['b'], ['a'], ['a'], ['a'], ['a'], ['b']]);
    stop();
    layer.set('c', 'k', 1);
    expect(seen).toHaveLength(8);
  });

  it('keeps an ordered variant selection', () => {
    const layer = createSessionLayer({ selection: [['format', 'post']] });
    const seen: (readonly (readonly [string, string])[])[] = [];
    const stop = layer.onSelection((s) => seen.push(s));
    layer.select('theme', 'dark');
    layer.select('format', 'story');
    expect(layer.selection()).toEqual([
      ['theme', 'dark'],
      ['format', 'story'],
    ]);
    layer.select('theme', undefined);
    expect(layer.selection()).toEqual([['format', 'story']]);
    expect(seen).toHaveLength(3);
    stop();
    layer.select('x', 'y');
    expect(seen).toHaveLength(3);
  });
});
