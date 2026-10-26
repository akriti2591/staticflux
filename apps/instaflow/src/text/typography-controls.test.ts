// @vitest-environment node
/**
 * B11b's text controls on the typography service (TEXT-FONTS §4.2–§4.3): strikethrough and sub/superscript in the
 * summary, paragraph spacing, box mode and vertical alignment on the element, Convert case (marks kept per run),
 * Clear formatting, and the M1 presets (matched back by the summary, shrunk on narrow pages).
 */
import { err, ok } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { DocumentCRDTv2, PartOp, PeerId } from '@staticflux/document/v2';
import { afterEach, describe, expect, it } from 'vitest';
import { TEXT_MARK_EXPAND } from './model.js';
import { createTextOps, readTextBlock, setCharMarkOps, type TextBlockModel } from './rich-text.js';
import { convertCase, createTypographyService, matchPreset, TEXT_ELEMENT_PATHS, TEXT_PRESETS } from './typography.js';

const meta = { actor: { kind: 'human', id: 'u' }, label: 'Edit' };
const parts: DocumentCRDTv2[] = [];
afterEach(() => {
  parts.length = 0;
});

function seed(text: string): DocumentCRDTv2 {
  const part = createLoroEngine({ marks: TEXT_MARK_EXPAND }).create({ peer: '7' as PeerId });
  parts.push(part);
  const ops = createTextOps({ node: 't', parent: null, text });
  if (!ops.ok) throw ops.error;
  const r = part.transact(meta, ops.value);
  if (!r.ok) throw r.error;
  return part;
}
const read = (part: DocumentCRDTv2): TextBlockModel => {
  const b = readTextBlock(part, 't');
  if (!b.ok) throw b.error;
  return b.value;
};

function rig(text: string, pageWidth = 1080) {
  const part = seed(text);
  let selection: [number, number] = [0, 0];
  const labels: string[] = [];
  const commit = (ops: readonly PartOp[], label: string) => {
    labels.push(label);
    const r = part.transact({ ...meta, label }, ops);
    return r.ok ? ok(undefined) : err(r.error);
  };
  const service = createTypographyService({
    current: () => ({ block: read(part), from: selection[0], to: selection[1], element: { box: (part.prop('t', TEXT_ELEMENT_PATHS.box) as never) ?? 'auto-height', verticalAlign: (part.prop('t', TEXT_ELEMENT_PATHS.verticalAlign) as never) ?? 'top' } }),
    commit,
    defaults: { size: 20 },
    pageWidth: () => pageWidth,
  });
  return { part, service, labels, select: (from: number, to: number) => (selection = [from, to]) };
}

