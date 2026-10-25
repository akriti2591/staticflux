/**
 * The mirrors Studio's panels read (B9, IF-33.14–33.16): each is a service of the editor module whose reads are plain
 * data. Main builds the panel models over them (`../app/panel-mirrors.ts`); the editor module serves them
 * (`editor-module.ts`). Data and types only: both threads import this file.
 */
import type { Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { AppearanceEdit, AppearanceModel } from '../elements/inspector.js';
import type { CompositionStructure } from '../lenses/structure.js';
import type { RepeatEdit, RepeatModel } from '../repeat/inspector.js';
import type { ColorRef, FontRef, TextAlign } from '../text/model.js';
import type { TransformEdit, TransformModel } from '../tools/free-transform.js';
import type { ColorChoice, FontChoice, TypographySummary } from '../text/typography.js';
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

/** B4's composition structure (the Pages panel's lens controller reads it on main) and story edits. */
export interface StoryMirrorShape {
  readonly reads: { readonly structure: Result<CompositionStructure> | undefined };
  readonly actions: { movePage(page: NodeId, to: number): Result<void> };
}
export const StoryMirror = /* @__PURE__ */ defineMirror<StoryMirrorShape>('instaflow/mirror/story', { structure: undefined });
