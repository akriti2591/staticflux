/**
 * Studio's panel models on main over the editor module's mirrors (B9, IF-33.14–33.16). Each returns the interface the
 * panel already consumes (B1, B2, B4, B5, B7), so the panel elements do not change: reads come from the latest post
 * (reactive), actions are forwarded. Panel actions that answer synchronously (`Result` returns) answer `ok`
 * optimistically and report a failure through `onProblem` (announced politely); async actions return the worker's
 * result.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { AppearanceEdit, AppearanceModel } from '../elements/inspector.js';
import type { StructureFeed } from '../lenses/structure.js';
import type { StoryWriter } from '../lenses/story.js';
import type { RepeatEdit, RepeatModel } from '../repeat/inspector.js';
import type { TypographyService } from '../text/typography.js';
import type { TransformBarSource } from '../tools/transform-bar.js';
import type { LatestService } from '../versioning/latest.js';
import type { MilestonesPanelPort } from '../versioning/panel-model.js';
import { type MirrorView, reportFailure } from '../workers/mirror.js';
import type { AppearanceMirrorShape, LatestMirrorShape, MilestonesMirrorShape, RepeatMirrorShape, StoryMirrorShape, TransformMirrorShape, TypographyMirrorShape } from '../workers/mirrors.js';
import { DocumentOpenError } from './errors.js';

type Problem = (error: SfError) => void;

/** B1's paint inspector source (`bindPaintInspector`). */
export function appearanceSource(view: MirrorView<AppearanceMirrorShape>, onProblem: Problem): { model(): AppearanceModel | undefined; subscribe(listener: () => void): () => void; apply(edit: AppearanceEdit): void } {
  return {
    model: () => view.read('model'),
    subscribe: (listener) => view.onChange(listener),
    apply: (edit) => reportFailure(view.call('apply', edit), onProblem),
  };
}

/** B7's repeat inspector source (`bindRepeatInspector`). */
export function repeatSource(view: MirrorView<RepeatMirrorShape>, onProblem: Problem): { model(): RepeatModel | undefined; subscribe(listener: () => void): () => void; apply(edit: RepeatEdit): void } {
  return {
    model: () => view.read('model'),
    subscribe: (listener) => view.onChange(listener),
    apply: (edit) => reportFailure(view.call('apply', edit), onProblem),
  };
}

/** B10a's numeric transform bar source (`bindTransformBar`). */
export function transformSource(view: MirrorView<TransformMirrorShape>, onProblem: Problem): TransformBarSource {
  return {
    model: () => view.read('model'),
    subscribe: (listener) => view.onChange(listener),
    apply: (edit) => reportFailure(view.call('apply', edit), onProblem),
    session: (action) => reportFailure(view.call(action), onProblem),
  };
}

/** B2's typography service (the Typography panel). */
export function typographyFromMirror(view: MirrorView<TypographyMirrorShape>, onProblem: Problem): TypographyService {
  const send = (run: Promise<Result<unknown>>): Result<void> => {
    reportFailure(run, onProblem);
    return ok();
  };
  return {
    summary: () => view.read('summary'),
    fontChoices: () => view.read('fonts'),
    colorChoices: () => view.read('colors'),
    onChange: (listener) => view.onChange(listener),
    setFont: (font) => send(view.call('setFont', font)),
    setSize: (size) => send(view.call('setSize', size)),
    setWeight: (weight) => send(view.call('setWeight', weight)),
    toggle: (key) => send(view.call('toggle', key)),
    setColor: (color) => send(view.call('setColor', color)),
    setLetterSpacing: (px) => send(view.call('setLetterSpacing', px)),
    setLink: (href) => send(view.call('setLink', href)),
    setAlign: (align) => send(view.call('setAlign', align)),
    setLineHeight: (multiple) => send(view.call('setLineHeight', multiple)),
    fitToBox: () => send(view.call('fitToBox')),
  };
}

/** B5's Milestones panel model. */
export function milestonesFromMirror(view: MirrorView<MilestonesMirrorShape>): MilestonesPanelPort {
  return {
    milestones: () => view.read('milestones'),
    busy: () => view.read('busy'),
    refresh: () => view.call('refresh'),
    create: (name, note) => (note === undefined ? view.call('create', name) : view.call('create', name, note)),
    pin: (id, pinned) => view.call('pin', id, pinned),
    rename: (id, name) => view.call('rename', id, name),
    open: (id) => view.call('open', id),
    compare: (left, right) => view.call('compare', left, right),
    newDocument: (id) => view.call('newDocument', id),
  };
}

/** B5's Latest save state (the top bar). */
export function latestFromMirror(view: MirrorView<LatestMirrorShape>): LatestService {
  return {
    state: () => view.read('state'),
    onChange: (listener) => view.onChange(() => listener(view.read('state'))),
    flush: () => view.call('flush'),
    dispose: () => undefined,
  };
}

/** B4's structure feed for the lens controller on main (before the first post: not open yet). */
export function structureFromMirror(view: MirrorView<StoryMirrorShape>): StructureFeed {
  return {
    read: () => view.read('structure') ?? err(DocumentOpenError({ message: 'The document is still opening.', details: { step: 'structure' } })),
    observe: (listener) => view.onChange(listener),
  };
}

/** B4's story writer (the Pages panel's reorder). */
export function storyFromMirror(view: MirrorView<StoryMirrorShape>, onProblem: Problem): StoryWriter {
  return {
    movePage(page, to) {
      reportFailure(view.call('movePage', page, to), onProblem);
      return ok();
    },
  };
}
