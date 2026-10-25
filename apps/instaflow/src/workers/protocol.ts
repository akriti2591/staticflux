/**
 * Studio's worker protocol (B9, IF-33.1–33.3; D15). Data only, so both threads import it without module code.
 *
 *   main ──input ring (A5)──────────────▶ editor module ──scene records (first)──▶ render module ──▶ OffscreenCanvas
 *   main ◀─view, mirrors, a11y, labels,──┘               └──view-state frame (then)─┘
 *          text host, announcements
 *   main ──requests (open, tool, invoke, call, text, place, …)──▶ the worker hosting the module that owns them
 *
 * One worker or two is the boot setting (`SequencingSettings.topology`); `planSequencing` turns it into roles and
 * media, and main sends each request to the worker whose roles include the module (`StudioWorkers.editor` /
 * `.render`, the same client in one worker). Frames, records and input never travel on this protocol.
 */
import type { CapabilitySubject, InvocationOrigin } from '@staticflux/capabilities';
import type { NodeId } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { TextInputKind } from '@staticflux/surface/text-input';
import { defineProtocol, event, request, type WireError } from '@staticflux/worker';
import type { RegionEndpoint } from '@staticflux/worker/pipeline';
import type { CanvasSnapshot } from '../a11y/projection.js';
import type { CanvasPipeEndpoints } from '../app/canvas-pipeline.js';
import type { ExportTarget } from '../export/service.js';
import type { LibraryEntry } from '../library/library-doc.js';
import type { RenderPacing } from '../sequencing/pacing.js';
import type { RenderModuleStats } from '../sequencing/render-module.js';
import type { ModuleRole, SequencingMedia } from '../sequencing/topology.js';
import type { GuideLabel } from '../tools/snapping.js';
import type { Camera } from '../tools/view-state.js';
import type { MirrorCall, MirrorUpdate } from './mirror.js';
import type { TextHostCommand, TextHostEvent } from './text-port.js';

/** The document the editor opens (created first when `create` is given and the store has none). */
export interface StudioDocumentRef {
  readonly asset: string;
  readonly title: string;
  readonly create?: { readonly pages: number; readonly size?: { readonly width: number; readonly height: number } };
}

/** What the editor role needs at start. */
export interface StudioEditorStart {
  readonly document: StudioDocumentRef;
  /** The person (guest identity, D3). */
  readonly person: Actor;
  readonly isMac: boolean;
  /** The platform TextInput main binds (text editing is off without one). */
  readonly textInput?: TextInputKind;
  /** main → editor input ring endpoint (A5). */
  readonly input: RegionEndpoint;
  /** The store port: a `MessagePort` in the browser (an in-memory `Port` in tests). */
  readonly store: unknown;
}

/** Engine Wasm manifest and the bundled fonts (default face first): each worker loads what its modules need. */
export interface StudioAssets {
  readonly manifest: string;
  readonly fonts: readonly string[];
}

export interface StudioStartArgs {
  readonly roles: readonly ModuleRole[];
  readonly media: SequencingMedia;
  readonly pacing: RenderPacing;
  readonly assets?: StudioAssets;
  readonly editor?: StudioEditorStart;
  /** Keep a presented-frame log in the render module (frame metrics, A7; default on). */
  readonly record?: boolean;
}

/** What the editor role reports once the document is open. */
export interface StudioStarted {
  /** Capability ids the editor implements (main forwards exactly these). */
  readonly capabilities: readonly string[];
  readonly pages: readonly NodeId[];
}

