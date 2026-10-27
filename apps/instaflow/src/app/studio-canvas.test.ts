// @vitest-environment happy-dom
// The canvas port end to end runs in `studio-app.test.ts` (in-process workers); this covers the canvas hand-off.
import { describe, expect, it } from 'vitest';
import type { FocusRingOptions } from '../a11y/dom.js';
import { focusFromPointer, offscreenHandoff } from './studio-canvas.js';

describe('the canvas hand-off to the render module (B9)', () => {
  it('transfers the canvas as an OffscreenCanvas once; without the API it is IF-WRK-006', () => {
    const plain = document.createElement('canvas');
    const missing = offscreenHandoff(Object.assign(plain, { transferControlToOffscreen: undefined }));
    expect(!missing.ok && missing.error.code).toBe('IF-WRK-006');
    const offscreen = { width: 0, height: 0 };
    let transferred = 0;
    const canvas = Object.assign(document.createElement('canvas'), {
      transferControlToOffscreen: () => {
        transferred += 1;
        if (transferred > 1) throw new Error('InvalidStateError: already transferred');
        return offscreen;
      },
    });
    const handed = offscreenHandoff(canvas as never);
    expect(handed.ok && handed.value.canvas).toBe(offscreen);
    expect(handed.ok && handed.value.transfer).toEqual([offscreen]);
    const twice = offscreenHandoff(canvas as never);
    expect(!twice.ok && twice.error.code).toBe('IF-WRK-006');
  });
});

describe('pointer focus on the canvas surface (#41)', () => {
  it('focuses without the keyboard focus ring and without scrolling', () => {
    const surface = document.createElement('div');
    surface.tabIndex = 0;
    document.body.append(surface);
    let seen: FocusRingOptions | undefined;
    const focus = surface.focus.bind(surface);
    surface.focus = (options?: FocusRingOptions) => {
      seen = options;
      focus(options);
    };
    focusFromPointer(surface);
    expect(seen).toEqual({ preventScroll: true, focusVisible: false });
    expect(document.activeElement).toBe(surface);
    surface.remove();
  });
});
