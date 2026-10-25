/**
 * Text → scene IR (B2; IF-7.6, IF-21.13–21.15): glyph runs and decorations of a laid-out text element as scene nodes,
 * and the **scene font table** that uploads each font file to the render scene once per content hash.
 *
 * The render module retains font bytes by hash (scene IR v2 `FONT`): the table sends bytes the first time a hash
 * appears in a stream and only an alias (no bytes) afterwards; after the render side is recreated (new stream or
 * device-independent reset) call `reset()` so the next batch carries the bytes again.
 */
import type { SceneNode, SceneTransform, SceneWriter } from '../render/scene-ir.js';
import type { TextLayout } from './layout-result.js';
import type { TextBrush } from './text-style.js';

/** sha-256 (`sha256:<64 hex>`) → 32 bytes. */
export function hashBytes(hash: string): Uint8Array {
  const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new RangeError(`not a sha-256 hash: ${hash}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface SceneFontTable {
  /** Scene font id for a content hash (stable for the table's lifetime). */
  idFor(hash: string): number;
  /** Write the FONT op for `hash` into `writer` if this stream has not seen it (bytes once, aliases after). */
  ensure(writer: SceneWriter, hash: string, bytes: () => Uint8Array | undefined): boolean;
  /**
   * A resnapshot (CLEAR + full scene) follows: re-announce every font in it, as aliases (the render scene keeps
   * bytes that the same batch references again).
   */
  resnapshot(): void;
  /** The render side was recreated (new engine or stream): resend bytes on next use. */
  reset(): void;
  /** Hashes sent in the current stream. */
  readonly sent: ReadonlySet<string>;
}

export function createSceneFontTable(): SceneFontTable {
  const ids = new Map<string, number>();
  const sent = new Set<string>();
  const announced = new Set<string>();
  return {
    sent,
    idFor(hash) {
      let id = ids.get(hash);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(hash, id);
      }
      return id;
    },
    ensure(writer, hash, bytes) {
      if (announced.has(hash)) return true;
      const id = this.idFor(hash);
      if (sent.has(hash)) {
        writer.font(id, hashBytes(hash), new Uint8Array());
      } else {
        const data = bytes();
        if (data === undefined) return false;
        writer.font(id, hashBytes(hash), data);
        sent.add(hash);
      }
      announced.add(hash);
      return true;
    },
    resnapshot() {
      announced.clear();
    },
    reset() {
      sent.clear();
      announced.clear();
    },
  };
}

export interface TextSceneOptions {
  /** Scene id of the text element's group. */
  readonly id: number;
  readonly parent?: number;
  /** The text box's transform (block px → parent space). */
  readonly transform?: SceneTransform;
  readonly brushes: readonly TextBrush[];
  /** Authoring font id → scene font id (undefined: font not uploaded; the run is skipped). */
  readonly fontId: (authoringFont: number) => number | undefined;
  /** Allocates scene ids for the element's children. */
  readonly nextId: () => number;
}

const FALLBACK_BRUSH: TextBrush = { color: [0, 0, 0, 255] };

/** The element's scene nodes: a group, one glyph leaf per run, one rect per underline/strike (paint order). */
export function textSceneNodes(layout: TextLayout, options: TextSceneOptions): SceneNode[] {
  const nodes: SceneNode[] = [{ id: options.id, ...(options.parent === undefined ? {} : { parent: options.parent }), ...(options.transform === undefined ? {} : { transform: options.transform }), geometry: { kind: 'group' } }];
  for (const run of layout.runs()) {
    const font = options.fontId(run.font);
    if (font === undefined || run.glyphs.length === 0) continue;
    const brush = options.brushes[run.brush] ?? FALLBACK_BRUSH;
    nodes.push({
      id: options.nextId(),
      parent: options.id,
      geometry: {
        kind: 'glyphs',
        font,
        size: run.size,
        glyphs: run.glyphs.map((g) => [g.id, g.x, g.y] as const),
        ...(run.embolden ? { embolden: true } : {}),
        ...(run.skew !== 0 ? { skew: run.skew } : {}),
        ...(run.coords.length > 0 ? { coords: run.coords } : {}),
      },
      fill: { kind: 'solid', color: brush.color },
    });
  }
  for (const d of layout.decorations()) {
    const brush = options.brushes[d.brush] ?? FALLBACK_BRUSH;
    nodes.push({
      id: options.nextId(),
      parent: options.id,
      transform: [1, 0, 0, 1, d.bounds.x0, d.bounds.y0],
      geometry: { kind: 'rect', w: Math.max(0, d.bounds.x1 - d.bounds.x0), h: Math.max(0.5, d.bounds.y1 - d.bounds.y0) },
      fill: { kind: 'solid', color: brush.color },
    });
  }
  return nodes;
}
