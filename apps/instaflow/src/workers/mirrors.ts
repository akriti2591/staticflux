/**
 * The mirrors Studio's panels read (B9, IF-33.14–33.16): each is a service of the editor module whose reads are plain
 * data. Main builds the panel models over them (`../app/panel-mirrors.ts`); the editor module serves them
 * (`editor-module.ts`). Data and types only: both threads import this file.
 */
import type { Result } from '@staticflux/core';
import type { JsonValue, NodeId } from '@staticflux/document/v2';
import type { LayerRow, PageSummary, SelectionSummary } from '../app/scene-summary.js';
import type { AppearanceEdit, AppearanceModel } from '../elements/inspector.js';
import type { CompositionStructure } from '../lenses/structure.js';
import type { RepeatEdit, RepeatModel } from '../repeat/inspector.js';
import type { ColorRef, FontRef, Script, TextAlign, TextBox, VerticalAlign } from '../text/model.js';
import type { TransformEdit, TransformModel } from '../tools/free-transform.js';
import type { ColorChoice, FontChoice, TextCase, TextPresetName, TypographySummary } from '../text/typography.js';
import type { CompareSide } from '../versioning/compare.js';
import type { SaveState } from '../versioning/latest.js';
import type { MilestoneEntry } from '../versioning/milestones.js';
import type { PanelBusy } from '../versioning/panel-model.js';
import type { MilestoneId } from '../versioning/records.js';
import { defineMirror } from './mirror.js';

/** B2's typography service (the Typography panel, the text HUD). */
export interface TypographyMirrorShape {
  readonly reads: { readonly summary: TypographySummary | undefined; readonly fonts: readonly FontChoice[]; readonly colors: readonly ColorChoice[] };
  readonly actions: {
    setFont(font: FontRef): Result<void>;
    setSize(size: number): Result<void>;
    setWeight(weight: number): Result<void>;
    toggle(key: 'bold' | 'italic' | 'underline' | 'strike'): Result<void>;
    setColor(color: ColorRef): Result<void>;
    setLetterSpacing(px: number): Result<void>;
    setLink(href: string | null): Result<void>;
    setAlign(align: TextAlign): Result<void>;
    setLineHeight(multiple: number): Result<void>;
    fitToBox(): Result<void>;
    setScript(script: Script | null): Result<void>;
    setParagraph(patch: { readonly spaceBefore?: number; readonly spaceAfter?: number; readonly indent?: number }): Result<void>;
    setBox(box: TextBox): Result<void>;
    setVerticalAlign(align: VerticalAlign): Result<void>;
    convertCase(kind: TextCase): Result<void>;
    clearFormatting(): Result<void>;
    applyPreset(name: TextPresetName): Result<void>;
  };
}
export const TypographyMirror = /* @__PURE__ */ defineMirror<TypographyMirrorShape>('instaflow/mirror/typography', { summary: undefined, fonts: [], colors: [] });

/** B1's Fill / stroke / effects inspector model of the single selected element. */
export interface AppearanceMirrorShape {
  readonly reads: { readonly model: AppearanceModel | undefined };
  readonly actions: { apply(edit: AppearanceEdit): Result<void> };
}
export const AppearanceMirror = /* @__PURE__ */ defineMirror<AppearanceMirrorShape>('instaflow/mirror/appearance', { model: undefined });

/** B7's Repeat inspector model of the single selected element. */
export interface RepeatMirrorShape {
  readonly reads: { readonly model: RepeatModel | undefined };
  readonly actions: { apply(edit: RepeatEdit): Result<void> };
}
export const RepeatMirror = /* @__PURE__ */ defineMirror<RepeatMirrorShape>('instaflow/mirror/repeat', { model: undefined });

/** B10a's numeric transform bar: the selection's X, Y, W, H, angle and skew, and whether a transform session is active. */
export interface TransformBarModel extends TransformModel {
  readonly transforming: boolean;
}
export interface TransformMirrorShape {
  readonly reads: { readonly model: TransformBarModel | undefined };
  readonly actions: {
    /** One edit (one undo step, or one step of the active session). */
    apply(edit: TransformEdit): Result<void>;
    /** Apply the active session (Enter). */
    commit(): Result<void>;
    /** Cancel the active session (Escape). */
    cancel(): Result<void>;
  };
}
export const TransformMirror = /* @__PURE__ */ defineMirror<TransformMirrorShape>('instaflow/mirror/transform', { model: undefined });

