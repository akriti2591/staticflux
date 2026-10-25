# Instaflow — Document format

> Status: **draft for owner review** (2026-10-24). Normative for IF-3, IF-4, IF-5, IF-6. Types are TypeScript
> shapes that fix structure, not final API names. §7 folds in [research 05](research/05-agent-representation.md).
> §11 (comments) and §12 (extensions) are design direction. [DECISIONS.md](DECISIONS.md) is authoritative.

## 1. Principles

1. **A workspace object store, not a "design file".** Immutable content-addressed blobs and records, a few small
   mutable heads, and a derived index. The layout is identical in OPFS, in a user folder and in a cloud bucket.
2. **Everything is an asset.** Blob assets are immutable bytes. Tree assets have a node tree with Latest state
   and Milestones.
3. **The live engine format is internal.** Latest is stored as CRDT (Loro) snapshots plus a log. Everything that
   leaves the live editor (milestones, `.iflow`, change sets, the agent-facing representation) is **canonical and
   engine-independent**, so the CRDT engine can be swapped without a format change.
4. **Costs scale with size, never with age.** No diff chains, bounded undo history, and milestones that share
   unchanged parts by hash.
5. **Co-editing by construction.** Latest is a CRDT edited by many peers (tabs, agents, later remote users).
   Every write is a commutative transaction with an actor.
6. **No physical locations in content.** Content holds asset ids and digests. A resolver maps them to bytes.

## 2. Identity and addressing

```ts
export type Digest = `sha256:${string}`;                // reserved: `b3:` (BLAKE3) without a format change
export type WorkspaceId = `ws_${string}`;                // uuidv7
export type AssetId = `as_${string}`;                    // uuidv7, stable forever
export type MilestoneId = `ms_${string}`;                // sha256 of the canonical milestone record
export type ExportId = `ex_${string}`;                   // sha256 of the canonical export record
export type ChangeSetId = `cs_${string}`;                // uuidv7
export type NodeId = string;                             // asset-local, `<peer36>-<n36>` (createIdGenerator); stable
export type PartId = 'root' | `page:${NodeId}` | `flow:${NodeId}` | 'comments';   // 'comments': never in milestones or exports
export type PeerId = string;                             // one per CRDT peer: tab editor worker, store worker, agent session
export type Ticks = number;                              // integer; 705_600_000 per second ("flicks"); exact to ~147 days
export type Rational = readonly [num: number, den: number];
export type CapabilityId = `${string}/${string}`;        // a typed StaticFlux capability id

export interface BlobRef {
  readonly digest: Digest;                               // of the decoded content (a chunk manifest's digest for chunked blobs)
  readonly size: number;                                 // decoded bytes
  readonly mime: string;
  readonly chunked?: true;                               // > 8 MiB: digest names a ChunkManifest
  readonly encoding?: 'deflate-raw';                     // storage encoding only (Compression Streams)
}
export interface ChunkManifest {
  readonly schema: 'instaflow.chunks/1'; readonly size: number; readonly mime: string;
  readonly chunkSize: 4_194_304; readonly chunks: readonly Digest[];
}

/** A reference from content to another asset. Blob assets are immutable, so `at` applies to tree assets only. */
export type AssetRef =
  | { readonly asset: AssetId }                                         // blob asset
  | { readonly asset: AssetId; readonly at: 'latest' }                  // tree asset, following
  | { readonly asset: AssetId; readonly at: MilestoneId };              // tree asset, pinned

export type Actor =
  | { readonly kind: 'human'; readonly id: string; readonly displayName: string }        // V1: stableGuestId
  | { readonly kind: 'agent'; readonly id: string; readonly displayName: string;
      readonly model?: string; readonly onBehalfOf: string; readonly session: string }
  | { readonly kind: 'flow'; readonly id: AssetId; readonly run: string; readonly onBehalfOf: string }
  | { readonly kind: 'system'; readonly service: string };
export type Via = 'hud' | 'bar' | 'chat' | 'webmcp' | 'flow' | 'shortcut' | 'direct';
```

Logical URI, used in logs, provenance and devtools: `iflow://ws_…/as_…[@ms_…]#nodeId`.

## 3. The node tree

### 3.1 Shape

A tree asset's content is one rooted tree. Each node has an id, a `kind`, a parent, a fractional `order` among
its siblings, and typed **components**. A property path is `component.field[.subfield]`, for example
`spatial.x`, `style.fill.color` or `source.in`. Paths come from the component definitions (SF-Δ6), which also
generate the JSON Schema used to validate change sets.

```ts
export interface NodeBase<K extends NodeKind> {
  readonly id: NodeId;
  readonly kind: K;
  readonly name?: string;
  readonly role?: Role;                                  // semantic: headline | subhead | body | cta | logo | hero | price |
                                                         // legal | caption | reaction | background | … (closed, extensible enum)
  readonly parent: NodeId | null;                        // null only for the root
  readonly order: string;                                // fractional key (keyBetween); ignored inside tracks
}

export type NodeKind =
  | 'composition'                                        // root of a composition/template/brand kit/motion preset
  | 'page' | 'group' | 'track'                           // containers
  | 'text' | 'shape' | 'vector' | 'image' | 'video' | 'audio' | 'instance' | 'slot'   // elements
  | 'transition'                                         // relationship node (binds two siblings)
  | 'flow' | 'step' | 'edge';                            // graphs
```

**Where nodes live (lenses are views over this one structure):**

