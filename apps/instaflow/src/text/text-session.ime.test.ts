// @vitest-environment node
// The owner's IME check (docs/instaflow/checks/2026-10-25-ime.md, finding 2): in EditContext mode the control
// bounds grew by about one line per key during a composition although no newline was inserted.
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { scriptedTextInput } from '../app/test-helpers.js';
import { encodeLayoutSpec } from './layout-spec.js';
import type { TextBlockModel } from './rich-text.js';
import { authoringBuilt, STACK, testTextEngine } from './test-helpers.js';
import { createTextSession } from './text-session.js';

const blockOf = (text: string): TextBlockModel => {
  const paragraphs = [];
  let start = 0;
  for (const [index, part] of text.split('\n').entries()) {
    paragraphs.push({ index, start, end: start + part.length, text: part, style: {}, runs: [{ start, end: start + part.length, style: {} }] });
    start += part.length + 1;
  }
  return { node: 't', text, paragraphs } as unknown as TextBlockModel;
};

describe.skipIf(!authoringBuilt)('text session under an IME composition', () => {
  it('keeps the control bounds at the text block’s height through a multi-key composition (EditContext ranges)', async () => {
    const engine = await testTextEngine();
    const text = 'Type here: ';
    const input = scriptedTextInput();
    // A narrow box: the pinyin preview wraps while it grows (as CJK fallback fonts change line metrics), which is
    // what moved the control bounds: they were taken from the preview layout.
    const layout = (model: TextBlockModel) =>
      engine.layout(1, encodeLayoutSpec({ width: 180, paragraphs: model.paragraphs.map((p) => ({ text: p.text, spans: [{ start: 0, end: p.text.length, family: STACK, size: 28 }] })) }), model.text);
    const session = createTextSession({
      input,
      engine,
      blockId: 1,
      layout,
      target: { read: () => ok(blockOf(text)), commit: () => ok() }, // the commit is not applied: the block stays
      toClient: (r) => ({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }),
    });
    if (!session.ok) throw new Error(session.error.message);
    const height = input.controlBounds.at(-1)?.height as number;
    expect(height).toBeGreaterThan(20);
    const at = text.length;
    // What Chrome's EditContext sends for pinyin "zhongwen": compositionstart at the caret, then one textupdate per
    // key whose range is the previous composition (the EditContext buffer already holds it) and whose text is the
    // whole composition so far.
    input.emit({ kind: 'compose-start', range: [at, at] });
    let previous = '';
    for (const composed of ['z', 'zh', 'zho', 'zhon', 'zhong', 'zhong w', 'zhong we', 'zhong wen', 'zhong wen zi', 'zhong wen zi mu']) {
      input.emit({ kind: 'compose-update', text: composed, range: [at, at + previous.length], selection: [at + composed.length, at + composed.length] });
      previous = composed;
      expect(input.controlBounds.at(-1)?.height, composed).toBeCloseTo(height, 3);
    }
    // The preview itself did wrap (so the old code grew the bounds); the committed text sets them again.
    expect(session.value.state.layout?.lines().length).toBeGreaterThan(1);
    input.emit({ kind: 'compose-commit', text: '中文字幕', range: [at, at + previous.length] });
    expect(input.controlBounds.at(-1)?.height).toBeCloseTo(height, 3);
    session.value.dispose();
  });
});