/** B5's Milestones panel model (results of open / compare / new document stay with the host: plain outcomes). */
export interface MilestonesMirrorShape {
  readonly reads: { readonly milestones: readonly MilestoneEntry[]; readonly busy: PanelBusy };
  readonly actions: {
    refresh(): Promise<Result<readonly MilestoneEntry[]>>;
    create(name: string, note?: string): Promise<Result<MilestoneEntry>>;
    pin(id: MilestoneId, pinned: boolean): Promise<Result<void>>;
    rename(id: MilestoneId, name: string): Promise<Result<void>>;
    open(id: MilestoneId): Promise<Result<void>>;
    compare(left: CompareSide, right: CompareSide): Promise<Result<void>>;
    newDocument(id: MilestoneId): Promise<Result<void>>;
  };
}
export const MilestonesMirror = /* @__PURE__ */ defineMirror<MilestonesMirrorShape>('instaflow/mirror/milestones', { milestones: [], busy: 'idle' });

/** B5's Latest save state (the top bar). */
export interface LatestMirrorShape {
  readonly reads: { readonly state: SaveState };
  readonly actions: { flush(): Promise<Result<void>> };
}
export const LatestMirror = /* @__PURE__ */ defineMirror<LatestMirrorShape>('instaflow/mirror/latest', { state: { status: 'saved', stalled: false, since: 0 } });

/**
 * B11b: the open page as the chrome reads it — the layers tree (Layers, names), the page, the selection summary (the
 * HUD pill's and inspector's control set by selection kind) and the selection frame on the page (pill placement).
 * Actions are the multi-element edits the pill and Layers make without a capability of their own: the top fill or
 * stroke paint of every selected element, one property on every one (radius, sides, fit, clip), moving a row in Layers.
 */
export interface SceneMirrorShape {
  readonly reads: {
    readonly page: PageSummary | undefined;
    readonly layers: readonly LayerRow[];
    readonly selection: SelectionSummary;
    /** Page-space axis-aligned bounds of the selection frame (undefined: nothing selected). */
    readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined;
    /** Colours used on the page, most used first (≤ 12). */
    readonly colors: readonly { readonly hex: string; readonly uses: number }[];
    /** B12 A-1: the open page's Background as a fill stack (the inspector's Page section). */
    readonly pageFill: AppearanceModel | undefined;
    /** How many pages the design has (the Document section). */
    readonly pages: number;
    /** B11c: the label of the person's next undo step (Pro's top bar `Undo: Resize headline`); undefined: nothing to undo. */
    readonly undo: string | undefined;
  };
  readonly actions: {
    setPaint(stack: 'fills' | 'strokes', paint: JsonValue, label: string): Result<void>;
    setProp(path: string, value: JsonValue, label: string): Result<void>;
    /** Layers drag: move `nodes` into `parent` before `before` (null: on top). One step `Reorder`. */
    move(nodes: readonly NodeId[], parent: NodeId, before: NodeId | null): Result<void>;
    /** The page's Background stack (one step `Page background`). */
    applyPage(edit: AppearanceEdit): Result<void>;
    /** The page's size in design px (one step `Page size`). */
    resizePage(width: number, height: number): Result<void>;
    /** The top image fill's fit on every selected element (one step `Fit`). */
    setImageFit(fit: string): Result<void>;
    renamePage(name: string): Result<void>;
  };
}
export const SceneMirror = /* @__PURE__ */ defineMirror<SceneMirrorShape>('instaflow/mirror/scene', { page: undefined, layers: [], selection: { kind: 'none', nodes: [], label: '', typeLabel: '', locked: false, anyLocked: false, hidden: false, actions: [] }, frame: undefined, colors: [], pageFill: undefined, pages: 1, undo: undefined });

/** B4's composition structure (the Pages panel's lens controller reads it on main) and story edits. */
export interface StoryMirrorShape {
  readonly reads: { readonly structure: Result<CompositionStructure> | undefined };
  readonly actions: {
    movePage(page: NodeId, to: number): Result<void>;
    /** B11b: a new page after `after` (the end when null), sized like it; resolves to its id. One undo step. */
    addPage(after: NodeId | null): Result<NodeId>;
    /** B11b: a copy of `page` with its elements, right after it; resolves to its id. One undo step. */
    duplicatePage(page: NodeId): Result<NodeId>;
    /** B11b: `page` leaves the story (never the last one, IF-POL-052); undo brings it back. */
    deletePage(page: NodeId): Result<void>;
    /** B11b: rename any page (IF-POL-053 when empty). */
    renameStoryPage(page: NodeId, name: string): Result<void>;
  };
}
export const StoryMirror = /* @__PURE__ */ defineMirror<StoryMirrorShape>('instaflow/mirror/story', { structure: undefined });