| Parent | Allowed children | Lens meaning |
|---|---|---|
| `composition` (root) | `page`*, loose elements, `track` (`trackKind: 'audio'`, story-level soundtrack and voice-over), `transition` (between pages), `flow` | Pages lens: pages in `order` (the **story**). Canvas lens: pages at `page.canvas` plus loose elements. Timeline lens: the story in time plus story-level audio. Flow lens: flows. |
| `page` | elements, `group`, `track`, `transition` (between clips of one track is a child of that track) | A fixed-size frame. With `temporal.duration` it is a slide, scene or clip of the story. |
| `group` | elements, `group` | Free layout container. |
| `track` | elements placed by `temporal.start`, `transition` | A lane in page time (video, overlay, text, audio). |
| `flow` | `step`, `edge` | A workflow graph. |

Story time: a page's start is the sum of the preceding page durations, minus the overlap of any page transition
between them. Elements directly on a page default to the page's full duration. Modes nest through `instance`: a
page can hold an instance of another composition, which carries its own time.

### 3.2 Components

```ts
export interface Composition {                           // on the root
  format: { width: number; height: number; fps: Rational; sampleRate: 48_000 | 44_100; background: Paint };
  primaryLens: 'pages' | 'canvas' | 'timeline' | 'flow';
  variantSets: Record<string, readonly string[]>;        // e.g. { format: ['post','story','a4'], theme: ['light','dark'] }
  brandKit?: AssetRef;                                   // usually following
}
export interface Page { size?: { width: number; height: number }; canvas: { x: number; y: number };
                        background?: Paint; notes?: string; advance: 'auto' | 'click' }
export interface Track { trackKind: 'video' | 'overlay' | 'text' | 'audio'; muted: boolean; locked: boolean; volume: number }
export interface Spatial { x: number; y: number; w: number; h: number; rotation: number; scaleX: number; scaleY: number;
                           anchorX: number; anchorY: number; opacity: number; blend: BlendMode; flipX: boolean; flipY: boolean }
export interface Temporal { start: Ticks; duration: Ticks }               // placement in the parent's time
export interface Source { asset: AssetRef; in: Ticks; out: Ticks; speed: number; reverse: boolean; loop: boolean;
                          freezeAt?: Ticks; crop?: Rect }
export interface AudioMix { volume: number; pan: number; fadeIn: Ticks; fadeOut: Ticks; muted: boolean; preservePitch: boolean }
export interface Style { fill?: Paint; stroke?: Paint & { width: number; align: 'inside' | 'center' | 'outside' };
                         radius?: number; effects?: readonly Effect[]; inherit?: BrandClassRef }
export interface Text { content: RichText; box: 'auto-width' | 'auto-height' | 'fixed';
                        align: 'start' | 'center' | 'end' | 'justify'; verticalAlign: 'top' | 'middle' | 'bottom' }
export interface Geometry { shape: 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'path'; path?: string /* SVG path data */;
                            boolean?: { op: 'union' | 'subtract' | 'intersect' | 'exclude'; operands: readonly NodeId[] } }
export interface Matte { asset: AssetRef /* kind 'matte' */; invert: boolean; feather: number; choke: number;
                         mask: 'none' | 'circle' | 'rounded-rect'; outline?: Paint & { width: number }; shadow?: Effect }
export interface Motion { in?: PresetUse; emphasis?: PresetUse; out?: PresetUse; loop?: PresetUse;
                          text?: { unit: 'char' | 'word' | 'line'; stagger: Ticks }; matchKey?: string /* Smart move */ }
export interface Animation { channels: Record<PropertyPath, Channel> }    // stored as separate CRDT entities per channel
export interface Channel { keys: Record<KeyId, Keyframe> }               // keyed map: concurrent key edits merge
export interface Keyframe { t: Ticks /* relative to the node's start */; value: AnimValue;
                            interp: 'hold' | 'linear' | 'bezier' | 'spring'; ease?: readonly [number, number, number, number];
                            spring?: { stiffness: number; damping: number; mass: number } }
export interface Transition { from: NodeId; to: NodeId; preset: AssetRef /* motion-preset */; duration: Ticks;
                              alignment: 'start' | 'center' | 'end'; params?: Record<string, JsonValue> }
export interface Instance { ref: AssetRef; overrides: Record<NodeId /* source node */, Partial<Record<PropertyPath, JsonValue>>> }
export interface SlotSpec { name: string; accepts: readonly AssetKind[]; required: boolean;
                            constraints?: { maxChars?: number; aspect?: Rational; minPx?: number } }
export interface Lock { scope: 'position' | 'content' | 'all'; policy?: { by: AssetRef; reason: string } }  // policy: humans only
export interface Variants { opinions: Record<`${string}=${string}`, Partial<Record<PropertyPath, JsonValue>>> }  // 'format=story'
export interface Step { capability: CapabilityId; capabilityVersion: number; inputs: Record<string, Binding>;
                        params: Record<string, JsonValue>; exposed: readonly string[]; seed?: number }
export interface Edge { from: { node: NodeId; port: string }; to: { node: NodeId; port: string } }
export interface Recipe { capability: CapabilityId; capabilityVersion: number; model?: string; prompt?: AssetRef;
                          inputs: Record<string, JsonValue>; seed?: number; sourceRange?: { asset: AssetRef; in: Ticks; out: Ticks } }

export interface RichText { text: string;                                 // ranges are UTF-16 offsets on grapheme boundaries
                            spans: readonly { start: number; end: number; style: Partial<TextStyle> & { inherit?: BrandClassRef } }[];
                            paragraphs: readonly { start: number; align?: Text['align']; list?: 'bullet' | 'number' }[] }
export interface TextStyle { font: AssetRef; size: number; weight: number; italic: boolean; lineHeight: number;
                             letterSpacing: number; color: Paint; decoration: 'none' | 'underline' | 'strike' }
export type Paint = { color: TokenOr<string /* CSS Color 4 */> } | { gradient: Gradient } | { image: AssetRef; fit: 'cover' | 'contain' | 'tile' };
export type TokenOr<T> = T | { token: `${string}.${string}`; kit?: AssetRef };   // brand token, e.g. 'color.primary'
export type BrandClassRef = { kit: AssetRef; class: string };                    // e.g. heading, body, cta
export type Binding = { type: 'edge' } | { type: 'asset'; ref: AssetRef } | { type: 'value'; value: JsonValue };
export interface PresetUse { preset: AssetRef; duration: Ticks; params?: Record<string, JsonValue> }
// Effect, Gradient, Rect, BlendMode, AnimValue, KeyId, PropertyPath, JsonValue: defined alongside the component registry.
```

