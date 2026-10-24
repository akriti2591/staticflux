# Instaflow research 01: the document format

Status: **research input, not a decision record.** Compiled 2026-10-24 for Instaflow, a local-first, cloud-ready,
agent-first authoring app built on StaticFlux.
Method: web search (summaries of primary docs, engineering blogs, and specs) plus the npm registry for library
versions, checked on 2026-10-24. Direct page fetches were blocked in this research environment, so every claim
comes from search-result extracts of the cited page. **UNVERIFIED** marks claims I could not confirm from a primary
source. StaticFlux facts come from this repo (`packages/*/AGENTS.md` and `src`).

---

## 0. Summary

1. **There is no "design file". There is a workspace object store.** All prior art that scales (Git, OCI, USD
   asset resolution, Figma's server, tldraw sync) separates three things:
   - **immutable, content-addressed bytes**;
   - **small mutable heads**: which version is current;
   - **a derived index**.

   Instaflow should do the same. Media, renditions, CRDT snapshots and published releases are immutable objects
   keyed by hash. Each composition has a tiny mutable `head`. The catalog (SQLite locally, Postgres in the cloud)
   is rebuildable from those objects. The same object keys work in OPFS, a user-picked folder, and S3/R2, so
   moving to the cloud needs no format change.
2. **An asset is the data primitive, and compositions are assets too.** An image, a clip, a font, a brand kit, a
   template, a motion preset, a workflow, and a design are all `Asset`s with a stable id, immutable versions,
   provenance, and renditions. Assets differ only in how their content is stored:
   - *blob content*: bytes;
   - *CRDT content*: a composition, which is a live document.

   "Actions on an asset" are StaticFlux capabilities. Each takes `AssetRef`s and yields new asset versions, and
   provenance is recorded automatically.
3. **One authoring core, four modes.** A composition is a tree of nodes. Every node can carry *space*
   (`Spatial`), *time* (`Temporal`), and *graph* (`Port`/`Edge`) components. A container's `layout` decides the
   mode:
   - `page` and `sequence`: Canva;
   - `free`: Figma/tldraw;
   - `track`/`stack`: OpenTimelineIO;
   - `graph`: workflow.

   Modes nest freely. A page can hold a picture-in-picture timeline. A canvas can hold pages. A graph step can
   output a clip that lands on a track.
4. **Reuse comes from USD-style layering, cut down to a small set of arcs.**
   - A composition is a *layer stack*: session > agent proposal > local > base.
   - Nodes can carry the *arcs* `reference` (instances, templates, remix), `inherit` (brand-kit classes),
     `variant` (component variants, formats, locales), `payload` (lazy sub-documents), and `specialize`
     (template defaults).
   - Overrides are sparse opinions.
   - Policy locks are `final` opinions: a `final` opinion in a template or brand layer cannot be overridden by any
     layer above it.
5. **CRDTs only for what people co-edit.** Each composition layer is its own CRDT document. These documents are
   the unit of sync, lazy load, permission, and compaction. Blobs, asset versions, provenance, releases, ACLs and
   job state are immutable or server-authoritative, never CRDT. Recommendation: keep StaticFlux's `DocumentCRDT`
   seam. Gate the choice with a benchmark spike between **Loro 1.17** (movable tree, movable list, Eg-walker rich
   text, shallow snapshots, checkout/fork; ~1.19 MB gzip wasm) and an **extended StaticFlux LWW engine** (with
   Kleppmann tree moves and Yjs text).
6. **Time is integer ticks** at 705,600,000 per second ("flicks"). OTIO supplies the clip model: placement range,
   source range, time effects, and transitions. Keyframes live in per-property animation channels. Text and
   transition animations are references to `motion-preset` assets.
7. **Export is a closure bundle.** `.iflow` is a zip with a stored `mimetype` entry first, following EPUB OCF. It
   contains a manifest, the asset records and CRDT snapshots in the closure, and blobs, either embedded or
   linked. **Publishing** produces an immutable *release*: a pinned, flattened stage plus renditions, optionally
   end-to-end encrypted with an Excalidraw-style key in the URL fragment.

---

## 1. Prior art

### 1.1 Comparison table

| System | Unit of storage / sync | Structure model | Reuse and composition | Time model | Binary assets | Packaging | Merge model | Versioning and migration | Take for Instaflow |
|---|---|---|---|---|---|---|---|---|---|
| **Pixar OpenUSD** | **Layer** (file); a stage is a composed layer stack | Prim namespace tree; sparse "opinions" per property | Arcs ordered by strength **LIVERPS**: Local, Inherits, Variants, (r)Elocates, References, Payloads, Specializes. Payloads load lazily. Scenegraph instancing shares prototypes. | Time-sampled attributes; value clips | External, resolved by an asset resolver | Layers + `.usdz` (zip) | None (pipeline ownership: one department owns one layer) | Schemas + plugins | **Layering, sparse overrides, payloads, a resolver, and instancing.** Why it scales: each layer is owned by one party and loads independently. Payloads defer heavy data. Instancing collapses copies into one prototype. Composition is incremental. |
| **OpenTimelineIO** (0.18.1) | Timeline file | Timeline → Stack → Track → Clip / Gap / Transition | Nested stacks (sub-timelines) | `RationalTime` / `TimeRange`; clip `source_range` against media `available_range`; `LinearTimeWarp`, `FreezeFrame`; markers | `MediaReference` (External / Missing; multiple references per clip) | `.otio` JSON; `.otiod` dir / `.otioz` zip with `content.otio` + `media/` + `version.txt` | None | `Schema.N` names with upgrade/downgrade functions | **Clip = placement + source range + effects; transitions are items between clips.** Bundle layout. Versioned schema names. |
| **Lottie** (spec 5.12; dotLottie v2) | One animation JSON | Layers with keyframed properties; precomps | Precomps listed as assets | Frames at a fixed rate; per-property keyframes with bezier easing | `assets[]` (images, precomps) | `.lottie` zip: `manifest.json`, `a/`, `t/` themes, `s/` state machines | n/a | Spec versions | **Per-property keyframes, precomps as assets, themes as variants.** An export target for motion. |
| **Rive** (format major 7; web runtime 2.47) | `.riv` binary | Artboards, shapes, animations, state machines, view models (data binding) | Nested artboards | Timelines + **state machines** | Embedded or referenced | Binary LEB128 `.riv`; `.rev` editor format; RML (XML) source | n/a | Major versions are not cross-compatible | **Interactive states and data binding are separate from the timeline.** Do not bake runtime format choices into the authoring format. |
| **Figma** | Document on a server; **pages load dynamically** (QueryGraph) | Tree, stored as a map ObjectID → properties | Components / instances (sparse overrides kept across swaps), variants, component properties (boolean / text / instance-swap / variant / slot), variables with modes | Prototype interactions only | Images by hash (UNVERIFIED in this pass) | `.fig` = 8-byte magic `fig-kiwi` + compressed self-describing Kiwi schema + scene | **Per-property LWW decided by the server**; fractional indexing for child order; server rejects reparenting cycles | Schema embedded in each file | **Per-property LWW, fractional order, overrides-on-instances, and loading only pages in view.** Ship the schema with the data. |
| **tldraw** (5.5.2) | Store of **records**; `.tldr` = `{ tldrawFileFormatVersion, schema, records }` | Flat records with `parentId` + fractional `index`; **bindings** are their own records (`fromId` / `toId`) | Custom shapes / bindings | none | Asset records; blobs live in an asset store | JSON | Server-authoritative push / pull / rebase (not a CRDT); v4.3+ pluggable `SQLiteSyncStorage` (Durable Object SQLite) | **Migration sequences with ids, `dependsOn`, up / down**; the server migrates per client version | **Records + bindings + migration sequences;** record scopes (document / session / presence). The server holds each client's schema. |
| **Excalidraw** (0.18.1) | One scene JSON | Flat elements array; per-element `version`, `versionNonce`, and the `isDeleted` tombstone | Libraries | none | Top-level `files` map (id → dataURL + mime) | `.excalidraw` JSON | Union by id; highest version wins | Scene `version` | **E2EE share links: the key lives in the URL `#fragment`, which the server never sees.** Lesson: inlining files as data URLs does not scale. |
| **Penpot** (.penpot v3) | File with pages | Shapes keyed by id with `parent-id` and `frame-id` | Components v2, shared libraries, design tokens | none | Binary parts in the zip | ZIP: `manifest.json`, one JSON per page, **one JSON per shape**, `components/`, colors, typographies, tokens, plus feature flags such as `components/v2` | Server | **Feature flags in the manifest.** The old SVG-in-zip export was abandoned as "highly inefficient." | **Declare needed features in the manifest.** The old export was abandoned for being too slow, so performance has to be designed into the format. |
| **Canva** (public API only) | Design → pages → elements | Elements contain *content* (image / video content sits inside a rect, not as its own element type) | Brand templates with **autofill dataset fields** (text, image/video, chart, sheet); brand kits | Page durations, animations (internal model not public) | Asset library | Not public | Not public | Not public | **Content is separate from the element that holds it. Templates expose typed slots** that data and agents can fill. |
| **Framer** | Project | Canvas + components | Variants are full copies; transitions interpolate between variants; CMS bindings for component variables | Variant transitions | — | Not public | Not public | — | **Variants + data binding = template slots.** |
| **Automerge 3.5** / **automerge-repo** | **One document = one CRDT**; a repo manages many | JSON-like (maps, lists, text) | n/a | n/a | n/a | Storage adapters over KV with range queries | Op-based CRDT with full history; 3.0 cut memory >10× | Same file format since 2 | **A repo of many small docs over a KV store is the right shape.** Rejected as primary because it is heavier than needed and has no movable tree. |
| **Yjs** 13.6.33 (v14 still prerelease) | `Y.Doc`; subdocs load lazily | Map / Array / Text / XML | Subdocuments | n/a | n/a | Binary updates | YATA | — | Already behind `DocumentCRDT`. Subdocs show per-part lazy loading. |
| **Loro** 1.17.1 (2026-10-22) | `LoroDoc` | Map, List, **MovableList**, **Tree (movable, cycle-safe)**, Text / RichText (Eg-walker based) | Fork / checkout of versions | n/a | n/a | Snapshot, updates, **shallow snapshot** (current state without the full history, like a Git shallow clone) | CRDT; version vectors and frontiers | — | **The best fit for hierarchy + order + rich text** in one engine. Costs ~3.6 MB raw / 1.19 MB gzip wasm (measured from the npm tarball). |
| **Git / OCI** | Immutable objects + mutable refs | Merkle DAG; OCI descriptor `{mediaType, digest, size}`; `index.json` entry point | Layers referenced by digest | — | Blobs `blobs/<alg>/<hex>`; missing blobs may come "from an external blob store" | Directory layout ↔ registry | n/a | `mediaType` / `artifactType` | **Content addressing, descriptors, and refs as the only mutable state.** The layout is identical on disk and in a registry. |
| **glTF 2.0** | JSON scene + buffers | Nodes / meshes / accessors → bufferViews → buffers | Extensions (`KHR_*`) | Animation samplers | `.bin` buffers (several, for partial loading) or GLB with one BIN chunk | `.gltf` + files, or `.glb` | n/a | `extensionsUsed` / `extensionsRequired` | **The JSON describes the scene and points into separately loadable binary buffers.** Mark required vs optional extensions. |
| **OOXML OPC / EPUB OCF** | Zip of parts | Parts + relationships (`_rels/.rels`) + `[Content_Types].xml` | Relationship graph | — | Parts | Zip; EPUB requires `mimetype` **first and stored uncompressed** | n/a | — | **Zip-of-parts export with a sniffable magic entry.** Uncompressed media entries can be read by range without unzipping. |
| **SQLite as app file format** | One file | Tables | — | — | BLOBs | One file; incremental writes; Save As uses the backup API | Single writer | `user_version` + migrations | **A good local *index* and catalog.** Not chosen as the canonical store, because objects in a DB file do not map 1:1 onto object storage. SQLite WASM 3.54.1 ships `opfs-sahpool`. |
| **Replicache → Zero** | Server DB rows | Relational | — | — | — | — | **Server-authoritative mutators**: the client result is a guess, and the server re-runs the mutator | Server | **Use for catalog, ACL and job metadata** (non-document data); StaticFlux's prior-art notes already reach the same conclusion. |
| **Ink & Switch** (local-first, Cambria, Keyhive) | — | — | — | — | — | — | — | **Cambria: bidirectional lenses** let clients on different schema versions co-edit | Lenses at the read boundary for co-editing across versions. **Keyhive** (2024–26): capabilities + E2EE access control for local-first. |
| **C2PA** (2.x) | Manifest embedded in or bound to an asset | Claim + assertions + signature + hard binding (hash) | Ingredients: `parentOf` / `componentOf` / **`inputTo`** (e.g. a prompt or seed image given to a model) | — | — | Embedded / sidecar | — | — | **Use the same provenance vocabulary**, so signed export is a projection of what is already recorded. |

### 1.2 What each one teaches (the points that drive the design)

- **USD: why it scales.**
  1. Data is split into **layers that are owned and loaded independently**. Composition is lazy.
     **Payloads** are references that a stage can leave unloaded.
  2. **Opinions are sparse**: a layer stores only what it changes. A brand kit, a template, and a remix all
     become thin layers over shared bases.
  3. **Scenegraph instancing** collapses thousands of copies of a referenced asset into one prototype. This cuts
     load time and memory. Edits go only on the instance root; descendants are read-only proxies.
  4. An **asset resolver** maps logical asset paths to physical locations. Documents never contain physical URLs.

  The LIVERPS order is the reusable idea. Its full generality is not: relocates, list-editing ops, and arbitrary
  arc nesting are what make USD hard to learn and to implement. Sources:
  [NVIDIA Learn OpenUSD: LIVERPS](https://docs.nvidia.com/learn-openusd/latest/creating-composition-arcs/strength-ordering/what-is-liverps.html),
  [Foundry: Understanding LIVRPS](https://learn.foundry.com/katana/Content/ug/usd/composition_arcs_livrps.html),
  [OpenUSD scenegraph instancing](https://openusd.org/dev/api/_usd__page__scenegraph_instancing.html),
  [NVIDIA: what is instancing](https://docs.nvidia.com/learn-openusd/latest/asset-modularity-instancing/what-is-instancing.html),
  [AOUSD](https://aousd.org/?p=629).
- **OTIO:** the time model to copy.
  - A clip has a placement in its parent track and a `source_range` into media whose `available_range` is known.
  - Time effects (`LinearTimeWarp`, `FreezeFrame`) are separate from the range. Note that changing
    `time_scalar` does not change the item's duration.
  - Transitions sit between adjacent items.
  - Bundles: `.otiod` (folder) and `.otioz` (zip) with `content.otio` plus a flat `media/` folder.

  Sources: [OTIO file bundles](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-filebundles.html),
  [OTIO schema API](https://opentimelineio.readthedocs.io/en/latest/api/python/opentimelineio.schema.html),
  [OTIO 0.18.1 (Debian)](https://tracker.debian.org/media/packages/o/opentimelineio/control-0.18.1-2).
- **Figma:**
  - Properties merge last-writer-wins, decided by the server.
  - Children are ordered with arbitrary-precision fractional indexes.
  - The server rejects reparenting that would create cycles.
  - QueryGraph tracks read dependencies so only the needed pages reach a client. The hard part was
    cross-page dependencies, such as a variable on another page that sets a font size.
  - Instance overrides survive variant changes and instance swaps.

  Sources: [How Figma's multiplayer works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/),
  [Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/),
  [Speeding up file load times](https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/),
  [Plugin migration to dynamic pages](https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading),
  [Component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties),
  [.fig / Kiwi (Grida reverse engineering)](https://grida.co/docs/wg/feat-fig/),
  [Liveblocks explainer (secondary)](https://liveblocks.io/blog/understanding-sync-engines-how-figma-linear-and-google-docs-work).
- **tldraw:**
  - Records are typed with a scope: document, session, or presence.
  - Relationships are records of their own (bindings), not fields on shapes.
  - Migrations are sequences of ids with `dependsOn` and `up`/`down`.
  - The sync server migrates each client up and down to its own schema.
  - Storage is pluggable as of v4.3, including `SQLiteSyncStorage` on Durable Objects.

  Sources: [StoreSchema](https://tldraw.dev/reference/store/StoreSchema),
  [Migration](https://tldraw.dev/reference/store/Migration), [Bindings](https://tldraw.dev/sdk-features/bindings),
  [TldrawFile](https://tldraw.dev/reference/tldraw/TldrawFile), [v4.3.0 release](https://tldraw.dev/releases/v4.3.0),
  [SQLiteSyncStorage](https://tldraw.dev/reference/sync-core/SQLiteSyncStorage), [sync docs](https://tldraw.dev/docs/sync),
  [Grida analysis (secondary)](https://grida.co/docs/wg/research/crdt/tldraw).
- **Excalidraw:** per-element version numbers and tombstones; a `files` map for image data; encrypted share links
  that keep the key in the URL fragment.
  Sources: [P2P collaboration](https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature),
  [E2E encryption](https://plus.excalidraw.com/blog/end-to-end-encryption),
  [JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema).
- **Penpot:** .penpot v3 is a zip of JSON parts per page and per shape, with feature flags. The old SVG export
  was dropped for inefficiency.
  Sources: [Penpot file format](https://help.penpot.app/technical-guide/developer/data-model/penpot-file-format/),
  [import/export](https://help.penpot.app/user-guide/export-import/penpot-file-format/).
- **Canva (public API):** an element contains content. Brand templates expose an autofill dataset of typed
  fields.
  Sources: [Elements](https://www.canva.dev/docs/apps/elements/),
  [Design editing](https://www.canva.dev/docs/apps/feature-examples/design-editing/),
  [Autofill guide](https://canva.dev/docs/connect/autofill-guide),
  [Brand template dataset](https://canva.dev/docs/connect/api-reference/brand-templates/get-brand-template-dataset).
- **Framer:** variants are full copies of a component; transitions interpolate between them; component
  variables bind to CMS fields. Sources: [Framer: component variant](https://www.framer.com/ja/dictionary/component-variant)
  and secondary guides.
- **Lottie and Rive.**
  Lottie sources: [Lottie spec 5.12](https://docs.lottiefiles.com/en/format/lottie-json/specification),
  [Lottie v1.0 spec announcement](https://lottiefiles.com/blog/inside-lottiefiles/lottie-specification-v1-0-a-milestone-for-open-source-animation),
  [dotLottie 2.0](https://dotlottie.io/spec/2.0).
  Rive sources: [.riv format](https://rive.app/docs/runtimes/advanced-topic/format),
  [RML](https://rive.app/docs/runtimes/advanced-topic/rml).
- **CRDTs:**
  - [Loro 1.0 (movable tree / list, shallow snapshot, load times)](https://loro.dev/blog/v1.0)
  - [Loro movable tree](https://www.loro.dev/blog/movable-tree)
  - [Loro rich text on Eg-walker](https://loro.dev/blog/loro-richtext)
  - [Eg-walker (EuroSys 2025)](https://martin.kleppmann.com/2025/03/30/eg-walker-collaborative-text.html)
  - [Peritext](https://martin.kleppmann.com/2022/11/08/peritext-rich-text-crdt.html)
  - [Kleppmann et al. tree move op](https://martin.kleppmann.com/2021/10/07/crdt-tree-move-operation.html)
  - [Automerge 3.0](https://automerge.org/blog/automerge-3/)
  - [automerge-repo storage](https://automerge.org/docs/reference/repositories/storage/)
  - [Yjs subdocuments](https://beta.yjs.dev/docs/api/subdocuments)
- **Storage and packaging:**
  - [SQLite: app file format](https://sqlite.org/appfileformat.html)
  - [SQLite: short version](https://sqlite.org/aff_short.html)
  - [PowerSync: SQLite persistence on the web](https://www.powersync.com/blog/sqlite-persistence-on-the-web)
  - [MDN createSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
  - [OCI image layout](https://github.com/opencontainers/image-spec/blob/v1.0.1/image-layout.md)
  - [ORAS artifacts](https://oras.land/docs/concepts/artifact/)
  - [glTF 2.0 spec](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.pdf)
  - [glTF tutorial: buffers](https://gltf-tutorial.readthedocs.io/en/latest/gltfTutorial_005_BuffersBufferViewsAccessors/)
  - [OPC (OpenOffice wiki)](https://wiki.openoffice.org/wiki/OOXML/Open_Packaging_Conventions_(OPC))
  - [EPUB OCF mimetype](https://albertopettarin.it/blog/2014/06/07/epub-ocf-mimetype-and-kittens.html)
  - [BLAKE3 / Bao verified streaming (iroh)](https://www.iroh.computer/design/content-addressing)
  - [Bao spec](https://github.com/oconnor663/bao/blob/master/docs/spec.md)
  - [Tvix blob chunking](https://code.tvl.fyi/tree/tvix/castore/docs/blobstore-chunking.md)
- **Sync, schema and provenance:**
  - [Zero: when to use](https://zero.rocicorp.dev/docs/when-to-use)
  - [Zero: custom mutators](https://zero.rocicorp.dev/docs/custom-mutators)
  - [Cambria](https://inkandswitch.com/cambria)
  - [Cambria paper](https://dspace.mit.edu/handle/1721.1/145983)
  - [Local-first software](https://www.inkandswitch.com/local-first-software/)
  - [Keyhive](https://www.inkandswitch.com/keyhive/notebook/00/)
  - [C2PA guidance 1.4](https://c2pa.org/specifications/specifications/1.4/guidance/Guidance.html)
  - [C2PA synthetic content (2026)](https://c2pa.org/wp-content/uploads/sites/33/2026/07/Use-of-Content-Credentials-to-Identify-Synthetic-and-Non-Synthetic-Content.pdf)

### 1.3 Why not "my-design.iflow/ with manifest + pages"

The owner is right to doubt it. A per-design folder is a *packaging* choice that someone mistook for a *storage
model*. It breaks in six ways:

1. **Shared assets get duplicated.** Brand kits, stock media and fonts are copied into every design. Content
   addressing deduplicates them across the whole workspace.
2. **Cross-document references break.** Templates, remixes, brand inheritance and component libraries all point
   *outside* the folder. USD's lesson is that references go through a resolver, not relative paths.
3. **The cloud mapping does not hold.** A folder per design does not map onto "object storage + DB". Immutable
   objects + mutable heads + an index does map 1:1 (Git/OCI).
4. **Lazy loading suffers.** A manifest naming page files is a weak version of payloads. Each page or timeline
   segment needs its *own sync unit* (a CRDT doc), not only its own file.
5. **Co-editing is harder.** Rewriting `page-3.json` on every keystroke conflicts with CRDT append logs and
   compaction.
6. **Atomicity is missing.** A multi-file save without a head pointer is not atomic. The Git pattern is: write the
   objects, then swing one ref.

A folder is still useful as one view of the store. In "linked folder" mode, a directory picked with File System
Access holds exactly the workspace-store layout. It is git-friendly and inspectable. A single `.iflow` file
remains the *export/interchange* format (§2.8).

---

## 2. Recommended Instaflow document model

### 2.1 Three storage classes and one rule

| Class | What | Mutability | Merge | Where (local → cloud) |
|---|---|---|---|---|
| **Blob** | Bytes: originals, renditions, CRDT snapshots and log segments, release bundles | Immutable, addressed by `sha256:` digest (chunked above 8 MiB) | None needed | OPFS `blobs/` → object storage `blobs/` (cache forever) |
| **Record** | Asset versions, provenance, releases, chunk manifests | Immutable; the id is the hash of the canonical JSON | None (append-only) | OPFS `records/` → object storage + DB rows |
| **Document** | Composition layers (the CRDT), plus a mutable `head` per doc | Append-only log + snapshots; one small mutable head | CRDT | OPFS `docs/` → DB (log rows) + object storage (snapshots) |
| *Derived* | Catalog index, composed-stage cache, search, thumbnails map | Rebuildable | n/a | SQLite (wa-sqlite / sqlite-wasm `opfs-sahpool`) → Postgres |
| *Server-authoritative* | ACLs, sharing, quotas, job state, billing | Server | Server wins (Zero / Linear style) | Not in the document at all |

**Rule:** a document never contains a physical location. It contains `AssetRef`s and digests. A resolver maps
those to OPFS handles, `blob:` URLs, signed CDN URLs or bundle entries. This is USD's asset resolver, applied
here.

### 2.2 Entities: assets, compositions, nodes, instances

- **Asset**: an identity (`AssetId`, UUIDv7) with a chain of immutable **versions** (`AssetVersion` records).
  Each version holds:
  - `kind`;
  - media info;
  - `content`, which is either a blob ref or a CRDT doc set;
  - **renditions**: derived, regenerable blobs such as a thumbnail, a 1080p proxy, a waveform, a filmstrip, an
    HLS ladder, or vector tiles;
  - **provenance**;
  - rights.

  Every importable or generatable thing is an asset. So is every *authored* thing: a design is an asset of kind
  `composition`, and its content is CRDT docs.
- **Composition**: an asset whose content is a **layer stack** of CRDT docs. Its **root doc** holds the node
  tree. **Payload docs** hold lazily loaded subtrees: pages, scenes, long sequences, graph subflows.
- **Node**: an entity in a composition doc, made of ECS components (StaticFlux `defineComponent`). Nodes are
  where assets appear in space and time.
- **Instance**: a node whose content comes from *another* asset through a `reference` arc. Examples:
  - a component instance;
  - an embedded design;
  - a template's base;
  - an image (an image node is a reference to an image asset, with a crop).

  Overrides on an instance are sparse opinions keyed by the *source* node id. Figma keeps overrides across
  swaps; USD keeps edits on the instance root. This model does both.

"Actions on an asset" fall into two families:

| Kind | Example | Result |
|---|---|---|
| **Parametric (non-destructive)** | crop, filters, trim, speed, color adjust, mask, text edits | Edits *node* components; the asset is untouched |
| **Materializing (destructive or generative)** | remove background, upscale, "extend this clip", generate image, transcode, flatten | A *new asset version or new asset* with provenance; the node's ref is swapped to it (one undoable transaction) |

Both are StaticFlux **capabilities**, so the UI, the command palette and agents all go through one gated,
metered pipeline.

### 2.3 One core, many modes

A mode is **(container layout) × (tool set) × (projection)**. It is not a document type.

| Mode | Container `layout` | Children carry | Order and placement | Prior art |
|---|---|---|---|---|
| Pages | `sequence` of `page` containers (fixed `size`) | `Spatial` (+ optional `Temporal` for page duration and animation) | Fractional `order` | Canva, Penpot |
| Infinite canvas | `free` (unbounded) | `Spatial` | Fractional `order` = z-order | Figma, tldraw |
| Timeline | `stack` of `track` containers | `Temporal` (placement) + `Source` (trim) [+ `Spatial` for overlays and PiP] | **By time** within a track; tracks ordered by `order` | OTIO |
| Graph / flow | `graph` | `Step`, `Port`; `Edge` entities | Edges (+ `Spatial` for layout) | Node editors, build graphs |
| Presentation / player | any | — | Read-only projection with playback | Canva present, Figma prototype |

Rules that keep one core:

- **Space and time are orthogonal components.** A `page` with `Temporal` is a slide with a duration. A `track`
  item with `Spatial` is an overlay or picture-in-picture. A `free` canvas frame with `AnimChannel`s is an
  animated board. A video asset dropped on a page becomes a node with `Source` + `Spatial`, and the timeline
  editor can open it in place.
- **Ordering inside timeline tracks comes from time, not list position.** Clips are placed by `start`, so
  concurrent drags never fight over list indexes; LWW on `start` resolves them. Ripple edits are explicit
  capability transactions that move later items.
- **Graph steps are capability invocations.**
  - A `Step` names a `CapabilityId`. Its inputs are bound to upstream ports or `AssetRef`s.
  - Its output is *materialized* as assets with provenance pointing back to `(composition, stepNode, run)`.
  - A recorded sequence of user actions can be captured into a graph ("macro"). A graph can be **collapsed into
    one atomic capability** (`defineCapability` generated from the graph) and exposed to agents.
  - Deterministic steps get memoized by `hash(capabilityVersion, inputs)`, like a Bazel/Nix action cache.
    Generative steps are only memoized when they have an explicit seed.
- **Modes nest.** A container of any layout can sit inside any other. The editor activates the mode of the
  nearest container that has focus, as a StaticFlux per-mode feature or variant binding, not an `if` on mode.

### 2.4 References and composition (USD-like, deliberately smaller)

A composition's **layer stack**, from strongest to weakest:

```
session    (ephemeral, never synced: drag previews, solo / mute; a presence-like channel)
proposal/* (agent or human suggestion layers: toggleable, diffable, accept = merge into local, reject = drop)
local      (the composition's own edits)
base       (optional: the remixed source or template base, pinned to a version)
```

**Arcs** on nodes, by strength (LIVERPS without relocates):

| Strength | Arc | Instaflow use |
|---|---|---|
| L | local opinions | What this layer authored |
| I | `inherit` | **Brand kit classes**. A node `inherits: brand://<kit>/class/heading`. When the kit changes the Heading class, every inheritor updates unless it has a local opinion. (Weaker than variants so a local variant can restyle.) |
| V | `variant` | **Variant sets**: component variants (`state=hover`), **formats** (`format=story|post|a4`, so one design has many sizes, like Canva resize), locales (`lang=de`), themes (`theme=dark`, like Figma variable modes and dotLottie themes) |
| R | `reference` | Component instances, embedded designs, image and video content, template base subtrees, **remix** |
| P | `payload` | The same as `reference` but **lazy**: pages, scenes, long sequences, heavy subflows. They load when they become visible or are scheduled for render. |
| S | `specialize` | Template defaults: the weakest opinions, so anything else wins |

- **References are pinned or floating.**
  - `{ asset, version }` is reproducible; use it for remixes and publishes.
  - `{ asset, version: 'latest' }` follows updates; use it for brand kits and live components.
  - Floating refs are resolved and *recorded* in releases, so every artifact is reproducible.
- **Overrides** are component values authored in a stronger layer at the instance proxy path
  `instanceNodeId/sourceNodeId` (one level of path per instance nesting). An instance stores only what it
  changes, as in USD's sparse opinions and Figma's overrides.
- **Locks and finality** (see §2.10): a brand or template layer may mark property paths `final`. Normal strength
  order would let stronger layers win. For `final` paths the composition engine instead keeps the `final`
  opinion, ignores opinions on those paths from every other layer except ones the lock explicitly allows (for
  example a brand-admin layer), and shows a lock badge. Examples: brand colors locked by an enterprise kit; a
  template's logo position.
- **Templates** are compositions with `Slot` nodes, which are typed placeholders. This is Canva's autofill
  dataset: `accepts: ['image','video']`, `text` with constraints, `data` (chart / sheet). Using a template means
  creating a composition whose `base` is the template version, then filling slots. A human, an agent, or a CSV
  batch can do the filling, and "generate 50 variants" becomes a loop over slot data.
- **Remix** = new composition, `base` = the source composition at a pinned version, plus an empty `local`.
  Provenance records `remixed` with `parentOf`. The original stays untouched and attributable.
- **The composition engine runs in the document worker.**
  - It computes the *composed stage* (flattened node values) incrementally.
  - A dependency index records *(composed node, property) ← contributing (layer, node, property, arc)*. This is
    the pattern of Figma's QueryGraph and USD's change processing.
  - Only invalidated entries are recomputed.

### 2.5 Animation, keyframes, transitions and time

- **Time base:** integer **ticks at 705,600,000/s** (the "flick" unit, which divides evenly into 24, 25, 30, 48,
  50, 60, 90, 120 fps, 23.976 via 1001 denominators, and 44.1k/48k audio). A JS number holds this exactly up to
  ~147 days. Store `Ticks` everywhere. Keep a `Rational` frame rate only as media metadata, as OTIO does. This
  removes float drift in trims and keyframes.
- **Clip model (from OTIO):**
  - `Temporal { start, duration }` places the item in its parent's time.
  - `Source { asset, in, out, speed, reverse, loop, freeze? }` maps into the asset's media time; the asset's
    `media.duration` is its `available_range`.
  - Nested compositions map time recursively, so sub-sequences and precomps work.
  - `Gap` is implicit: no item covers that time.
- **Transitions** are entities that bind two adjacent items on one track (`from`, `to`) with `duration`,
  `alignment` and a `preset: AssetRef` (kind `motion-preset`). They are relationships, so they are records of
  their own, like tldraw bindings.
- **Keyframes** use one `AnimChannel` entity per animated property: `{ target: NodeId, path: 'spatial.x' }` plus
  a CRDT map `KeyId → { t, value, interp: hold|linear|bezier|spring, ease: [x1,y1,x2,y2] }`. Channels are
  separate entities so concurrent edits to different properties merge cleanly. Keys have ids, not array
  positions, so moving a key in time is a single LWW write. Time inside a channel is relative to the node's
  `start`, which keeps animations intact when clips move.
- **Motion presets** cover in / out / loop animations, text animations (unit `char|word|line`, `stagger`),
  transitions, camera "zoom/punch-in" and Ken Burns. Each is an **asset** (versioned, brandable, shareable,
  generatable) with parameters. A node references a preset with param overrides, and "bake to keyframes" is a
  capability. Lottie precomps and Rive state machines are import/export mappings, not the internal model.
- **Zoom / PiP / overlays** are ordinary nodes on upper tracks with `Spatial` + `AnimChannel`s. A "zoom" on the
  main video is an AnimChannel on the clip's `spatial.scale` / `crop` with an easing preset.
- **Evaluation:** `evaluate(composition, t) → frame description`. It runs in a worker or Wasm and reads SoA
  columns (R11.19). An interval index answers "what is active at t" for long timelines.

### 2.6 Generated assets and provenance

Every asset version carries `Provenance`, using C2PA's vocabulary so signed export is only a projection:

- `action`: `imported | captured | created | edited | generated | derived | remixed`;
- `ingredients`: `[{ ref: AssetRef(pinned), relationship: parentOf | componentOf | inputTo }]`. The prompt
  itself is an asset of kind `prompt` (`inputTo`), so prompts are versioned, reusable, and redactable.
- `generator` (for generated assets): `{ provider, model, modelVersion, params, seed?, jobId, costCredits }`;
- `operation`: `{ capability: CapabilityId, capabilityVersion, input }`. This makes derivations replayable and
  lets graph steps memoize.
- `actor`: `human(userId) | agent(agentId, onBehalfOf userId, sessionId)`;
- optional `c2pa`: a blob ref to a signed manifest produced at export or publish.

**Example: "extend this clip by 3 s."**

1. An agent or a user invokes `video/extend { clip: AssetRef, seconds: 3, prompt }`.
2. The capability pipeline authorizes it, confirms it (agent + cost), reserves credits, and starts a
   **generation job** (server-authoritative state).
3. On success it ingests the output blob and creates asset `as_new@v1` with
   `generated, ingredients [{as_clip@v3, inputTo}, {prompt@v1, inputTo}]`.
4. In **one document transaction**, attributed `{actor: agent, invocationId}`, it either swaps the node's
   `Source.asset` and extends `duration`, or appends a new clip. Undo reverts the transaction. The generated
   asset remains in the library and can be garbage-collected later.

### 2.7 Identity and addressing

| Thing | Id | Notes |
|---|---|---|
| Workspace | `ws_<uuidv7>` | Tenancy and sync root |
| Asset | `as_<uuidv7>` | Stable across versions; time-ordered, which suits DB indexes |
| Asset version | `av_<sha256 of canonical record JSON>` | Immutable; verifiable |
| Document (CRDT layer) | `doc_<uuidv7>` | Unit of sync, permission and lazy load |
| Node | StaticFlux `<client36>-<n36>` (doc-local) | Globally `doc_…#node`; instance proxies `inst/src` |
| Blob | `sha256:<hex>` | WebCrypto, S3 checksum, OCI and C2PA all speak SHA-256 |
| Large blob | `sha256:` of a **chunk manifest** `{ size, mime, chunkSize: 4 MiB, chunks: [sha256…] }` | Range reads, resumable uploads (S3 multipart parts = chunks), partial dedup |
| Release | `rel_<sha256 of release manifest>` | Immutable published artifact |

**URIs** are logical and location-independent: `iflow://ws_…/as_…@av_…#node`. The resolver chain is:

1. in-memory;
2. OPFS store;
3. linked folder;
4. open `.iflow` bundle (zip central directory);
5. cloud, through a signed URL from the API.

Hashing note:
- `crypto.subtle.digest` is one-shot, not streaming, so hash large media in a worker with a Wasm streaming
  SHA-256, chunk by chunk.
- BLAKE3 with Bao trees would add verified range streaming and run faster with SIMD. Keep the digest
  algorithm-prefixed (`sha256:` / `b3:`) so it can be adopted later without a format change.

### 2.8 Storage packaging

**Workspace store** (canonical; the same layout in OPFS, a linked folder, and the cloud bucket prefix):

```
instaflow/ws_01JB…/                         OPFS root | user-picked dir | s3://instaflow-prod/ws_01JB…/
├── WORKSPACE.json                          { format: "instaflow.ws/1", id, minReader: 1, features: [...] }
├── catalog.sqlite                          DERIVED index: assets, versions, refs (where-used), docs, heads,
│                                           FTS search, sync cursors, GC roots. Rebuildable from the objects.
├── heads/
│   └── doc_01JB…F2.json                    the ONLY mutable files: { snapshot, logFrom, frontier, schema } (CAS-updated)
├── records/
│   ├── av/9c/9c41…e0.json                  AssetVersion records (immutable, hash-named)
│   └── rel/77/77aa…01.json                 release manifests
├── docs/
│   └── doc_01JB…F2/
│       ├── snap/000120.bin  → blob ref     compacted CRDT snapshots (also stored as blobs)
│       └── log/000121-3f2a.bin             append-only update segments (per client; coalesced per ~1 s / per gesture)
└── blobs/
    └── sha256/
        ├── 1c/1c9e…a2                      ≤ 8 MiB blob (image, font, snapshot, thumbnail)
        ├── 4d/4d07…11                      chunk manifest JSON for a 2.3 GB video
        └── a0/a0f3…77 …                    its 4 MiB chunks (also the S3 multipart parts)
```

**Single-file export `.iflow`:** a zip that follows EPUB OCF, OTIOZ, .penpot and dotLottie.

```
launch-campaign.iflow
├── mimetype                    "application/vnd.instaflow.bundle+zip"  (first entry, STORED: magic sniffing)
├── manifest.json               { format: "instaflow.bundle/1", root: "as_…@av_…", minReader: 1,
│                                 featuresRequired: [...], featuresUsed: [...], closure: [...], blobs: "embedded"|"linked" }
├── records/…                   every AssetVersion in the closure (root + references + brand kit + presets)
├── docs/doc_…/snap.bin         CRDT snapshots: shallow (state only) by default; full history optional
├── blobs/sha256/…              media (STORED, uncompressed, so they can be range-read straight from the file)
└── preview/cover.webp          share / OS thumbnail
```

- *Embedded* bundles are self-contained. *Linked* bundles omit blobs that the recipient can fetch from the cloud
  (the OCI "external blob store" rule).
- *Opening* a bundle reads it in place: zip central directory + stored entries + `File.slice` give random access.
  The bundle is then imported into the workspace store; the digests deduplicate.
- *Save to file* (File System Access) writes a new bundle and swaps it in atomically.

**Cloud mapping (no format change):**

| Local | Cloud |
|---|---|
| `blobs/sha256/…` | Object storage under the same keys; immutable; CDN `Cache-Control: immutable` |
| `records/…` | Object storage + `asset_versions` rows (Postgres) |
| `docs/…/log` | `doc_updates(doc_id, seq, client, bytes)` rows or a per-doc room (Durable Object SQLite, as tldraw does) |
| `docs/…/snap` | Snapshot blobs in object storage, referenced by the head |
| `heads/…` | `doc_heads` rows updated with compare-and-swap |
| `catalog.sqlite` | Postgres tables with the same schema (the local copy is a partial cache) |
| ACL, jobs, quotas | Server tables only (never in the bundle) |

**Lazy loading and performance:**
- **Open fast.** Load the head, the root doc's *shallow* snapshot, and a cached **composed-stage blob** keyed by
  `(frontier, layer versions)`. Paint from that, then hydrate the CRDT in the worker. Payload docs (pages, scenes,
  sequences) load on visibility or render scheduling.
- **Media ladder.** Thumbnail → proxy (short-GOP 720p/1080p for scrubbing) → original, which is only fetched for
  export or render. Waveforms and filmstrips are precomputed renditions. Video decodes in a worker with WebCodecs.
- **Windowed projection.** The main thread receives only nodes in the viewport or time window. Today's StaticFlux
  replicas ship the whole snapshot, which will not scale to 100k nodes.
- **Gesture coalescing.** Drags and scrubs travel on the session/presence channel and commit *one* CRDT
  transaction at gesture end. This keeps logs small.
- **Compaction.** Merge log segments into a new snapshot every N KB or on close. Old snapshots stay reachable only
  from named versions and releases (GC roots).

### 2.9 CRDT choice and granularity

**What is a CRDT:** only the composition layer docs (node tree, components, animation channels, text). Everything
else, as §2.1 says, is immutable, server-authoritative, or ephemeral.

**Granularity:** one CRDT doc per *layer* and per *payload*. A typical design is one root doc + one doc per page,
scene or long sequence + linked brand-kit / library docs.
- Docs stay small: fast load, cheap compaction.
- Permissions and sharing are per doc.
- Lazy loading and eviction follow the StaticFlux resource manager.
- Cross-doc references are plain ids.

This is the automerge-repo shape: many small documents over a KV store with range queries.

**Engine requirements:**
- per-property LWW maps;
- **movable tree** (reparent without cycles);
- **movable list** (pages, tracks);
- **rich text** with marks (Peritext-class semantics);
- per-transaction **attribution metadata** (actor, capability, invocation, traceparent);
- **versions** (frontiers / heads) with checkout and **fork** (agent proposals as branches);
- **shallow snapshots**;
- per-user **undo**;
- a server-side decoder for validation.

| Option | Pros | Cons |
|---|---|---|
| **A. Loro 1.17 adapter** behind `DocumentCRDT` | Movable tree / list, Eg-walker rich text, shallow snapshots, fork / checkout, commit messages; active (1.17.1 on 2026-10-22) | ~3.6 MB raw / 1.19 MB gzip wasm (measured), worker-only and service-worker-cached; a younger ecosystem |
| **B. Extend the StaticFlux LWW engine** | Tiny; matches Figma's proven model; already in the repo | Needs a Kleppmann tree move, a binary or columnar LWW encoding (today the LWW state is JSON inside every update, and every field is a string key), fork / versions, and rich text (Yjs `Y.Text` + format attributes) |
| C. Automerge 3.5 / Yjs 14 | Mature (Automerge), already integrated (Yjs) | No native movable tree; Yjs 14 still prerelease (npm `beta` 14.0.0-16) |

**Recommendation:** implement **A** as a second `DocumentCRDT` adapter. Run a two-week benchmark spike against
**B**, measuring:
- load time of a 50k-node doc;
- memory;
- update size of a 1k-op drag;
- merge of a 10k-op offline divergence;
- wasm boot time on mid-range Android.

Pick per measurements. In either case, presence, selection, drag previews and view state never go into the CRDT,
as the existing StaticFlux rule already says.

### 2.10 Permissions and locks

There are three different things here:

1. **Edit locks (UX).** A `Lock { scope: 'position'|'content'|'all' }` component on a node stops accidental edits.
   Anyone with edit rights can unlock it. These are Canva / Figma "lock".
2. **Policy locks (template and brand).** `final` paths on a layer, such as "brand fonts/colors" or "template
   logo". The composition engine enforces them for everyone, and the server validates them on publish and on
   sync for managed workspaces. Offline peers *can* author violating opinions locally; those opinions are
   ignored when composed and flagged. **Client gating is UX, not security** (StaticFlux rule 9).
3. **Access control.** Per **doc** and per **asset**, through server ACL roles: viewer / commenter / editor /
   owner, plus share links. The sync server refuses updates to docs the subject cannot write. When part of a
   design needs different rights (for example a locked legal footer), it goes in **its own doc**, which is a
   further argument for doc-per-layer granularity.

   Agents are a distinct subject (StaticFlux R6.17). An agent writes into a **proposal layer** by default, and a
   human accepts it. An optional policy lets trusted agents write to `local`.

   Local-first E2EE (Keyhive-style capabilities) is a later option. The model leaves room for it, because docs
   and blobs are already opaque bytes to the server.

### 2.11 Read-only, presentation, versions, publish

- **Read-only and presentation modes** are projections plus feature variants over the same composition. There is
  no copy. Comment-only is an ACL role.
- **Named versions** are a catalog row `{ doc frontiers per layer, resolved floating refs }`, and they act as GC
  roots. **History** is CRDT checkout. **Branches** are forked docs (proposals, "try a direction").
- **Publish** creates a **release**: an immutable manifest pinning
  - every doc frontier and every resolved ref;
  - a **flattened stage**: composition resolved and private brand or library layers baked in, so viewers need
    neither the composition engine nor access to private docs;
  - renditions: static HTML/SVG, PNG/PDF per page, MP4/HLS for timelines, Lottie for motion, OTIO for timelines;
  - an optional C2PA manifest.

  Share URLs point at `rel_…`. For E2EE shares, the release is encrypted and the key travels in the URL
  `#fragment` (Excalidraw). Republishing creates a new release, and the link can float to `latest`.

### 2.12 Schema versioning and migrations

- **Versions exist at four levels:**
  - bundle / workspace `format`;
  - per-record `schema` (`instaflow.asset/1`);
  - per-component `version` (tldraw-style migration sequences with ids and `dependsOn`);
  - `featuresRequired` / `featuresUsed` flags (glTF `extensionsRequired`, Penpot `components/v2`).
- **Prefer additive evolution.** New optional fields and new components. Never rename a component id or a field;
  StaticFlux already makes ids part of the persisted format.
- **Breaking changes in CRDT docs: no in-place migration while peers are live.** Two strategies:
  1. **Lenses (Cambria)** at the projection boundary during a compatibility window. Old-schema components read
     and write through a bidirectional lens, so mixed-version peers can co-edit.
  2. **Epoch migration.** The doc head records `schema` and `minReader` / `minWriter`. A migration writes a new
     snapshot in the new schema as a new epoch and archives the old log. Older clients open the doc read-only
     and get a stable error code with a fix ("update the app"). This is what tldraw's server does per session,
     moved into the head.
- **Immutable records are never migrated in place.** They are upgraded when read (`parse → migrate → validate`,
  as StaticFlux handoff `parseEnvelope` already does), and a new version is written only when content actually
  changes.

### 2.13 Illustrative schema (TypeScript)

```ts
// ---------- identity -------------------------------------------------------
export type Digest = `sha256:${string}` | `b3:${string}`;
export type WorkspaceId = `ws_${string}`;
export type AssetId = `as_${string}`;                // uuidv7
export type AssetVersionId = `av_${string}`;         // sha256 of canonical record JSON
export type DocId = `doc_${string}`;
export type NodeId = string;                         // doc-local (createIdGenerator); instance proxies "inst/src"
export type Ticks = number;                          // integer, 705_600_000 per second
export type CapabilityId = `${string}/${string}`;    // a StaticFlux capability id (typed value, not a literal)

export interface AssetRef {
  readonly asset: AssetId;
  readonly version: AssetVersionId | 'latest';       // pinned (remix, publish) or floating (brand, live library)
  readonly rendition?: RenditionRole;                // ask for a proxy instead of the original
}
export interface BlobRef { readonly digest: Digest; readonly size: number; readonly mime: string; readonly chunked?: true }

// ---------- assets (immutable records) -------------------------------------
export type AssetKind =
  | 'image' | 'video' | 'audio' | 'vector' | 'font' | 'lottie' | 'text'
  | 'composition' | 'brand-kit' | 'component-library' | 'template'
  | 'motion-preset' | 'workflow' | 'prompt' | 'dataset';

export type RenditionRole = 'thumbnail' | 'poster' | 'proxy' | 'waveform' | 'filmstrip' | 'hls' | 'flattened';

export interface AssetVersion {
  readonly schema: 'instaflow.asset/1';
  readonly id: AssetVersionId;
  readonly asset: AssetId;
  readonly kind: AssetKind;
  readonly previous?: AssetVersionId;                // version chain
  readonly createdAt: string;                        // ISO-8601
  readonly title?: string;
  readonly media?: {
    readonly width?: number; readonly height?: number;
    readonly duration?: Ticks; readonly rate?: readonly [num: number, den: number];
    readonly channels?: number; readonly sampleRate?: number; readonly colorSpace?: string; readonly alpha?: boolean;
  };
  readonly content:
    | { readonly type: 'blob'; readonly original: BlobRef }
    | { readonly type: 'crdt'; readonly root: DocId; readonly layers: readonly LayerRef[]; readonly payloads: readonly DocId[] };
  readonly renditions: readonly { readonly role: RenditionRole; readonly blob: BlobRef; readonly params?: Readonly<Record<string, unknown>> }[];
  readonly provenance: Provenance;
  readonly rights?: { readonly license: string; readonly source?: string; readonly attribution?: string };
  readonly features?: readonly string[];             // e.g. 'motion/v1', 'graph/v1'
}

export type Actor =
  | { readonly type: 'human'; readonly user: string }
  | { readonly type: 'agent'; readonly agent: string; readonly onBehalfOf: string; readonly session?: string }
  | { readonly type: 'system'; readonly service: string };

export interface Provenance {                        // C2PA-aligned vocabulary
  readonly action: 'imported' | 'captured' | 'created' | 'edited' | 'generated' | 'derived' | 'remixed';
  readonly actor: Actor;
  readonly ingredients: readonly { readonly ref: AssetRef; readonly relationship: 'parentOf' | 'componentOf' | 'inputTo' }[];
  readonly operation?: { readonly capability: CapabilityId; readonly capabilityVersion: number; readonly input: unknown };
  readonly generator?: {
    readonly provider: string; readonly model: string; readonly modelVersion?: string;
    readonly params: Readonly<Record<string, unknown>>; readonly seed?: number; readonly job: string; readonly costCredits?: number;
  };
  readonly c2pa?: BlobRef;
}

// ---------- composition: layers and arcs -----------------------------------
export interface LayerRef {
  readonly doc: DocId;
  readonly role: 'session' | 'proposal' | 'local' | 'base';
  readonly enabled: boolean;
  readonly author?: Actor;                           // proposals: who suggested
  readonly pinned?: AssetVersionId;                  // base: remix or template source version
}

// ---------- composition: ECS components (StaticFlux defineComponent) -------
// Shown as types; in code each is defineComponent('iflow/<name>', schema, { version, migrations }).
export interface Node      { kind: 'container' | 'media' | 'text' | 'shape' | 'vector' | 'instance' | 'slot' | 'step'; name: string }
export interface Hierarchy { parent: NodeId | null; order: string /* fractional key (keyBetween) */ }   // or a movable-tree op
export interface Container { layout: 'free' | 'page' | 'sequence' | 'stack' | 'track' | 'graph'; width?: number; height?: number; clip: boolean }
export interface Spatial   { x: number; y: number; w: number; h: number; rotation: number; scaleX: number; scaleY: number;
                             anchorX: number; anchorY: number; opacity: number; blend: string }
export interface Temporal  { start: Ticks; duration: Ticks }                     // placement in the parent's time
export interface Source    { asset: AssetRef; in: Ticks; out: Ticks; speed: number; reverse: boolean; loop: boolean;
                             crop?: { x: number; y: number; w: number; h: number } }
export interface Arc       { kind: 'reference' | 'inherit' | 'payload' | 'specialize'; target: AssetRef | `brand://${string}`; node?: NodeId }
export interface VariantSel{ sets: Record<string, string> }                     // { format: 'story', theme: 'dark', state: 'hover' }
export interface Style     { fill?: Paint; stroke?: Paint & { width: number }; effects?: readonly Effect[];
                             text?: TokenOr<TextStyle> }                         // values may be brand-token refs
export interface Lock      { scope: 'position' | 'content' | 'all' }             // UX lock (policy locks live in layer metadata)
export interface Slot      { name: string; accepts: readonly AssetKind[]; required: boolean; constraints?: Record<string, unknown> }

// Relationship entities (separate records, like tldraw bindings):
export interface Transition { from: NodeId; to: NodeId; preset: AssetRef; duration: Ticks; alignment: 'start' | 'center' | 'end' }
export interface AnimChannel{ target: NodeId; path: string /* 'spatial.x', 'style.fill.opacity' */;
                              keys: Record<string /* keyId */, Keyframe> }      // CRDT map: concurrent key edits merge
export interface Keyframe   { t: Ticks /* relative to target.start */; value: unknown;
                              interp: 'hold' | 'linear' | 'bezier' | 'spring'; ease?: readonly [number, number, number, number] }
export interface Motion     { in?: PresetUse; out?: PresetUse; loop?: PresetUse; text?: { unit: 'char' | 'word' | 'line'; stagger: Ticks } }
export interface PresetUse  { preset: AssetRef; duration: Ticks; params?: Record<string, unknown> }
export interface Step       { capability: CapabilityId; capabilityVersion: number; inputs: Record<string, Binding>; seed?: number }
export interface Port       { node: NodeId; name: string; dir: 'in' | 'out'; type: AssetKind | 'json' }
export interface Edge       { from: { node: NodeId; port: string }; to: { node: NodeId; port: string } }
export type Binding = { readonly type: 'edge' } | { readonly type: 'asset'; readonly ref: AssetRef } | { readonly type: 'value'; readonly value: unknown };

type TokenOr<T> = T | { readonly token: `brand://${string}` };
type Paint = { readonly color: TokenOr<string> } | { readonly gradient: unknown } | { readonly image: AssetRef };
type Effect = { readonly type: string; readonly params: Readonly<Record<string, unknown>> };
type TextStyle = { readonly font: AssetRef; readonly size: number; readonly weight: number; readonly lineHeight: number };

// ---------- heads and releases ---------------------------------------------
export interface DocHead {                            // the only mutable file per doc; CAS-updated
  readonly doc: DocId; readonly schema: number; readonly minReader: number; readonly minWriter: number;
  readonly snapshot: BlobRef; readonly logFrom: number; readonly frontier: string /* engine-encoded */;
}
export interface Release {
  readonly schema: 'instaflow.release/1';
  readonly id: `rel_${string}`;
  readonly root: AssetRef;                            // pinned
  readonly frontiers: Readonly<Record<DocId, string>>;
  readonly resolvedRefs: Readonly<Record<AssetId, AssetVersionId>>;
  readonly flattened: BlobRef;                        // the composed stage, private layers baked in
  readonly outputs: readonly { readonly kind: 'html' | 'png' | 'pdf' | 'mp4' | 'hls' | 'lottie' | 'otio'; readonly blob: BlobRef }[];
  readonly encrypted?: { readonly alg: 'AES-GCM-256' };  // key in the share URL #fragment
}
```

Example: a 3-page Instagram carousel with a video page, built from a brand template.

```jsonc
// AssetVersion av_9c41… (kind: composition)
{ "content": { "type": "crdt", "root": "doc_A",
               "layers": [ { "doc": "doc_P1", "role": "proposal", "enabled": false, "author": { "type": "agent", "agent": "copywriter", "onBehalfOf": "u_1" } },
                           { "doc": "doc_A",  "role": "local",    "enabled": true },
                           { "doc": "doc_T",  "role": "base",     "enabled": true, "pinned": "av_tmpl…" } ],
               "payloads": ["doc_pg1", "doc_pg2", "doc_pg3"] } }
// doc_A nodes (composed view):
// n0 Container{layout:'sequence'} VariantSel{format:'ig-post'}
//  ├ n1 Container{layout:'page',w:1080,h:1350} Arc{payload → doc_pg1}
//  ├ n2 Container{layout:'page'} Temporal{0, 15s} Arc{payload → doc_pg2}
//  │    └ (in doc_pg2) m1 Node{media} Source{as_clip@av_3, in 2s, out 17s} Spatial{…}
//  │                  t1 Node{text} Style{text:{token:'brand://kit_acme/class/heading'}} Motion{in:{preset: as_typewriter@latest}}
//  │                  ch1 AnimChannel{target:m1, path:'spatial.scaleX', keys:{k1:{t:0,1.0},k2:{t:3s,1.15,ease}}}   // zoom
//  └ n3 … Slot{name:'cta-image', accepts:['image']}  ← filled by an agent: Arc{reference → as_gen…@av_1}
```

---

## 3. Mapping onto StaticFlux

### 3.1 What exists and fits

| Instaflow need | StaticFlux today | Fit |
|---|---|---|
| Composition docs in a worker, projections to UI and renderer | `@staticflux/document`: ECS world (SoA), `DocumentEngine` as `ReplicableSource`, Yjs + LWW `DocumentCRDT`, `projectReplica`, presence, `CollaborationTransport` | Good core. Components = Instaflow components; `keyBetween` = fractional order; `transact` = capability transactions |
| Worker hosting, respawn, multi-tab | `@staticflux/worker`: supervised workers, replication (snapshot + patches), tab coordinator (one owner across tabs), data channels (R11.17) | Good. The document worker becomes the *workspace worker* (repo + composition engine) |
| Actions on assets for UI, palette and agents | `@staticflux/capabilities`: schema'd capabilities, gated, confirmed (agents!), metered (credits), `invocation` span | Excellent fit: every asset action is a capability. `costEstimate` / `reportCost` cover generation |
| Agents as a distinct subject | `@staticflux/webmcp` (capabilities as WebMCP tools, subject `agent`), `@staticflux/ai` | Fits proposal layers and provenance `actor` |
| Persistence | `@staticflux/storage`: `AsyncStore` (KV) with IndexedDB / OPFS / remote / tiered / encrypted middleware | Fine for catalog-like KV and heads. **Not** for blobs (see 3.2) |
| Reload, mode switches, redirects | `@staticflux/handoff`: small slots (open doc id, selection, playhead, view) | Fits as is. Documents are explicitly out of scope there |
| Renderers | `@staticflux/surface` (Canvas / WebGL / WebGPU / HTML-in-Canvas, render worker), `@staticflux/wasm` | Page / canvas / timeline renderers and the Wasm evaluator |
| Read-only and presentation variants | Variant bindings / per-mode features (rules 4, R5) | Modes as features, not branches |

### 3.2 Gaps: new primitives and package changes

| # | Change | Package | Why |
|---|---|---|---|
| 1 | **`BlobStore` port**: `put(stream, {signal}) → Result<BlobRef>` (streaming hash), `get(digest, {range, signal})`, `has`, `stat`, chunk manifests, `verify`, `pin` / `unpin` roots + `gc()`, tiering (OPFS → remote), upload / download progress | **new `@staticflux/blob`** (vertical; core + storage) | `AsyncStore` is a structured-value KV, and its OPFS adapter is string-codec, file per key, no ranges, no binary streaming. Media needs content addressing and range reads |
| 2 | **OPFS binary adapter** using `createSyncAccessHandle` in workers (range read / write), plus a **File System Access linked-folder** backend and a **zip-bundle reader** (central directory + stored entries via `File.slice`) | `@staticflux/blob` | One store layout over OPFS, a user folder, and an `.iflow` bundle |
| 3 | **`DocumentRepo`**: open / close many docs by id lazily, per-doc log + snapshot persistence (append segments, compaction, `DocHead` CAS), per-doc sync sessions, eviction under the runtime resource manager | `@staticflux/document` | Today one engine = one doc, and `snapshot()` is a full-state archive. Granular docs and incremental persistence are required at scale |
| 4 | **`DocumentCRDT` v2** ops and features: `node.move` (cycle-safe), list insert / move, rich-text marks, per-transaction `meta` (actor, capability, invocation, traceparent), `version()` / `checkout()` / `fork()` / `merge()`, shallow snapshot, undo manager hooks, a server-side decode helper | `@staticflux/document` | Hierarchy, ordering, rich text, attribution, proposals, history |
| 5 | **Loro adapter** (`loro-crdt.ts`, the only file importing Loro), benchmarked against an **LWW v2** (binary or columnar encoding; Kleppmann move) | `@staticflux/document` | §2.9. The Loro wasm (~1.19 MB gzip) goes in the worker chunk with its own budget category (R11.14-style) |
| 6 | **Component versions and migrations**: `defineComponent(id, schema, { version, migrations, lens? })`; new field types `ticks`, `ref` (typed AssetRef / NodeRef), `vec2`, `color`, `enum`, `map` (CRDT map field for keyframes); `minReader` / `minWriter` in archives | `@staticflux/document` | §2.12. Today renaming needs an archive migration and there is no mechanism for it |
| 7 | **Composition engine**: layer stacks, arcs, variant selection, `final` paths, incremental composed stage with a dependency index, `explain(node, prop)` (which layer won and why: devtools plus agent-readable) | **new `@staticflux/stage`** (vertical; depends on document) | USD-like composition is generic: any app with templates, themes, overrides or brand kits needs it. Keep Instaflow asset kinds out of it |
| 8 | **Windowed / query replicas**: replicate a *query* (viewport rectangle, time window, subtree) instead of the whole snapshot; transfer SoA columns on the data channel | `@staticflux/worker` + `document/projection` | Scaling the main thread to 100k nodes (Figma QueryGraph lesson) |
| 9 | **Long-running jobs**: a `capabilities/job` lifecycle (queued → running(progress) → succeeded / failed / cancelled), resumable across reloads (handoff slot), result = `AssetRef`; **provenance middleware** that records `operation` + `actor` on every asset a capability creates | `@staticflux/capabilities` | Generation takes minutes. Provenance must be automatic, not each feature's job |
| 10 | **Transaction attribution pass-through**: the capability `RunContext` exposes `subject`, `origin` and `invocationId` to `engine.transact(meta)` | capabilities ↔ document (via a port, no import) | Agent vs human edits, audit, per-actor undo, proposal layers |
| 11 | **Resolver port** `resolve(AssetRef | Digest) → Result<Source>` (memory → OPFS → folder → bundle → cloud signed URL), feeding `IsolationPolicy`-aware loads (R11.16b) | `@staticflux/blob` | Logical refs in docs; physical locations stay out |
| 12 | **Ephemeral gesture channel**: presence extended with "pending transaction previews", committed once at gesture end | `@staticflux/document/presence` | Keeps logs small and renders smoothly |
| 13 | Error catalog entries: `SF-BLOB-*` (digest mismatch, quota, missing blob, range unsupported), `SF-DOC-*` (schema newer than reader, cycle rejected, final-path override ignored), `SF-STAGE-*` | each package | Rule 6 |

Instaflow-specific code stays in the app or feature layer: asset kinds, components, modes, time evaluation,
motion presets, renditions, and import/export (OTIO, Lottie, SVG, PDF, MP4).

### 3.3 Thread topology

```
Main thread                     Workspace worker (SharedWorker / leader tab)        Render / media workers
───────────                     ─────────────────────────────────────────────        ──────────────────────
Lit editor per mode  ◄─query replica─  DocumentRepo (Loro/LWW docs)                   Surface (OffscreenCanvas)
capabilities registry ─intents──►      Stage (layer composition, dep index)  ──SoA──►  timeline evaluator (Wasm)
handoff (open doc,                     BlobStore (OPFS sync handles, hashing)          WebCodecs decode (proxies)
 selection, playhead)                  catalog (sqlite-wasm opfs-sahpool)              rendition / export jobs
                                       sync: CollaborationTransport per doc  ◄──► cloud (rooms + object storage)
```

---

## 4. Risks and open questions

**Risks**

1. **Composition complexity.** USD-style layering is powerful and notoriously hard to explain. Mitigations:
   - ship only the arcs in §2.4;
   - a single fixed strength order;
   - `explain()` in devtools and in the agent-facing API ("why is this text blue?").
2. **CRDT engine cost.**
   - Loro adds ~1.19 MB gzip of worker wasm (cached by the service worker, but first load and mobile memory
     matter).
   - The LWW route means owning tree-move correctness.
   - The decision needs the benchmark spike, not taste.
3. **Doc-per-payload fragmentation.** Cross-doc atomic edits (moving a node from page 2 to page 3) are not atomic
   across CRDT docs. Options:
   - a "move = copy + tombstone" pattern with a transfer id, so the move can be retried idempotently;
   - keeping a page's nodes in the root doc until the doc is large, then splitting automatically.
4. **Hashing and ingest cost.** Streaming SHA-256 of multi-GB video in Wasm takes seconds; BLAKE3 with SIMD is
   faster. Ingest must be a cancellable background task with progress (rule 5), and the asset is usable via a
   provisional id before hashing finishes.
5. **Browser storage limits.**
   - OPFS quotas and eviction: request `navigator.storage.persist()` and keep a quota-aware blob GC.
   - Safari specifics (OPFS write APIs arrived late; `createWritable` only from Safari 17 per the storage
     package's notes).
   - Sync access handles take exclusive locks. One workspace owner (the tab coordinator) is mandatory.
6. **GC correctness.** Blobs are shared across docs, versions, releases and the cloud. Mark from roots (heads,
   named versions, releases, pins) and give deletions a grace period. A wrong GC deletes user media.
7. **Locks in a local-first world.** Policy locks cannot be enforced offline. Make that explicit in the UX, and
   enforce on sync and publish server-side.
8. **Schema evolution across offline peers.** Lenses add code paths that need tests forever. Keep the
   compatibility window short, and use epoch migrations for anything structural.
9. **CRDT history bloat** from timelines (keyframe drags) and agents (bulk edits). Mitigations: gesture
   coalescing, agent edits in proposal docs (dropped when rejected), shallow snapshots for releases, periodic
   compaction.
10. **Provenance and privacy tension.** Prompts and agent transcripts can be sensitive. Prompt assets must be
    redactable without breaking ingredient links (redaction = tombstone record + hash kept).
11. **Generated-asset rights.** Model terms and licenses differ by provider. Store `rights` per version, and
    gate publish on them through `gate` policies.

**Open questions**

- Does the composed-stage cache live per device only, or is it shared in the cloud? It is a big win for
  first-open on new devices, and a cache-invalidation risk.
- Granularity default: one doc per page always, or split on size? A benchmark is needed.
- Time precision edge cases: flicks divide every common frame rate and audio rate evenly (including 192 kHz,
  which is 3,675 ticks per sample). Variable-frame-rate phone video and odd rates from generated media do not fit.
  Should ingest conform them, through proxies, or should `Source` keep a per-asset timestamp map?
- Rich text model: Loro rich text vs Yjs `Y.Text` with attributes vs a Peritext implementation. It must cover
  per-glyph animation targets (character ranges with stable anchors).
- Are workflow graphs compositions (same doc machinery, as recommended), or a separate DAG store with stricter
  execution semantics?
- Server validation depth: does the sync server decode every CRDT update to enforce `final` paths and per-doc
  ACLs, or only check them on publish? Either way the server needs the engine (Rust Loro natively, or Node wasm).
- C2PA signing keys: per workspace or per user, and who issues the X.509 certificates C2PA 2.x requires?
- Bundle default: embed all media (portable, large) vs linked (small, needs cloud), and shallow vs full history?
- How much of `@staticflux/stage` belongs in the framework vs the app? Recommendation: the framework owns
  generic layering, arcs and the dependency index; Instaflow owns the meaning of the components.

**Verification notes**

- Versions were checked on npm on 2026-10-24: `loro-crdt` 1.17.1, `@automerge/automerge` 3.5.0, `yjs` 13.6.33
  (v14 prerelease), `tldraw` 5.5.2, `@excalidraw/excalidraw` 0.18.1, `@rive-app/canvas` 2.47.0,
  `@lottiefiles/dotlottie-web` 0.81.0, `@sqlite.org/sqlite-wasm` 3.54.1-build1.
- The Loro wasm size was measured from the npm tarball: 3,595,346 bytes raw, 1,194,615 bytes gzip-9.
- UNVERIFIED in this pass:
  - Figma's image-by-hash storage;
  - Excalidraw `versionNonce` reconcile semantics;
  - Canva's internal model;
  - Framer internals;
  - Beelay;
  - exact C2PA 2.2 wording.
- Web pages could only be read through search extracts, not fetched in full.