/** The canvas for the render role (transferred `OffscreenCanvas`; a stand-in in tests). */
export interface CanvasHandoff {
  readonly canvas: unknown;
  /** CSS px. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** The tab's view as main reads it (scope follows the selection, zoom readout, HUD input, tests). */
export interface ViewProjection {
  readonly page: NodeId | undefined;
  readonly pages: readonly NodeId[];
  readonly tool: string;
  readonly selection: readonly NodeId[];
  readonly context: NodeId | undefined;
  readonly camera: Camera;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The text element being edited. */
  readonly editing: NodeId | undefined;
  /** B3's gesture state (`idle` when nothing is being dragged). */
  readonly gesture: string;
}

/** One element as tests and the smoke check read it (`inspect`). */
export interface InspectedElement {
  readonly id: NodeId;
  readonly kind: string;
  readonly parent: NodeId | undefined;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation: number;
  /** B10a. */
  readonly skewX: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly text?: string;
}

/** A read of the editor's state for tests, the smoke check and devtools. */
export interface StudioInspection {
  readonly view: ViewProjection;
  readonly elements: readonly InspectedElement[];
  /** Text elements of the page (B2 layer). */
  readonly textNodes: readonly NodeId[];
  /** The text being edited and its model text. */
  readonly editing?: { readonly node: NodeId; readonly text: string };
  /** B3's selection frame corners (page space), when there is one. */
  readonly frame?: readonly (readonly [number, number])[];
  /** B10a: the transform session's state and the pivot (frame fractions; undefined = the centre). */
  readonly transform?: { readonly mode: string; readonly pivot?: readonly [number, number] };
  readonly docVersion: number;
  readonly records: number;
  readonly undo: number;
}

/** Frame metrics (A7) and editor counters, for C4's budgets. */
export interface StudioMetrics {
  readonly render?: RenderModuleStats & {
    readonly presented: number;
    /** Input → presented estimate of the frames logged so far (ms): p50, p95. */
    readonly latency?: { readonly p50: number; readonly p95: number; readonly n: number };
  };
  readonly editor?: { readonly inputs: number; readonly batches: number; readonly records: number; readonly docVersion: number };
}

export const StudioWorkerProtocol = /* @__PURE__ */ defineProtocol({
  id: 'instaflow/studio-worker',
  version: 1,
  requests: {
    start: request<StudioStartArgs, StudioStarted | undefined>({ timeoutMs: 60_000 }),
    /** Render role in its own worker: the editor's pipe endpoints (relayed by main). */
    attach: request<CanvasPipeEndpoints, void>({ timeoutMs: 30_000 }),
    /** Render role: the canvas to draw on. */
    canvas: request<CanvasHandoff, void>({ timeoutMs: 60_000 }),
    /** Editor role: post the view and every mirror again (main subscribed after the editor started). */
    sync: request<void, void>(),
    /** Editor role: open a page in the tab. */
    open: request<{ readonly page: NodeId; readonly viewport: { readonly width: number; readonly height: number } }, void>({ timeoutMs: 30_000 }),
    /** Both roles: the surface changed size (editor: viewport; render: raster). */
    resize: request<ViewportSize, void>(),
    /** Render role: the page became visible again (present the last frame). */
    visible: request<{ readonly visible: boolean }, void>(),
    tool: request<{ readonly tool: string }, void>(),
    select: request<{ readonly nodes: readonly NodeId[] }, void>(),
    invoke: request<{ readonly capability: string; readonly input: unknown; readonly subject: CapabilitySubject; readonly origin?: InvocationOrigin; readonly invocationId: string }, unknown>({ timeoutMs: 60_000 }),
    call: request<MirrorCall, unknown>({ timeoutMs: 60_000 }),
    text: request<TextHostEvent, void>(),
    place: request<{ readonly entry: LibraryEntry }, void>({ timeoutMs: 60_000 }),
    hud: request<{ readonly action: string }, void>(),
    /** The zoom buttons (B3 `zoomStep`). */
    zoom: request<{ readonly step: 1 | -1 }, void>(),
    inspect: request<{ readonly nodes?: readonly NodeId[] }, StudioInspection>(),
    /** C1: freeze Latest for an export and report the pages and the selection (editor role). */
    exportTarget: request<void, ExportTarget>({ timeoutMs: 120_000 }),
    metrics: request<void, StudioMetrics>(),
    stop: request<void, void>({ timeoutMs: 10_000 }),
  },
  events: {
    /** The editor's pipe endpoints (editor role without the render role). */
    pipes: event<CanvasPipeEndpoints>(),
    view: event<ViewProjection>(),
    mirror: event<MirrorUpdate>(),
    a11y: event<CanvasSnapshot>(),
    labels: event<{ readonly labels: readonly GuideLabel[]; readonly camera: Camera }>(),
    text: event<TextHostCommand>(),
    announce: event<{ readonly message: string }>(),
    problem: event<{ readonly error: WireError }>(),
    /** A creation tool finished: hand the toolbar back to this tool. */
    tool: event<{ readonly tool: string }>(),
  },
});