describe('typography controls (B11b)', () => {
  it('strikethrough and sub/superscript show in the summary; superscript replaces subscript; null clears', () => {
    const { service, select } = rig('H2O and E=mc2');
    expect(service.summary()).toMatchObject({ strike: false, script: undefined, spaceBefore: 0, spaceAfter: 0, indent: 0, box: 'auto-height', verticalAlign: 'top' });
    select(1, 2);
    expect(service.setScript('sub').ok).toBe(true);
    expect(service.summary()?.script).toBe('sub');
    expect(service.setScript('super').ok).toBe(true);
    expect(service.summary()?.script).toBe('super');
    expect(service.setScript(null).ok).toBe(true);
    expect(service.summary()?.script).toBeUndefined();
    select(0, 3);
    expect(service.toggle('strike').ok).toBe(true);
    expect(service.summary()?.strike).toBe(true);
    select(0, 6);
    expect(service.summary()?.strike).toBe('mixed');
  });

  it('paragraph spacing and indent; box mode and vertical alignment are element props', () => {
    const { part, service } = rig('One\nTwo');
    expect(service.setParagraph({ spaceBefore: 4, spaceAfter: 12, indent: 16 }).ok).toBe(true);
    expect(service.summary()).toMatchObject({ spaceBefore: 4, spaceAfter: 12, indent: 16 });
    expect(service.setBox('fixed').ok).toBe(true);
    expect(service.setVerticalAlign('middle').ok).toBe(true);
    expect([part.prop('t', TEXT_ELEMENT_PATHS.box), part.prop('t', TEXT_ELEMENT_PATHS.verticalAlign)]).toEqual(['fixed', 'middle']);
    expect(service.summary()).toMatchObject({ box: 'fixed', verticalAlign: 'middle' });
    expect(service.setBox('round' as never).ok).toBe(false);
    expect(service.setVerticalAlign('sideways' as never).ok).toBe(false);
    expect(service.setParagraph({ spaceAfter: -1 }).ok).toBe(false);
  });

  it('Convert case rewrites the text and keeps each run’s marks; one step', () => {
    const { part, service, labels, select } = rig('night MARKET tonight. come early');
    const bold = setCharMarkOps(read(part), 6, 12, 'bold', true);
    if (!bold.ok) throw bold.error;
    part.transact(meta, bold.value);
    expect(service.convertCase('upper').ok).toBe(true);
    expect(read(part).text).toBe('NIGHT MARKET TONIGHT. COME EARLY');
    expect(read(part).paragraphs[0]?.runs.find((r) => r.style.bold === true)).toMatchObject({ start: 6, end: 12 });
    expect(service.convertCase('sentence').ok).toBe(true);
    expect(read(part).text).toBe('Night market tonight. Come early');
    expect(service.convertCase('title').ok).toBe(true);
    expect(read(part).text).toBe('Night Market Tonight. Come Early');
    select(0, 5);
    expect(service.convertCase('lower').ok).toBe(true);
    expect(read(part).text).toBe('night Market Tonight. Come Early');
    expect(labels.filter((l) => l === 'Convert case')).toHaveLength(4);
    expect(service.convertCase('loud' as never).ok).toBe(false);
  });

  it('Clear formatting removes every character mark; paragraph marks stay', () => {
    const { part, service } = rig('Hello');
    const marks = setCharMarkOps(read(part), 0, 5, 'italic', true);
    if (!marks.ok) throw marks.error;
    part.transact(meta, marks.value);
    expect(service.toggle('bold').ok).toBe(true);
    expect(service.setAlign('center').ok).toBe(true);
    expect(service.clearFormatting().ok).toBe(true);
    expect(read(part).paragraphs[0]?.runs[0]?.style).toEqual({});
    expect(service.summary()?.align).toBe('center');
  });

  it('presets apply size, weight, line height and space after; the summary names the matching preset; narrow pages × 0.75', () => {
    const wide = rig('Big news');
    expect(wide.service.applyPreset('Heading 1').ok).toBe(true);
    expect(wide.service.summary()).toMatchObject({ size: 48, weight: 700, lineHeight: 1.1, spaceAfter: 12, preset: 'Heading 1' });
    expect(wide.labels.at(-1)).toBe('Heading 1');
    expect(wide.service.setSize(47).ok).toBe(true);
    expect(wide.service.summary()?.preset).toBeUndefined();
    expect(wide.service.applyPreset('Nope' as never).ok).toBe(false);
    const story = rig('Small news', 720);
    expect(story.service.applyPreset('Title').ok).toBe(true);
    expect(story.service.summary()).toMatchObject({ size: 48, weight: 800, spaceAfter: 12, preset: 'Title' });
    expect(matchPreset({ size: TEXT_PRESETS.Body.size, weight: 400, lineHeight: 1.4, spaceAfter: 8 })).toBe('Body');
  });

  it('convertCase: word and sentence starts', () => {
    expect(convertCase('hello world', 'title')).toBe('Hello World');
    expect(convertCase('world', 'title', false, false)).toBe('world');
    expect(convertCase('ONE. TWO! three', 'sentence')).toBe('One. Two! Three');
    expect(convertCase('straße', 'upper')).toBe('STRASSE');
  });
});
