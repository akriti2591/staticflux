import { describe, expect, it } from 'vitest';
import {
  CharMark,
  charStyleOf,
  checkCharMark,
  checkParagraphField,
  isTokenRef,
  MATCH_KEY_PATH,
  ParaMark,
  paragraphMarks,
  paragraphStyleOf,
  TEXT_KIND_COMPONENTS,
  TEXT_MARK_EXPAND,
  TEXT_REGISTRY_OPTIONS,
  TextComponent,
} from './model.js';
import { createElementRegistry, ELEMENT_COMMON_COMPONENTS, P } from '../elements/components.js';
import { createTextOps, previewReplace, type TextBlockModel } from './rich-text.js';

describe('text model', () => {
  it('declares the text component and a mark-expand entry for every mark key', () => {
    expect(TextComponent.id).toBe('text');
    expect(Object.keys(TextComponent.schema)).toEqual(['content', 'box', 'align', 'verticalAlign']);
    for (const key of [...Object.values(CharMark), ...Object.values(ParaMark)]) expect(TEXT_MARK_EXPAND[key]).toBeDefined();
    expect(TEXT_MARK_EXPAND.link).toBe('none');
    expect(TEXT_MARK_EXPAND['p.align']).toBe('none');
    expect(TEXT_MARK_EXPAND.bold).toBe('after');
  });

  it('the text kind carries B1 element components (appearance, masks, corners, match keys)', () => {
    const registry = createElementRegistry(TEXT_REGISTRY_OPTIONS);
    expect(TEXT_KIND_COMPONENTS.text).toEqual([...ELEMENT_COMMON_COMPONENTS, 'text']);
    const ops = createTextOps({ node: 't', parent: null, text: 'Hi', props: { [P.x]: 1, [P.radiusTL]: 4, [P.maskMode]: 'alpha', 'text.align': 'center' } });
    if (!ops.ok) throw ops.error;
    expect(registry.validateOps(ops.value).ok).toBe(true);
    expect(MATCH_KEY_PATH).toBe(P.matchKey);
    const bad = registry.validateOps([{ op: 'create', node: 'x', kind: 'text', parent: null, props: { 'geometry.shape': 'rect' } }]);
    expect(bad.ok).toBe(false);
  });

  it('validates mark values and token refs', () => {
    expect(isTokenRef({ token: 'color.primary' })).toBe(true);
    expect(isTokenRef({ token: 'nodot' })).toBe(false);
    expect(isTokenRef('color.primary')).toBe(false);
    expect(checkCharMark('font', { font: 'sha256:ab' })).toBeUndefined();
    expect(checkCharMark('font', { token: 'font.display', kit: 'as_kit' })).toBeUndefined();
    expect(checkCharMark('link', { href: 'mailto:a@b.c' })).toBeUndefined();
    expect(checkCharMark('link', { href: 'ftp://x' })).toContain('link');
    expect(checkCharMark('size', null)).toBeUndefined();
    expect(checkParagraphField('align', 'justify')).toBeUndefined();
    expect(checkParagraphField('list', 'stars')).toContain('list');
    expect(checkParagraphField('indent', null)).toBeUndefined();
  });

  it('reads styles from marks and writes paragraph marks', () => {
    expect(charStyleOf({ bold: true, size: 'big', color: { token: 'color.a' }, other: 1, 'p.align': 'end' })).toEqual({ bold: true, color: { token: 'color.a' } });
    expect(paragraphStyleOf({ 'p.align': 'end', 'p.lineHeight': 1.5, 'p.list': 'oops', bold: true })).toEqual({ align: 'end', lineHeight: 1.5 });
    expect(paragraphMarks({ align: 'center', indent: 4 })).toEqual({ 'p.align': 'center', 'p.indent': 4 });
  });

  it('previews a composition inside a paragraph without touching others', () => {
    const block: TextBlockModel = {
      node: 't',
      text: 'ab cd\nxy',
      paragraphs: [
        { index: 0, start: 0, end: 5, text: 'ab cd', style: {}, runs: [{ start: 0, end: 2, style: { bold: true } }, { start: 2, end: 5, style: {} }] },
        { index: 1, start: 6, end: 8, text: 'xy', style: { align: 'end' }, runs: [{ start: 6, end: 8, style: {} }] },
      ],
    };
    const p = previewReplace(block, 2, 2, 'にほ', { underline: true });
    expect(p.text).toBe('abにほ cd\nxy');
    expect(p.paragraphs[0]?.runs).toEqual([
      { start: 0, end: 2, style: { bold: true } },
      { start: 2, end: 4, style: { bold: true, underline: true } },
      { start: 4, end: 7, style: {} },
    ]);
    expect(p.paragraphs[1]).toMatchObject({ start: 8, end: 10, runs: [{ start: 8, end: 10, style: {} }] });
    const replaced = previewReplace(block, 3, 5, 'Z\nZ');
    expect(replaced.paragraphs[0]?.text).toBe('ab Z Z');
  });
});