Which components each kind carries is fixed by a per-kind table generated from the component registry (for
example `video` = `spatial + temporal + source + audioMix + style + matte? + motion? + animation?`).

**As built (M1b B1, IF-20):** `style` is version 2 with appearance **stacks** (`fills`, `strokes`, `effects`: ordered,
toggleable lists; paints add conic gradients), per-corner `radiusTL/TR/BR/BL`, `radiusInner` and `smoothing`; element kinds
add `frame`; masks are a `mask` component (`mode: clip | alpha | luminance`, `invert`, optional matte `asset`) on the mask
element; a boolean is `geometry.boolean` on a group whose children are the operands; the match key is `lineage.key`;
layout grids are `layout.grids`. `apps/instaflow/src/elements/components.ts` is normative for field names.

### 3.3 Composition rules (SF-Δ7 `@staticflux/stage`)

- **Layer stack**, strongest first: `session` (ephemeral previews, solo/mute, active variant selection; never
  persisted), `proposal/*` (§7.5), `local` (the asset's own content).
- **Arcs:** `reference` (`instance`, media `source.asset`, paint images), `inherit` (`style.inherit`, tokens) and
  `variant` (`Variants.opinions` selected by the session's variant selection or an export preset). Strength:
  local > variant > inherit > reference.
- **Policy locks** (`Lock.policy`) and brand-kit `final` tokens are kept regardless of strength. Opinions on those
  paths from other layers are ignored and flagged.
- `explain(node, path) → { value, winner: { layer, arc, source }, overridden: [...] }` is available to devtools,
  the inspector and agents.

## 4. Assets

```ts
export type AssetKind =
  | 'image' | 'video' | 'audio' | 'font' | 'vector' | 'lottie' | 'matte' | 'transcript'        // blob assets
  | 'composition' | 'template' | 'brand-kit' | 'motion-preset' | 'workflow' | 'prompt';        // tree assets

export interface AssetRecord {                          // records/as/…, immutable, written once
  readonly schema: 'instaflow.asset/1';
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly createdAt: string;                           // ISO-8601
  readonly createdBy: Actor;
  readonly content?: BlobRef;                           // blob assets only
  readonly media?: { width?: number; height?: number; duration?: Ticks; rate?: Rational; channels?: number;
                     sampleRate?: number; colorSpace?: string; alpha?: boolean; keyframeIndex?: BlobRef };
  readonly renditions?: readonly { role: 'thumbnail' | 'poster' | 'proxy' | 'waveform' | 'filmstrip'; blob: BlobRef;
                                   params?: Record<string, JsonValue> }[];   // regenerable; new renditions → library doc
  readonly provenance: Provenance;
  readonly rights?: { license: string; source?: string; attribution?: string; embeddable?: boolean /* fonts */ };
  readonly createdFrom?: { asset: AssetId; milestone: MilestoneId; title: string };     // label only: never resolved
}

export interface Provenance {                           // C2PA-aligned vocabulary
  readonly action: 'imported' | 'captured' | 'created' | 'edited' | 'generated' | 'derived';
  readonly actor: Actor;
  readonly ingredients: readonly { ref: AssetRef; relationship: 'parentOf' | 'componentOf' | 'inputTo' }[];
  readonly operation?: { capability: CapabilityId; capabilityVersion: number; input: JsonValue; invocation: string };
  readonly generator?: { provider: string; model: string; modelVersion?: string; params: Record<string, JsonValue>;
                         seed?: number; job: string };
}
```

- **Library document.** One CRDT doc per workspace (`heads/library.json`) holds mutable metadata: title, tags,
  folders, favorites, trash state and time, late-arriving renditions, and the per-asset list of live tree assets.
  It is the GC root list.
- **Generated and derived assets** are blob assets with `generator` and/or `operation`. Mattes and transcripts are
  derived blob assets (expensive to regenerate), and proxies and waveforms are renditions (cheap).
- **Prompts** are tree assets (rich text plus parameters), so they are versioned, reusable and redactable.
- **Motion presets** carry a human-readable `slug` (`fade-up`, `smart-move`, `word-by-word`), unique per workspace,
  which agent views use instead of asset ids.

## 5. Workspace store

### 5.1 Layout (identical in OPFS, a user folder and, later, a bucket prefix)

```
instaflow/ws_01JB…/
├── WORKSPACE.json                 { format: "instaflow.ws/1", id, minReader: 1, createdAt, features: [] }
├── heads/                         the ONLY mutable files; replaced atomically (CAS on `generation`)
│   ├── library.json               head of the library doc
│   └── as_01JC….json              TreeHead per tree asset
├── records/                       immutable JSON, canonical (RFC 8785), named by id
│   ├── as/01/as_01JC….json        AssetRecord
│   ├── ms/9c/ms_9c41….json        Milestone
│   └── ex/77/ex_77aa….json        ExportRecord
├── log/as_01JC…/                  Latest op log: append-only segments, deleted after compaction
│   └── 000121-<peer>.bin          commit records coalesced per gesture / ~1 s
└── blobs/sha256/1c/1c9e…          originals, renditions, chunks, chunk manifests,
                                   Latest part snapshots (CRDT bytes), milestone parts (canonical JSON)
```

Derived (rebuildable, never authoritative): an IndexedDB catalog per workspace through `@staticflux/storage`
(asset list, where-used references, search text, thumbnails map, GC marks), stamped with the workspace id and
the heads' generations, and rebuilt on mismatch.

### 5.2 Latest (internal; engine-specific)

```ts
export interface TreeHead {
  readonly schema: 'instaflow.head/1';
  readonly asset: AssetId;
  readonly generation: number;                           // CAS counter; IF-STORE-003 on conflict → reload head and retry
  readonly engine: 'loro/1';                             // internal; only the store and editor workers read it
  readonly treeSchema: number;                           // component-registry version (§8)
  readonly minReader: number; readonly minWriter: number;
  readonly parts: Readonly<Record<PartId, BlobRef>>;     // one CRDT snapshot per part (root, each page, each flow)
  readonly logFrom: number;                              // first live log segment
  readonly undoHorizon: { steps: 200 };
  readonly milestones: readonly MilestoneId[];           // newest first; GC roots
  readonly pinned: readonly MilestoneId[];
  readonly readOnly?: true;
}
export interface CommitRecord {                          // inside a log segment
  readonly seq: number; readonly peer: PeerId; readonly actor: Actor; readonly via: Via;
  readonly invocation?: string; readonly changeSet?: ChangeSetId; readonly label: string;
  readonly updates: Readonly<Record<PartId, Uint8Array>>; // a cross-part move is atomic: one record, several parts
}
```

- **Partitioning:** each page and each flow is its own CRDT doc (a part), loaded lazily when visible or scheduled
  for render. The root part holds the root, the story order, loose canvas elements, story audio and page
  transitions. A node moving between pages is one commit record that touches two parts. The `comments` part
  (§11) is a separate CRDT doc in the same head and log, excluded from milestones and exports.
- **Compaction** (store worker, on close or every 2 MB of log): write new part snapshots, swap the head, and delete
  older segments. History older than the undo horizon is trimmed. Old snapshots are unreferenced and collected.

### 5.3 Cloud mapping (later; no format change)

| Local | Cloud |
|---|---|
| `blobs/sha256/…` | Object storage under the same keys; `Cache-Control: immutable` |
| `records/…` | Object storage plus `assets`, `milestones` and `exports` rows |
| `log/…` | `commits(asset, seq, peer, bytes)` rows, or a per-asset room (Durable-Object-style) |
| `heads/…` | `heads` rows updated with compare-and-swap |
| IndexedDB catalog | Postgres tables with the same fields; the local copy becomes a partial cache |
| ACLs, sharing, jobs, quotas | Server tables only, never in the store |

## 6. Versioning

### 6.1 Milestones

```ts
export interface Milestone {                             // records/ms/…, immutable
  readonly schema: 'instaflow.milestone/1';
  readonly id: MilestoneId;                              // sha256 of this record's canonical JSON
  readonly asset: AssetId;
  readonly kind: 'named';                                // 'auto' reserved for a later release (IF-5.6)
  readonly name: string; readonly note?: string;
  readonly createdAt: string; readonly createdBy: Actor;
  readonly parent?: MilestoneId;                         // previous milestone of THE SAME asset; informational
  readonly treeSchema: number;
  readonly parts: Readonly<Record<Exclude<PartId, 'comments'>, BlobRef>>;  // canonical parts (§6.2); unchanged parts share digests
  readonly references: readonly { ref: AssetRef; where: number /* use count */ }[];   // where-used, GC
  readonly cover?: BlobRef;                              // thumbnail
}
```

- **Create** (store worker): read each part's composed-free *local* state from the CRDT, encode it canonically,
  hash it, and write only the digests not already present. Cost is O(document size), and storage grows only by
  changed parts.
- **Open:** read-only, from parts. No CRDT is involved.
- **Delete:** allowed for unpinned milestones that no export record names. Pinning is a head field, so pinning
  does not rewrite the immutable record.
- **Rename** (M1 B5): also a head field (`names: { [MilestoneId]: string }`, next to `milestones` and `pinned`); the record
  keeps the name it was created with, so its id never changes.
- **New document from milestone:** create a new `AssetRecord` (`createdFrom` label only) and new Latest CRDT
  parts built from the canonical parts with a fresh history and fresh peer ids. Node ids are kept (they are
  asset-local). No structural link to the source exists afterwards: deleting the source never affects the copy.

### 6.2 Canonical part encoding (`instaflow.part/1`)

```ts
export interface CanonicalPart {
  readonly schema: 'instaflow.part/1';
  readonly part: PartId;
  readonly treeSchema: number;
  readonly nodes: readonly {                             // sorted by id
    id: NodeId; kind: NodeKind; name?: string; parent: NodeId | null; order: string;
    props: Record<ComponentId, JsonValue>;               // local opinions only, defaults omitted, keys sorted
  }[];
}
```

The encoding is JSON canonicalized per RFC 8785. Rich text is stored as spans, animation channels with keys
sorted, and numbers as shortest round-trip. CRDT metadata, presence and proposals are excluded. The digest is
taken over the canonical bytes, and storage uses `encoding: 'deflate-raw'`.

### 6.3 References

- **Pinned** (`at: MilestoneId`): resolves to that milestone's parts. It is reproducible.
- **Following** (`at: 'latest'`): resolves to the referenced asset's current Latest (brand kits, live
  components).
- An export record captures what each following reference resolved to (the digest of its parts at export time),
  so every artifact can be explained later.

### 6.4 Exports

```ts
export interface ExportRecord {                          // records/ex/…
  readonly schema: 'instaflow.export/1';
  readonly id: ExportId; readonly asset: AssetId; readonly snapshot: SnapshotRef;   // frozen at export start (IF-5.10, D10); kept only by Releases
  readonly format: 'png' | 'pdf' | 'svg' | 'mp4' | 'webm' | 'gif' | 'viewer-html' | 'iflow';
  readonly preset: Record<string, JsonValue>;            // size, variant selection, range, codec
  readonly resolved: Readonly<Record<AssetId, Digest>>;  // following references at export time
  readonly outputs: readonly BlobRef[];
  readonly createdAt: string; readonly createdBy: Actor;
}
```

### 6.5 Garbage collection

Roots: live tree assets in the library doc (their heads, part snapshots, log, milestones and pinned set), export
records, and blob assets referenced from any of those or listed live in the library. The collector marks from
roots, then sweeps blobs and records unmarked for 30 days. Trash is library state, and emptying the trash only
removes roots. A blob shared by two documents stays alive while either one does. Neither document depends on the
other.

## 7. Agent edit protocol

Pipeline (all in the editor worker, built on demand, never a standing replica):

```
composed stage ──ViewCodec.project(scope, budget)──► agent view (markup | JSON) + base + viewHash
agent ops / fragment ──ViewCodec.compile(edit, base, handles)──► ChangeSet (canonical ops, §7.4)
ChangeSet ──validate──► proposal or applied transaction (§7.5) ──► result: applied / stale / errors (code + fix)
```

### 7.1 Agent views (research 05)

Views are read-only projections of the **composed** stage. They are generated from component schemas plus a
codec declaration (SF-Δ34). The canonical model is unchanged.

| View | For | Shape |
|---|---|---|
| `layout` | pages, canvas | Restricted, absolutely positioned HTML/SVG-like markup: closed vocabulary, one element per node kind, attributes = component fields |
| `timeline` | tracks, clips, transitions, keyframes | OTIO-shaped JSON in **seconds** (2–3 decimals) or frames at the declared rate |
| `transcript` | speech in clips | `[w101 11.20–11.48 "wait,"] …`: word ids with timeline times (from the transcript asset) |
| `graph` | flows | JSON of steps, ports, edges and inputs, plus a one-line outline |
| `screenshot` | visual verification | PNG of the scope with id badges and a legend (headless render), on demand only |

Example (`layout`, scope `page:p1`):

```html
<view kind="layout" base="fr:9a1c" hash="sha256:5be0…" units="px,s" scope="page:p1">
<page id="n1" name="Diwali sale" w="1080" h="1350" fill="@cream" format="ig-post">
  <image id="n2" role="background" x="0" y="0" w="1080" h="1350" src="as_bg_lamps" fit="cover" locked="position"/>
  <text id="n4" role="headline" x="80" y="300" w="920" font="@display" size="120" fill="@primary" align="center"
        motion-in="fade-up 0.6s">Diwali Sale</text>
  <slot id="n6" name="hero" accepts="image" x="240" y="600" w="600" h="520"/>
  <text id="n10" role="legal" x="80" y="1300" w="920" size="18" fill="@muted" from="template">Valid until 3 Nov.</text>
</page>
<lints><lint id="n4" code="contrast" detail="3.1:1 (min 4.5)"/></lints>
<comments><comment id="c3" on="n4" by="Priya">Make this pop more</comment></comments>
</view>
```

Rules:

1. **Scope and budget.** `scope = selection | viewport | page:<id> | time:[a,b] | subtree:<id> | outline`, plus a
   token `budget`. Outside the scope there are *blurry* one-line entries (id, kind, role, bounds, first words),
   then clusters (`<more count bounds/>`). A whole-document request returns an outline.
2. **Composed values with annotations:** `@token` (brand token), `from="brand|template"` (inherited or final),
   `locked="position|content|all"`, `inst="as_…"` (instance).
3. **Agent units:** page-relative integer geometry (unrounded on compile, so untouched fields keep full precision),
   seconds instead of ticks, hex or tokens for color, document order instead of fractional keys, and preset
   `slug`s instead of asset ids for motion presets.
4. **Defaults omitted.** Semantics explicit: `role`, `name`, and slots as `slot accepts`.
5. **Handles** `n1…nN` per agent session (IF-6.15), mapped in a worker-side table.
6. **Header:** `base` (version token), `viewHash` (sha256 of the text), scope and units. From the second turn on,
   a `changed-since` section lists what others added, removed or updated in scope since the agent's last `base`.
7. **Lints** (overlap, off-page, text overflow from Parley metrics, contrast, safe area, empty slot) and
   **comments** in scope are part of the view. Document text is marked as data.
8. **Caching:** a per-node line cache keyed by `(node, composedVersion)`, page views memoized by `(page,
   frontier)`, and a stable schema prefix so provider prompt caching keeps working.

### 7.2 Version token

```ts
export interface VersionToken { readonly asset: AssetId; readonly frontier: string /* opaque, engine-encoded */; readonly seq: number }
```

Every view returns the token for the state it projected. Every edit names it as `base`.

### 7.3 Agent edit ops (view level)

```ts
export interface AgentEdit {
  readonly base: string;                                  // the view's base
  readonly mode?: 'partial' | 'atomic';                   // default partial
  readonly dryRun?: boolean;                              // compile + validate + preview, no proposal
  readonly intent: string;
  readonly ops?: readonly AgentOp[];
  readonly fragment?: { readonly replace: string /* handle */ | 'new'; readonly markup: string };  // create / agent-created subtrees
}
export type AgentOp = (
  | { op: 'set'; id: Handle; attrs: Record<string, JsonValue> }
  | { op: 'create'; tempId: `new:${string}`; parent: Handle; after?: Handle; el: string /* one markup element */ }
  | { op: 'delete'; id: Handle } | { op: 'move'; id: Handle; parent: Handle; after?: Handle }
  | { op: 'text'; id: Handle; value: string } | { op: 'text'; id: Handle; find: string; replace: string }
  | { op: 'animate'; id: Handle; prop: string; keys: readonly { t: number; v: JsonValue; ease?: string }[] }
  | { op: 'motion'; id: Handle; in?: PresetArg; out?: PresetArg; loop?: PresetArg; emphasis?: PresetArg }
  | { op: 'place'; id: Handle | `new:${string}`; track: Handle; start: number; clip?: AssetId }
  | { op: 'trim'; id: Handle; in?: number; out?: number } | { op: 'split'; id: Handle; at: number }
  | { op: 'cut'; range: { start: number; end: number } | { words: readonly string[] }; ripple: boolean }
  | { op: 'transition'; from: Handle; to: Handle; preset: string; duration: number }
  | { op: 'step'; tempId: `new:${string}`; capability: string; in: Record<string, JsonValue>; after?: Handle }
  | { op: 'connect' | 'disconnect'; from: `${Handle}.${string}`; to: `${Handle}.${string}` }
  | { op: 'input'; name: string; type: string }
  | { op: 'invoke'; capability: string; input: JsonValue }
) & { readonly expect?: Record<string, JsonValue> };      // preconditions on fields the agent read
type Handle = string; type PresetArg = { preset: string /* slug */; duration: number; params?: Record<string, JsonValue> };
```

- **Fragments are diffed against the base view the agent read**, never against current state. Only fields the
  agent changed become ops, which keeps concurrent human edits intact (three-way rule: base, theirs, mine).
- **Compile** resolves handles and temp ids, unrounds, converts seconds to ticks (nearest tick), resolves preset
  slugs, and expands compound ops (`place`, `cut` with ripple, `connect` replacing a bound edge) into canonical
  ops. The result is one `ChangeSet` (§7.4).
- **Stale fields at submission:** a field written by an op that someone else changed after `base`, or a failed
  `expect`, yields `IF-CS-010 stale-field { id, field, theirs, yours, fix: "re-read the view or resend with
  expect=theirs" }`. That op is dropped and the rest apply (`partial`), unless `atomic` was requested.
- **Result:** `{ proposal | applied, created: { "new:cta2": "n31" }, stale: [...], errors: [...], viewHash }`.

### 7.4 Change sets (canonical)

```ts
export interface ChangeSet {
  readonly schema: 'instaflow.changeset/1';
  readonly id: ChangeSetId;
  readonly target: AssetId;
  readonly base: VersionToken;
  readonly author: Actor;
  readonly intent: string;                               // one human-readable sentence; becomes the undo label
  readonly ops: readonly Op[];                           // ≤ 2,000
  readonly params?: JsonSchema;                          // when saved as a macro step: `{ "$param": "name" }` values allowed
  readonly addresses?: CommentId;                        // the comment this change set answers (§11)
}

export type NodeRef = NodeId | `$${string}`;             // `$name` = temp id created earlier in this change set
export type Op =
  | { op: 'create'; temp: `$${string}`; kind: NodeKind; parent: NodeRef; after?: NodeRef | null;
      props: Record<PropertyPath, JsonValue> }
  | { op: 'update'; node: NodeRef; set: Record<PropertyPath, JsonValue | null /* null = remove local opinion */> }
  | { op: 'delete'; node: NodeRef }
  | { op: 'move'; node: NodeRef; parent: NodeRef; after?: NodeRef | null }
  | { op: 'text.splice'; node: NodeRef; at: number; delete: number; insert: string; style?: Partial<TextStyle> }
  | { op: 'text.mark'; node: NodeRef; start: number; end: number; style: Partial<TextStyle> | { inherit: BrandClassRef } }
  | { op: 'keyframe.set'; node: NodeRef; path: PropertyPath; key?: KeyId | `$${string}`; t: Ticks; value: AnimValue;
      interp: Keyframe['interp']; ease?: Keyframe['ease'] }
  | { op: 'keyframe.delete'; node: NodeRef; path: PropertyPath; key: KeyId }
  | { op: 'clip.place'; temp: `$${string}`; track: NodeRef; source: AssetRef; at: Ticks; in?: Ticks; out?: Ticks;
      mode: 'insert' | 'overwrite' | 'append' }          // compound: expands to create + explicit moves of later clips
  | { op: 'capability.run'; temp?: `$${string}`; capability: CapabilityId; input: JsonValue;
      bind?: { node: NodeRef; path: PropertyPath } };    // e.g. bind the generated asset to source.asset
```

**Validation** (editor worker, ≤ 50 ms for 500 ops, all results returned at once):

| Code | Check |
|---|---|
| `IF-CS-001` | Schema: op shape, path exists for the node kind, value type (generated JSON Schema) |
| `IF-CS-002` | Unknown node id, or a temp id used before it is created |
| `IF-CS-003` | Duplicate temp id |
| `IF-CS-004` | Target path locked (UX lock: ask the human; policy lock: never for agents) |
| `IF-CS-005` | Move would create a cycle, or the parent cannot hold the kind (§3.1 table) |
| `IF-CS-006` | `capability.run` denied for this subject, or the capability does not apply |
| `IF-CS-007` | Base older than retained history: allowed, but every op is flagged for review and nothing auto-applies |
| `IF-CS-008` | Over size limits (2,000 ops, 10 MB) |
| `IF-CS-009` | Referenced asset missing or of the wrong kind |
| `IF-CS-010` | Stale field: changed by someone else after `base`, or `expect` failed (op dropped in `partial` mode) |
| `IF-CS-011` | Mode invariant: `in < out ≤ media duration`, transition between non-adjacent items, port type mismatch |
| `IF-CS-012` | Unknown preset slug or capability name (the fix lists valid values) |
| `IF-CS-013` | Write to a `final` (brand/template) path. Use `override: true` for an intended local override where policy allows it |

**Determinism:** new node ids are `hash(changeSetId, applicationId, temp)` encoded as a node id. Compound ops
expand by a pure function of `(op, base state)`. `capability.run` stores its output reference in the proposal on
first apply. Replays (macros, templates, batch runs) reuse it unless "re-run" is chosen.

### 7.5 Proposals

A valid change set becomes a **proposal**. The change set and its per-op status are stored in the root part's
`proposals` map (CRDT state), so every peer (other tabs, later remote users) sees it. Each peer computes the
preview deterministically by applying the ops to a fork of the affected parts, composed as a `proposal/<id>`
layer over Latest. The fork itself is never persisted. Proposals are excluded from milestones and are pruned
30 days after they are resolved.

Lifecycle `edit/proposal`: `received → validating → invalid | proposed → accepting → accepted | partially-accepted`;
`proposed → rejected | superseded`. Under `auto-apply-safe`, eligible change sets go `validating → applied` (still
one undo step).

- **Accept** (all, a subset, or one op plus its dependencies): the chosen ops are re-applied to the current Latest
  as **one transaction** with `actor = author`, `acceptedBy = human`, `changeSet = id`, so it is one undo step.
- **Conflicts:** for each op, if a target path changed in Latest after `base` (determined from the CRDT's change
  history between `base.frontier` and now), the op is **flagged** with the base, current and proposed values. The
  default is to keep the current value. Concurrent edits elsewhere merge by CRDT semantics with no flag.
- **Reject** drops the layer. Rejecting an agent session drops its open proposals and reverts its applied commits
  that have no later dependent edits, and names the commits that do.

### 7.6 Undo

Undo is per actor and grouped by transaction (SF-Δ9). Undoing an accepted change set reverts exactly its
transaction, using CRDT inverse ops, so concurrent edits by others survive. The undo stack persists in the log up
to the undo horizon.

### 7.7 Agent tools (published as capabilities, so as WebMCP tools)

| Tool | Purpose |
|---|---|
| `agent/describe` | The generated vocabulary reference for each view and the agent-op JSON Schema (a stable prompt prefix) |
| `agent/read-view` | `{ kind: layout \| timeline \| transcript \| graph, scope, budget }` → view text + `base` + `viewHash` |
| `agent/selection` | The current selection (handles, ranges, lens) plus `base` |
| `agent/screenshot` | PNG of a scope with id badges and a legend, or a frame at `t` |
| `agent/explain` | `explain(handle, attr)`: which layer or brand rule produced a value |
| `agent/apply` | Submit an `AgentEdit`; returns the proposal or applied result, stale fields and errors |
| `agent/proposal-status` | State, per-op acceptance and accept-time conflicts |
| `agent/comment` | Leave a comment on a handle, point, range or graph node (when comments ship, §11) |

`invoke` ops and all other actions (generate, extend, remove background, export, create milestone) are their own
capabilities with their own schemas, gating and confirmation.

## 8. Schema evolution

- **Version levels:** workspace `format` (`instaflow.ws/1`), record `schema` strings, `treeSchema` (component
  registry version, with per-component migrations), and `features` lists.
- **Additive by default:** new optional fields and new components. Ids and field names are never renamed.
- **Latest:** a breaking change is an **epoch migration**. The store writes new part snapshots in the new schema,
  bumps `treeSchema`, `minReader` and `minWriter` in the head, and drops the old log. Older apps open the asset
  read-only with `IF-STORE-005` ("update Instaflow").
- **Immutable records and milestone parts are never rewritten.** They are upgraded on read
  (`parse → migrate → validate`). "New document from milestone" writes the current schema.
- **Engine swap** (Loro → other): parts are re-materialized from a canonical export of Latest. Milestones,
  `.iflow` and change sets are unaffected.

## 9. `.iflow` single-file export

```
launch-campaign.iflow                       zip (EPUB OCF style)
├── mimetype                                "application/vnd.instaflow.bundle+zip" — first entry, STORED
├── manifest.json                           { format: "instaflow.bundle/1", minReader: 1,
│                                             kind: "milestone" | "workspace",
│                                             roots: [{ asset, milestone }], records: [...], featuresRequired: [...],
│                                             createdWith: "instaflow/<version>" }
├── records/{as,ms}/…                       closure: root assets + pinned and following references (captured as milestones)
├── blobs/sha256/…                          milestone parts (deflated), media (STORED for range reads)
└── preview/cover.webp
```

- **Engine-independent:** no CRDT bytes and no logs. A workspace backup captures each Latest as a milestone of
  `kind: 'named'`, named "Backup · <date>".
- **Import** reads in place (central directory plus `File.slice`), deduplicates blobs by digest, and applies
  "New document from milestone" semantics. Imported documents are new assets with fresh baselines.
- **Save:** File System Access save picker on Chrome, download on Firefox.

## 10. Error codes (format and store)

`IF-STORE-001` quota exceeded · `002` digest mismatch (object quarantined) · `003` head CAS conflict (retried) ·
`004` folder permission lost (read-only until re-granted) · `005` schema newer than this app · `006` missing blob
(show a placeholder; offer relink) · `IF-MS-001` milestone part missing · `IF-BUNDLE-001` not an Instaflow bundle ·
`002` bundle requires an unknown feature · `IF-EXT-001` extension used an undeclared permission · `IF-EXT-002`
manifest invalid or unknown contribution point. Change-set codes are in §7.4.

## 11. Comments and annotations (design direction)

```ts
export type CommentId = `cm_${string}`;                  // uuidv7
export type Anchor =
  | { on: 'node'; node: NodeId }
  | { on: 'point'; x: number; y: number; relativeTo?: NodeId }       // canvas/page coords; follows relativeTo if set
  | { on: 'time'; start: Ticks; end: Ticks; relativeTo?: NodeId }    // clip-relative if set, else story time
  | { on: 'text'; node: NodeId; start: number; end: number }         // follows edits through rich-text anchors
  | { on: 'graph'; node: NodeId };                                   // a step or edge
export interface Comment {
  readonly id: CommentId; readonly anchor: Anchor; readonly body: RichText;
  readonly author: Actor; readonly createdAt: string;
  status: 'open' | 'resolved'; orphaned?: { lastKnown: Anchor };   // target deleted
  addressedBy?: ChangeSetId;                                        // a proposal that addresses it
  // later, with accounts: replyTo?: CommentId; mentions?: readonly string[]
}
```

- Comments are stored in the asset's `comments` part, a separate CRDT doc in the same head and log, co-editable
  like content.
- They are **excluded** from milestone parts, `.iflow` milestone bundles (a workspace backup may include them),
  exports and releases. "New document from milestone" starts with no comments.
- `ChangeSet.addresses?: CommentId` links a proposal to the comment it answers. Accepting it offers "Resolve".

## 12. Extension manifest (design direction, D7)

```ts
export interface ExtensionManifest {
  readonly schema: 'instaflow.extension/1';
  readonly id: `${string}.${string}`;                      // reverse-DNS-ish, e.g. 'org.example.qr-codes'
  readonly name: string; readonly version: string; readonly publisher: string;
  readonly trust: 'first-party' | 'sandboxed';             // sandboxed → @staticflux/sandbox (iframe or worker)
  readonly entry: string;                                  // module URL or logical chunk id
  readonly contributes: {
    readonly capabilities?: readonly { id: CapabilityId; appliesTo: SelectionShape; presentation: HudPresentation }[];
    readonly panels?: readonly { id: string; title: string; icon: string; appliesTo?: SelectionShape }[];
    readonly storageProviders?: readonly { id: string; label: string }[];
    readonly importers?: readonly { mime: readonly string[]; extensions: readonly string[] }[];
    readonly exporters?: readonly { format: string; label: string }[];
    readonly modelProviders?: readonly { id: string; tasks: readonly string[] }[];
    readonly elementTypes?: readonly DeclarativeElementType[];      // the hard open problem (IF-17.7)
    readonly commentActions?: readonly { id: string; label: string }[];
  };
  readonly permissions: {
    readonly document: 'none' | 'read-views' | 'propose';           // 'propose' = change sets only, same validation as agents
    readonly assets: readonly ('read' | 'create')[];
    readonly network: readonly string[];                            // allowed origins, enforced by the sandbox
    readonly storage: 'own-namespace' | 'none';
  };
}
/** Declarative element type: parameters → a pure expansion into a subtree of core primitives. No custom renderer. */
export interface DeclarativeElementType {
  readonly kind: `x:${string}`; readonly version: number;
  readonly params: JsonSchema;
  readonly expand: string;                                 // id of a pure, sandboxed expansion function (params → primitive nodes)
}
// SelectionShape and HudPresentation: the capability applicability and presentation types (SF-Δ11).
```

There are no contribution points for replacing core behaviour, engine or renderer hooks, format extensions,
or bypassing gates, locks, validation or confirmation (D7). Installed extensions are recorded in the library
document. A document that uses an `x:` element type stores it as a normal `instance`-like node whose expansion
is cached as primitives, so it still renders and exports when the extension is missing.

## 13. Rejected alternatives

- **Per-design folder with a manifest and page files:** duplicates shared assets, breaks cross-document
  references, is not atomic and does not map to object storage.
- **Frontier-based named versions plus CRDT history checkout (report 01 §2.11):** costs grow with history, and
  the versions are tied to one CRDT engine.
- **Milestones as diffs against a parent:** violates "costs scale with size".
- **A live `base` layer for templates and remixes, and `payload`/`specialize` arcs:** hidden ancestry dependency
  and extra complexity. Templates instantiate detached (IF-5.8). Lazy loading is internal partitioning.
- **sqlite-wasm catalog in V1:** an extra ~1 MB Wasm and toolchain for a rebuildable index. IndexedDB is enough
  locally.
- **Data URLs or inline media in JSON (Excalidraw):** does not scale.
- **CRDT bytes in `.iflow`:** couples interchange to the engine and leaks history.
- **Agents reading the canonical tree directly (research 05):** 5× the tokens, cryptic ticks and keys, and
  composed values are not stored anywhere. **Making the stored form agent-shaped:** still needs a projection
  (composed vs one layer) and would weaken CRDT convergence.
- **Real HTML+CSS, JSX or raw SVG documents as the agent view:** flow layout, cascade and code do not round-trip
  into our model. They are kept as export targets only.
- **Unified diffs, JSON Patch with indices, whole-view regeneration as edits:** positional, and they clobber
  concurrent edits.
- **Render-to-texture custom element types:** they patch the renderer and break export parity (D7).
