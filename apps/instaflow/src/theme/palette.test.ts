// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLEAN_POP_COLOR_PALETTE } from './palette.js';

describe('the colour popover palette (STUDIO-UX-SPEC §4.2.5)', () => {
  it('is 24 distinct uppercase hex colours (6 × 4)', () => {
    expect(CLEAN_POP_COLOR_PALETTE).toHaveLength(24);
    expect(new Set(CLEAN_POP_COLOR_PALETTE).size).toBe(24);
    for (const hex of CLEAN_POP_COLOR_PALETTE) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });
});
