import { iconProblems } from '@staticflux/kit/icon';
import { describe, expect, it } from 'vitest';
import { BOOLEAN_OPS } from '../elements/components.js';
import { REPEAT_KINDS } from '../repeat/components.js';
import { BOOLEAN_ICONS, LAYER_KINDS, layerKindIcon, REPEAT_ICONS, TOOL_ICON_IDS, toolIcon } from './icons.js';

describe('Instaflow icon tables', () => {
  it('gives every layer kind a kit icon on the one outline set (STUDIO-UX-SPEC §3.1, §10.2)', () => {
    expect(LAYER_KINDS.map((kind) => layerKindIcon(kind).name)).toEqual(['frame', 'group', 'square', 'circle', 'pentagon', 'star', 'minus', 'spline', 'image', 'type', 'repeat-radial', 'boolean-union', 'mask']);
    for (const kind of LAYER_KINDS) expect(iconProblems(layerKindIcon(kind)), kind).toEqual([]);
  });

  it('marks each tool picker tool with the spec icon (STUDIO-UX-SPEC §4.1)', () => {
    expect(TOOL_ICON_IDS.map((tool) => toolIcon(tool).name)).toEqual(['mouse-pointer-2', 'frame', 'square', 'type', 'pen-tool', 'hand']);
  });

  it('covers every repeat kind and boolean operation with a custom icon', () => {
    expect(Object.keys(REPEAT_ICONS).sort()).toEqual([...REPEAT_KINDS].sort());
    expect(Object.keys(BOOLEAN_ICONS).sort()).toEqual([...BOOLEAN_OPS].sort());
    for (const icon of [...Object.values(REPEAT_ICONS), ...Object.values(BOOLEAN_ICONS)]) expect(icon.source).toBe('custom');
  });
});
