/**
 * Decoded text layout (B2; IF-21.7–21.12): the authoring module's encoded layout (`engine/crates/authoring/src/text`
 * module docs) as typed, read-only views. Coordinates are block px (origin = the text box's top-left, y down).
 *
 * `clusters()`, `words()` and `lines()` have **stable indices for a given text and layout** (clusters in logical
 * order, words = maximal non-space cluster runs between word starts, lines top to bottom), with bounds, so a future
 * animator (M4 Auto Animate: per character, word and line) can address pieces without re-shaping. Nothing here
 * animates.
 */

export const TEXT_LAYOUT_VERSION = 1;
const HEADER = 11;
const PARAGRAPH = 6;
const LINE = 10;
const RUN = 12;
const GLYPH = 4;
const CLUSTER = 9;
const WORD = 9;
const DECORATION = 7;

export const ClusterFlag = Object.freeze({ rtl: 1, space: 2, wordStart: 4, ligatureContinuation: 8, hardBreak: 16, emoji: 32 } as const);

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface LayoutParagraph {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly top: number;
  readonly bottom: number;
  readonly rtl: boolean;
  readonly firstLine: number;
}

export interface LayoutLine {
  readonly index: number;
  readonly paragraph: number;
  readonly start: number;
  readonly end: number;
  readonly bounds: Box;
  readonly baseline: number;
  readonly firstCluster: number;
  readonly clusterCount: number;
}

export interface LayoutGlyph {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Index into `clusters()`. */
  readonly cluster: number;
}

export interface LayoutRun {
  readonly index: number;
  readonly line: number;
  /** Authoring font id (`TextEngine.addFont` order). */
  readonly font: number;
  readonly size: number;
  /** The span's brush (paint / link table index of the block). */
  readonly brush: number;
  readonly rtl: boolean;
  readonly start: number;
  readonly end: number;
  readonly embolden: boolean;
  /** Synthetic italic angle in degrees (0 = none). */
  readonly skew: number;
  /** Variation coordinates (F2Dot14). */
  readonly coords: readonly number[];
  readonly glyphs: readonly LayoutGlyph[];
}

export interface LayoutCluster {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly bounds: Box;
  readonly flags: number;
  /** Index into `words()`, or -1 for whitespace. */
  readonly word: number;
}

export interface LayoutWord {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly bounds: Box;
  readonly firstCluster: number;
  readonly clusterCount: number;
}

export interface LayoutDecoration {
  readonly kind: 'underline' | 'strike';
  readonly brush: number;
  readonly line: number;
  readonly bounds: Box;
}

export interface TextLayout {
  readonly width: number;
  readonly height: number;
  paragraphs(): readonly LayoutParagraph[];
  lines(): readonly LayoutLine[];
  runs(): readonly LayoutRun[];
  clusters(): readonly LayoutCluster[];
  words(): readonly LayoutWord[];
  decorations(): readonly LayoutDecoration[];
  /** The cluster containing a UTF-16 offset (undefined on a paragraph break or past the end). */
  clusterAt(offset: number): LayoutCluster | undefined;
  /** Clusters of a word or a line (animator helpers). */
  clustersOf(piece: Pick<LayoutWord, 'firstCluster' | 'clusterCount'>): readonly LayoutCluster[];
  /** Ink-agnostic content bounds (union of line boxes). */
  readonly bounds: Box;
}

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });

/** Decode an encoded layout (throws RangeError on a truncated or foreign buffer: engine output only). */
export function decodeTextLayout(data: Float32Array | readonly number[]): TextLayout {
  const v = data;
  const at = (i: number): number => {
    const x = v[i];
    if (x === undefined) throw new RangeError(`text layout: truncated at ${i}`);
    return x;
  };
  if (at(0) !== TEXT_LAYOUT_VERSION) throw new RangeError(`text layout: version ${at(0)} (expected ${TEXT_LAYOUT_VERSION})`);
  const [width, height, nPara, nLine, nRun, nGlyph, nCluster, nWord, nDeco] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(at) as [number, number, number, number, number, number, number, number, number];
  let i = HEADER;
  const paragraphs: LayoutParagraph[] = [];
  for (let k = 0; k < nPara; k++, i += PARAGRAPH) paragraphs.push({ index: k, start: at(i), end: at(i + 1), top: at(i + 2), bottom: at(i + 3), rtl: at(i + 4) === 1, firstLine: at(i + 5) });
  const lines: LayoutLine[] = [];
  for (let k = 0; k < nLine; k++, i += LINE) {
    lines.push({ index: k, paragraph: at(i), start: at(i + 1), end: at(i + 2), bounds: box(at(i + 3), at(i + 5), at(i + 4), at(i + 6)), baseline: at(i + 7), firstCluster: at(i + 8), clusterCount: at(i + 9) });
  }
  const runHeads: { fixed: number; coords: number[] }[] = [];
  for (let k = 0; k < nRun; k++) {
    const n = at(i + 11);
    runHeads.push({ fixed: i, coords: Array.from({ length: n }, (_, c) => at(i + RUN + c)) });
    i += RUN + n;
  }
  const glyphs: LayoutGlyph[] = [];
  for (let k = 0; k < nGlyph; k++, i += GLYPH) glyphs.push({ id: at(i), x: at(i + 1), y: at(i + 2), cluster: at(i + 3) });
  const clusters: LayoutCluster[] = [];
  for (let k = 0; k < nCluster; k++, i += CLUSTER) {
    clusters.push({ index: k, start: at(i), end: at(i + 1), line: at(i + 2), bounds: box(at(i + 3), at(i + 4), at(i + 5), at(i + 6)), flags: at(i + 7), word: at(i + 8) });
  }
  const words: LayoutWord[] = [];
  for (let k = 0; k < nWord; k++, i += WORD) {
    words.push({ index: k, start: at(i), end: at(i + 1), line: at(i + 2), bounds: box(at(i + 3), at(i + 4), at(i + 5), at(i + 6)), firstCluster: at(i + 7), clusterCount: at(i + 8) });
  }
  const decorations: LayoutDecoration[] = [];
  for (let k = 0; k < nDeco; k++, i += DECORATION) {
    decorations.push({ kind: at(i) === 0 ? 'underline' : 'strike', brush: at(i + 1), line: at(i + 2), bounds: box(at(i + 3), at(i + 4), at(i + 5), at(i + 6)) });
  }
  if (i !== v.length) throw new RangeError(`text layout: ${v.length - i} trailing values`);
  const runs: LayoutRun[] = runHeads.map(({ fixed: f, coords }, k) => {
    const first = at(f + 9);
    return {
      index: k,
      line: at(f),
      font: at(f + 1),
      size: at(f + 2),
      brush: at(f + 3),
      rtl: at(f + 4) === 1,
      start: at(f + 5),
      end: at(f + 6),
      embolden: at(f + 7) === 1,
      skew: at(f + 8),
      coords,
      glyphs: glyphs.slice(first, first + at(f + 10)),
    };
  });
  const bounds = lines.reduce<Box>((acc, l) => box(Math.min(acc.x0, l.bounds.x0), Math.min(acc.y0, l.bounds.y0), Math.max(acc.x1, l.bounds.x1), Math.max(acc.y1, l.bounds.y1)), box(Infinity, Infinity, -Infinity, -Infinity));
  return {
    width,
    height,
    bounds: lines.length === 0 ? box(0, 0, 0, 0) : bounds,
    paragraphs: () => paragraphs,
    lines: () => lines,
    runs: () => runs,
    clusters: () => clusters,
    words: () => words,
    decorations: () => decorations,
    clusterAt(offset) {
      // clusters are sorted by start: binary search
      let lo = 0;
      let hi = clusters.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = clusters[mid] as LayoutCluster;
        if (offset < c.start) hi = mid - 1;
        else if (offset >= c.end) lo = mid + 1;
        else return c;
      }
      return undefined;
    },
    clustersOf: (piece) => clusters.slice(piece.firstCluster, piece.firstCluster + piece.clusterCount),
  };
}
