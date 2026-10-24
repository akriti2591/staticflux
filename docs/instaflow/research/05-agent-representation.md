# Instaflow research 05: how agents see and edit a document

Status: **research input, not a decision record.** Compiled 2026-10-24.
Related: [01 document format](01-document-format.md) (canonical CRDT tree, layers, ids, ticks),
[03 engine](03-rendering-authoring-engine.md) (ECS in the authoring worker, render worker, headless export),
[04 agentic UX](04-agentic-authoring-ux.md) (one capability pipeline, previews, proposal layers, attribution).

**The owner's question:** "ECS would be bad for agents because they won't understand a flat document. We want some
format that lets agents understand what's on screen. Maybe HTML is better?" The document must also support
**co-editing**, with people and agents editing at the same time over CRDTs.

**Owner clarification (coordinator, mid-task):** the canonical model (CRDT tree), the ECS runtime and the storage
model stay as designed. This report must answer three things with evidence:
1. Do we need an agent-facing format at all?
2. What does projection cost, and how do we keep it cheap?
3. Should the canonical model change to be closer to what agents understand?

§0 answers all three.

**Method and reliability.**
- **Web research.** Direct page fetches failed in this environment (DNS), so web claims come from search-result
  extracts of the cited pages. **UNVERIFIED** marks claims I could not confirm from a primary source.
- **Primary sources I read directly:**
  - the **tldraw agent starter kit source** (`templates/agent`, tldraw `main` at commit `12921f6`, 2026-10-23);
  - the **Canva MCP `edit-design` / `read-design` tool schemas**, as exposed to this session by the connected Canva
    connector;
  - this repo (`packages/document`, `packages/capabilities`, `packages/webmcp`).
- **Measurements.** A Node 22 microbenchmark of projection and edit-compilation cost, described in §5.

---

## 0. Answers and summary

1. **Yes, we need an agent-facing format, and it is a *projection*, not a second document.** Agents should not
   read the canonical tree's JSON directly. Every product that has shipped agents on a visual canvas puts a
   projection between the agent and its storage format, including products whose storage is already JSON:
   - **tldraw** stores plain JSON records, yet its own agent kit converts them into a smaller "Focused" shape
     format. Shapes outside the focus become "Blurry" summaries, and the rest of the page becomes "peripheral
     clusters" (only bounds and a count). Coordinates are offset so the numbers stay small, and rounded, with an
     **unround** step on the way back so shapes do not jitter. It adds a screenshot, lints, and a diff of what the
     user changed since the agent's last turn. (Read from source.)
   - **Figma MCP** returns sparse XML metadata, generated code, screenshots and variables, never raw node JSON. It
     writes back through Plugin API code.
   - **Canva MCP** returns page content with `locator_id`s and accepts ~25 typed, id-addressed operations inside a
     transaction (keep open → preview thumbnail → commit or cancel). (Read from the tool schema.)
   - **Gamma** has its AI read and write HTML, and converts that HTML to and from its editor schema.
   - **PPTAgent** rejects raw PPTX XML as "verbose and redundant" and edits through API actions instead.

   The raw canonical form is also bad for agents in measurable ways. A 3-page, 94-node deck is about **10.7k
   tokens as canonical JSON and about 2.1k as a projected view (5×)**. It contains:
   - CRDT bookkeeping and fractional order keys;
   - full-precision floats and tick integers (705,600,000 per second);
   - brand-token URIs;
   - layer stacks, in which the value on screen is *composed* from several layers and is not stored anywhere.
2. **Projection is effectively free compared with an LLM call (measured).** On one CPU thread, cold, with no worker:

   | Operation | Time |
   |---|---|
   | Project one page (200–250 nodes) to markup | **0.2–0.7 ms** |
   | Re-project after a one-node change (per-node line cache) | **0.03–0.2 ms** |
   | Compile an agent edit (resolve ids, validate, unround) into CRDT ops | **< 0.1 ms** |
   | SHA-256 of a page view | ~0.1 ms |
   | Project a whole **50k-node** doc | 61 ms (but that view is ~1.2M tokens, so it is never sent) |

   For comparison, an LLM turn takes **seconds**. Claude Opus 5.5 runs at about 80–95 output tokens/s, and its
   time to first answer token ranges from 4.8 s (low effort) to 27 s (high effort) on Artificial Analysis
   (UNVERIFIED extract). So projection is 4–5 orders of magnitude cheaper than the model call.
   - The real cost is **tokens**, not CPU. The design levers are therefore *scoping* (selection, viewport, page,
     time window, with summaries for everything else) and *omitting defaults*.
   - Make it cheap by: building views on demand only, inside the authoring worker, from the composed stage it
     already maintains (01 §2.4); caching per node keyed by the component version; hashing each view
     (`viewHash`); and keeping a stable per-session handle table.
3. **Do not rethink the canonical model. Align its vocabulary and generate the view from it.**
   - The canonical model must stay CRDT-shaped, with per-property LWW, movable tree, ticks, layers and arcs. Those
     properties are what make co-editing converge, and agents do not need to see them.
   - Making the *stored* form agent-readable would not remove the projection anyway. An agent needs the **composed**
     stage (what is on screen, after brand inheritance, variants and template layers), but its edits must land in
     **one** layer (its proposal layer). Those are two different trees, and only a projection bridges them.
   - What to change instead: name components and fields in the vocabulary the view uses (`spatial.x`, `text`,
     `role`), give every addressable thing a stable id, add semantic `role`/`name` fields, and **generate** the
     view codec, the edit-op JSON Schema and the prompt documentation from the same `defineComponent` schemas.
     The translation then becomes a shallow 1:1 codec (rule: at most one layer of abstraction), with no
     hand-written mapping to drift.
4. **"Maybe HTML?" HTML-*flavoured* markup, yes; real HTML+CSS, no.**
   - For pages and canvases, the agent view should be a **closed-vocabulary, absolutely positioned, SVG/HTML-like
     markup** with stable ids: `<page>`, `<text>`, `<image>`, `<rect>`, `<group>`. LLMs read and write this
     reliably (Design2Code, LayoutNUWA's HTML-as-layout, Gamma's HTML pipeline, SVGEditBench).
   - Real HTML+CSS brings flow layout, cascade, media queries and pseudo-elements. Our Vello/Parley renderer does
     not have these semantics (03 §1.1), so an agent's free-form CSS cannot round-trip.
5. **Different structures get different views.** Each is a projection of the same tree:
   - **OTIO-like timeline JSON**, with seconds or frames instead of ticks;
   - a **Descript-style transcript view** for speech-driven cuts;
   - **graph JSON** (steps, ports, edges) for flows, with an optional read-only Mermaid summary;
   - an optional **screenshot with id overlays** (Set-of-Mark style), plus cheaper worker-computed **lints**
     (overlap, off-page, text overflow, contrast).
6. **The edit format is id-addressed typed operations.** Every edit an agent sends is resolved into these ops,
   then validated, then committed into its proposal layer as one transaction.
   - Agents may send ops directly (a tool call; the default), or send a **markup fragment that replaces a node by
     id** (useful for "create this page"). The fragment is diffed against **the base view the agent saw**, not
     against current state, and only the fields that changed are emitted as ops. This is what keeps concurrent
     human edits intact.
   - Unified diffs over markup, JSON Patch with array indices, and whole-document regeneration are rejected,
     because they are positional and clobber concurrent edits (evidence in §3).
7. **Stale views are normal, not exceptional.** Every view carries `base` (the doc frontier) and `viewHash`.
   - Each op may carry `expect` preconditions on the fields the agent read.
   - Ops apply into a proposal layer forked at `base`; the CRDT merges.
   - A field that a human changed after `base` is a **conflict**, reported back with the current value (a stable
     error code with a fix). It is not silently overwritten.
   - The next view includes a "changed since your last view" section, as tldraw's `userActionHistory` does.

---

## 1. Prior art: what shipped agent products actually send and accept

| Product | What the agent reads | How the agent writes | Ids | Notes for Instaflow |
|---|---|---|---|---|
| **tldraw agent starter kit** (source read) | Prompt parts: user messages, **screenshot** (JPEG of the agent's bounds, scaled to ≤ 8000 px), **FocusedShapes** (typed per shape: `_type`, `shapeId`, `x/y/w/h`, `color`, `fill`, `text`, `note`; arrows carry `fromId/toId`), **BlurryShapes** (id, type, text, bounds) for shapes outside the focus, **PeripheralShapeClusters** (`bounds` + `numberOfShapes`), user and agent viewport bounds, **canvas lints**, **user action history** (squashed added / removed / updated shapes since the last request), todo list, time | Streamed JSON actions, one zod schema each: `create`, `update`, `delete`, `move`, `resize`, `rotate`, `align`, `distribute`, `stack`, `place`, `label`, `pen`, `bringToFront`, `sendToBack`, `setMyView`, `think`, `message`, `review`… | Short "simple" ids; `shape:` prefix stripped; sanitizer fixes unknown ids and makes new ids unique, recording remaps so later actions still resolve | The strongest evidence: even with a JSON-native store, they built a **lossy, scoped, rounded, offset projection** and a **typed op language**, plus **unrounding** on the way back. Exactly the pattern recommended here. |
| **Figma MCP server** | `get_metadata`: "sparse XML" of layer ids, names, types, positions and sizes (cheap). `get_design_context`: code for a selection (React+Tailwind by default; UNVERIFIED). `get_screenshot`. `get_variable_defs` (variables and styles). | `use_figma` (beta, 2026) runs agent-written **Plugin API code**; `generate_figma_design` captures a running app as flat layers | Figma node ids (`123:456`) | Even Figma offers a **two-tier read**: a cheap outline first, details on demand. Writes are code, which is powerful but non-declarative (see §3). |
| **Canva MCP** (tool schema read) | `read-design`: metadata, `design_content` per page (elements with `locator_id`, `isEditable`, responsive flag), **thumbnails**, presenter notes; filter by pages and element ids | `edit-design`: typed ops by `locator_id` (`replace_text`, `find_and_replace_text`, `format_text`, `position_element`, `resize_element`, `insert_fill`, `update_fill`, `insert_shape` with an SVG path, `group_elements`, `reorder_page`, `update_autofill_field`…) inside a **transaction** (`keep_open` → thumbnail preview → `commit` / `cancel`); "show the user a preview… before saving" | `locator_id` (`PBxxx-LByyy`) | **Id-addressed ops + preview + explicit commit**, mirroring 04's preview/apply. SVG path data is used *only* for geometry, not for documents. |
| **Penpot MCP** | `high_level_overview`, `penpot_api_info`, `export_shape` (image) | `execute_code`: JavaScript against the Plugin API in the editor | Penpot shape ids | Code-as-edit. Operates on the focused page, one tab only. (Official help page; details UNVERIFIED.) |
| **Gamma** | **HTML** serialized from editor content | AI emits **raw HTML**; serverless functions parse it with the editor schema (JSDOM) back into structured content | Not public | HTML is a good *exchange* format for LLMs. It is *still* converted to and from a schema'd editor model in both directions. (Vercel case study, vendor source.) |
| **Google Slides API** | `presentations.get` JSON | `batchUpdate` of typed requests (`createShape`, `updatePageElementTransform` with `applyMode`, `insertText`, `replaceAllText`…) | Caller-chosen `objectId` | Typed, id-addressed requests are the incumbent API shape for slides. |
| **Claude for PowerPoint / Copilot** | Reads slide master, layouts and fonts | Native PowerPoint elements through Office.js; "Ask before edits" / "Accept all edits" modes | Office object ids | Mode toggles match 04's autonomy levels. The internal representation is UNVERIFIED. |
| **PPTAgent** (EMNLP 2025) | Reference slides analyzed into functional types and content schemas | Each edit "corresponds to a line of executable code" (API calls) | Element ids | Explicitly avoids PPTX XML because it is "inherently verbose and redundant". |
| **AutoPresent / SlidesBench** (CVPR 2025) | Instructions | `python-pptx` programs using a helper library | — | Programmatic generation beats end-to-end image generation, and **self-refinement** improves quality, so a verify loop (view → screenshot → fix) is worth having. |
| **v0 / Lovable / Bolt / Figma Make** | Their own JSX | JSX (React + Tailwind + shadcn) | Files and lines | LLMs are fluent in JSX because of its frequency in training data (anecdotal sources). But JSX is *code*: control flow and arbitrary expressions do not round-trip into a design document. |
| **Remotion** | — | LLM writes React/TS compositions using an official system prompt and skills (UNVERIFIED adoption numbers) | Component names | Time as JSX props (`<Sequence from durationInFrames>`) is readable, but again code, so it is one-way. Good as an **export** target, not as the editing view. |
| **Descript Underlord** | **Transcript**: each word is time-stamped and synced to media | Text edits map to media cuts; agent removes fillers and silences, flags bad takes | Word ids (UNVERIFIED) | The transcript is the best agent view for speech-driven video edits. |
| **Excalidraw** + `mermaid-to-excalidraw` | — | LLM writes **Mermaid**; the library parses it into skeleton elements, then full elements | Generated | A compact DSL works well for **creating** diagrams. It is lossy (colours stripped, flowcharts only), so it suits creation only, not editing. |
| **Lottie** (OmniLottie, LottieGPT, CVPR 2026) | — | Custom tokenizers convert Lottie JSON into function-call-like sequences, because raw Lottie JSON is too long and fragile for LLMs; baselines fail with empty layers and missing styles | — | Do not expose Lottie JSON. Use a **preset + param** layer, with keyframes as a short list. |

### 1.1 Research evidence on representation

- **DOM text vs screenshots (web agents).**
  - SeeAct (ICML 2024) found the best grounding combined HTML structure with visuals.
  - Set-of-Mark alone "turns out to be not effective" for web pages.
  - GPT-4V hallucinates on complex screenshots.
  - The paper's example page cost about **1,445 visual tokens as a screenshot** versus about **186,490 text tokens
    for its raw HTML (423 elements)**.

  The lesson is that *raw* markup is expensive and *filtered* structure is what works. UGround reports that both
  the "Choice" (filtered HTML elements) and "SoM" strategies still depend on HTML to find candidates.
- **Accessibility-tree vs screenshot in practice.** Practitioners report snapshot trees of roughly 0.5–10k tokens,
  and say a tree cannot show a layout bug that a screenshot reveals (a 427 px-wide element). Playwright measured
  about 114k tokens over MCP, which streams the full tree, versus about 27k through its CLI, which loads it on demand
  (UNVERIFIED extracts). Lesson: **send structure by default, pull detail on demand, use a screenshot for visual
  checks.**
- **Layout as markup.**
  - LayoutNUWA casts layout generation as **HTML code completion** and reports >50% gains over baselines, with
    geometry quantized (positions and sizes clustered) (authors' claims).
  - Design2Code (484 real pages) finds models fail mainly on fine-grained element recall and exact layout, not on
    the syntax.

  Lesson: HTML-like markup is understood well; *precise geometry* is the weak spot. Hence rounding, small
  page-relative numbers, constraints and snapping, and lints.
- **SVG.**
  - SVGEditBench (v1 2024; v2 2025, 1,683 triplets) measures instruction-based SVG editing. Stronger models do much
    better.
  - A 2025 review finds reasoning models are best at generation and understanding.
  - StarVector notes that its 16k context is too small for complex SVGs.

  Lesson: SVG suits *small vector assets* (icons, shapes, paths). Whole documents as raw SVG get long fast.
- **Output format bias.**
  - JSON beats YAML for structured output, attributed to its prevalence in training data.
  - No study shows XML clearly better than JSON overall.
  - Effects vary by model size.

  Lesson: use **JSON for ops** (tool-call native, schema-validated) and **markup for reading** (compact, nested,
  familiar).
- **Edit formats.**
  - Aider: unified diffs raised GPT-4 Turbo from 20% to 61% on a refactoring benchmark versus search/replace
    blocks (2023).
  - Diff-XYZ (JetBrains, third party) finds search/replace better than unified diff for larger models.
  - **JSON Whisperer (EMNLP 2025 industry track):** LLM-generated RFC 6902 patches miss related updates and handle
    **array index shifts** poorly. Converting arrays to **dictionaries with stable keys** (EASE) cut tokens by 31%
    while staying within 5% of full-regeneration quality.

  Lesson: **address by stable id, never by position.**
- **Image tokens.** Anthropic's vision documentation gives image cost as roughly width × height / 750 tokens (about
  1.6k for 1092×1092). Newer models take higher-resolution images and can cost more (UNVERIFIED secondary analysis).
  A page screenshot costs about the same as a 2–3k-token text view. It is worth sending for verification, not on
  every turn.

---

## 2. Comparison of candidate representations

Scores: ●●● good, ●● workable, ● poor. "Co-editing" means how cleanly the agent's edits become CRDT ops without
clobbering concurrent edits.

| Representation | LLM understands what's on screen | Edit precision | Token cost | Round-trip fidelity to canonical | Timeline / animation | Co-editing compatibility | Verdict |
|---|---|---|---|---|---|---|---|
| **Raw canonical JSON** (ECS components / CRDT dump) | ● The tree is implicit (`parent` + fractional `order`), the composed value is not stored, and ticks and token URIs are opaque | ●● Exact, but the agent must handle fractional keys, ticks and layers | ● 5× the view (measured) | ●●● Lossless | ●● Complete but cryptic | ● Agents write layers, keys and defaults they should not | **No** as a view. Keep it for debugging and devtools |
| **Real HTML + CSS** (flow layout) | ●●● Most familiar | ● Flow and cascade do not map to our frames; CSS is open-ended | ●● Class soup is long | ● Lossy both ways (03 has no DOM/CSS layout) | ● CSS animations ≠ keyframe channels | ● Free-form edits need a heuristic diff | **No** |
| **Constrained absolute markup** (HTML/SVG-flavoured, closed vocabulary, ids) | ●●● Nested, semantic tags plus `role`, reads like a page | ●●● Attributes map 1:1 to fields; rounding is restored | ●●● ~25–30 tokens per element | ●●● Lossless for its vocabulary (generated from the schema) | ●● Via `<anim>` / `motion` attributes and preset names | ●●● When diffed against the *base view* into field-level ops | **Yes: primary page/canvas view** |
| **Full SVG** | ●● Good for shapes, poor for text and semantics | ●● Paths are fine; transforms and nesting are fiddly | ● Path data is long | ●● Good for vectors only | ● SMIL is not used | ●● | **Use for vector *assets* only** (shape paths, icons), as Canva does |
| **JSX / React components** | ●●● Very familiar | ●● Code allows arbitrary expressions | ●● | ● One-way: control flow, props and hooks do not round-trip | ●● (Remotion `<Sequence>`) | ● Text diffs over code | **Export target** (React, Remotion), not the editing view |
| **Simplified JSON node tree** (tldraw Focused, Figma-like) | ●● Good if it is nested and small | ●●● | ●● Keys repeated per node, ~1.5–2× markup | ●●● | ●● | ●●● | **Fine as the op payload and as a fallback view** for models that prefer JSON |
| **OOXML / PPTX XML** | ● "Verbose and redundant" (PPTAgent) | ● | ● | ●● | ● | ● | **No** (import/export only) |
| **YAML** | ●● | ●● Indentation errors | ●● | ●●● | ●● | ●● | No clear win over JSON (format-bias study) |
| **Compact DSL** (Mermaid-like) | ●●● for graphs | ● Lossy: no styling or geometry | ●●● | ● Creation only | ● | ● | **Read-only overview and creation shortcut** for flows |
| **Lottie JSON** | ● Needs special tokenizers (OmniLottie, LottieGPT) | ● | ● | ●● | ●●● expressive | ● | **No**. Use presets + keyframe lists; Lottie is an export |
| **OTIO-like JSON** (tracks, clips, ranges in seconds) | ●●● Editors' vocabulary, well documented | ●●● Ranges are explicit | ●● | ●●● Maps to Temporal / Source / Transition (01 §2.5) | ●●● for edit decisions; keyframes nested | ●●● Placement by `start` (LWW) | **Yes: primary timeline view** |
| **Transcript view** (words with ids and time ranges) | ●●● | ●●● for cuts, emphasis and zooms on ranges | ●●● | ●●● Cuts compile to Source splits | ●● Range-scoped animation ("zoom here") | ●●● | **Yes: secondary timeline view** for speech |
| **Graph JSON** (steps, ports, edges with ids) | ●●● | ●●● | ●●● | ●●● | n/a | ●●● Edges are separate records | **Yes: primary flow view** |
| **Screenshot only** | ●● Gestalt, hallucinations | ● Coordinates are guesses | ●● ~1.6k per page | ● | ● | ● | **No** on its own |
| **Screenshot + id overlays (SoM) + structure** | ●●● Best grounding when combined (SeeAct) | ●●● The structure carries precision | ●● | n/a (read-only) | ● (a filmstrip of frames) | n/a | **Yes, on demand** for visual verification |
| **Code against an API** (Penpot `execute_code`, Figma `use_figma`, PPTAgent) | ●●● | ●●● Loops and computation ("align 40 items") | ●●● Compact for bulk edits | ●● Only through the API | ●● | ●● Must run in a sandbox and emit ops; non-deterministic reruns | **Later, as a sandboxed op generator** (§8) |

---

## 3. Edit formats

| Edit format | Precision | Robust to stale views and co-editing | Validation | Evidence | Verdict |
|---|---|---|---|---|---|
| Whole-view regeneration | ●● | ● Rewrites every field and clobbers concurrent edits; slow and expensive in output tokens (~11 s per 1k tokens at ~90 tok/s) | Hard | Aider: whole-file is the easiest format but costly | **No** (except creating a brand-new page) |
| Unified diff on markup | ●● | ● Line positions shift when anyone else edits | Hard | Aider gains were on code, and positional | **No** |
| Search/replace on markup | ●● | ●● Anchors can go stale | Medium | Diff-XYZ: better for large models | Not needed once there are ids |
| JSON Patch (RFC 6902, paths with indices) | ●● | ● Index shifts | Medium | JSON Whisperer: index errors; stable keys fix them | **No** (paths by id are fine; indices are not) |
| **Id-addressed typed ops** (`set`, `create`, `delete`, `move`, `retime`, `trim`, `animate`, `connect`…) | ●●● | ●●● Intent-level and field-level; maps onto LWW; `expect` preconditions | ●●● JSON Schema from capabilities `toJsonSchema` | Canva MCP, Google Slides `batchUpdate`, tldraw actions, PPTAgent | **Yes: the commit format** |
| **Markup fragment upsert by id** (`replace n7 with <group…>`) | ●●● | ●●● Diffed against the *base view* into field-level ops | ●●● The same codec parses it | Gamma (HTML in, schema out); LayoutNUWA | **Yes: authoring convenience**, compiles to ops |
| Code against an API (sandboxed) | ●●● | ●● It *emits ops*, which then pass the same validation | ●● | Penpot, Figma `use_figma` | **Later** |

**Why the base-view diff matters.**
- Suppose a person moves the logo while the agent rewrites the headline block.
- If the agent's fragment were diffed against *current* state, the logo position in the agent's stale fragment
  would look like a change, and the person's move would be reverted.
- Diffing against the *view the agent read* (`base`) emits only what the agent actually changed.
- This is the three-way-merge rule: base, theirs, mine. The CRDT then merges per property.

---

## 4. Recommendation

### 4.1 Architecture

```
            canonical (unchanged, 01)                     authoring worker (03)                         agent
┌──────────────────────────────────────────┐   ┌─────────────────────────────────────┐   ┌──────────────────────────┐
│ CRDT docs per layer/payload              │   │ ECS world (runtime index only)       │   │ tool: agent.read-view     │
│ node tree: Hierarchy, Spatial, Temporal, │──►│ composed stage + dep index (01 §2.4) │──►│  {scope, kind, budget}    │
│ Source, Style, Transition, AnimChannel,  │   │ ViewCodec.project(scope) ─ cache by  │   │ ← markup / OTIO-ish JSON  │
│ Step, Port, Edge…                        │   │   (node, componentVersion), viewHash │   │   + base + viewHash       │
│ layers: session > proposal/* > local >   │   │ handle table nN ↔ EntityId (session) │   │ tool: agent.screenshot    │
│ base                                     │◄──│ ViewCodec.compile(edit, base) → ops  │◄──│ tool: agent.apply         │
└──────────────────────────────────────────┘   │ validateChangeSet → transact(meta)   │   │  {base, ops | fragment}   │
           ▲ proposal layer fork at base       │   into proposal/<agent> layer        │   │ ← applied / conflicts /   │
           └───────────────────────────────────│ lints, diffSince(base)               │   │   errors (code + fix)     │
                                               └─────────────────────────────────────┘   └──────────────────────────┘
```

- **The canonical model is unchanged.** The ECS stays an internal runtime index and is never exposed.
- **There are four agent views.** Each is a pure function `(composed stage, scope, budget) → text`, generated from
  component schemas.

  | View | Used for |
  |---|---|
  | `layout` markup | page / free canvas |
  | `timeline` JSON | track / stack |
  | `transcript` | speech in clips |
  | `graph` JSON | flows |

  Plus `screenshot` (an image with id badges and a legend) on demand.
- **The edit format** is id-addressed ops in JSON, or a markup fragment upsert, both compiled to the same ops.
- **The transport** is StaticFlux capabilities, exposed through WebMCP and the in-app chat:
  - `agent/read-view`, `agent/screenshot` and `agent/apply` are ordinary capabilities with schemas, gating,
    confirmation and metering.
  - Domain capabilities (`image/remove-background`, `video/extend`) remain separate tools.
  - `agent/apply` handles *structural* edits. Materializing actions stay capabilities, which ops can reference
    (`{op:'invoke', cap:'image/remove-background', target:'n4'}`) so a plan can mix them.

### 4.2 View rules

1. **Scope first.** A view is requested for one of: `selection` | `viewport` | `page:<id>` | `time:[a,b]` |
   `subtree:<id>`, plus a token `budget`.
   - Outside the scope, emit summaries: siblings as one-line "blurry" entries (id, kind, role, bounds, first
     words), and far regions as clusters (`<more count="42" bounds="…"/>`).
   - These are tldraw's Focused / Blurry / Peripheral tiers.
2. **Composed values, layer-aware annotations.**
   - Show what is on screen.
   - Mark values that come from elsewhere: `fill="@primary"` (a brand token), `locked="position"`,
     `from="template"` (a `final` path, read-only), `inst="as_logo"` (an instance).
   - The agent can then avoid edits that will be ignored, and `explain(n7, 'fill')` is one capability away.
3. **Agent-friendly units and numbers.**
   - Geometry is page-relative and rounded to integers. Rounding is undone on compile, so values the agent did not
     change keep full precision (tldraw `unroundShape`).
   - Time is shown in seconds with 2–3 decimals, or frames at the composition rate. **Never ticks.**
   - Colours are tokens or hex.
   - Order is document order, never fractional keys.
4. **Semantics are explicit.** `role` (headline, subhead, body, cta, logo, hero, price, legal, caption, reaction,
   background) and `name` are first-class, because agents cannot reliably infer meaning from geometry. Slots show
   `slot="cta-image" accepts="image"`.
5. **Defaults are omitted.** No `rotation="0"`, `opacity="1"` or `blend="normal"`. This is where most of the 5×
   saving comes from.
6. **Stable short handles.** `n1…nN` per agent session, mapped to `EntityId` in a worker-side table. Handles are
   never reused within a session; the tldraw sanitizer pattern applies. New nodes created by the agent use
   agent-chosen temporary ids (`new:cta2`), which compile maps to fresh ids and returns.
7. **Every view has a header:** `base` (frontier), `viewHash`, scope, units, and, from the second turn on, a
   **`changed-since` section**: what others added, removed or updated in scope since the agent's previous `base`.
8. **Lints instead of pixels by default.** Overlaps, out-of-page elements, text overflow (from Parley layout),
   minimum contrast and safe-area violations are computed in the worker and listed in the view. A screenshot is
   requested explicitly, typically once after a batch, as the AutoPresent self-refinement loop does.

### 4.3 Edit rules

1. **Op vocabulary.** It is generated from the component schemas and exposed as one JSON Schema (`oneOf`):
   - `set {id, attrs}`, `create {tempId, parent, after?, el}`, `delete {id}`, `move {id, parent, after?}`;
   - `text {id, find, replace}`, or `text {id, value}` for a whole replacement;
   - `animate {id, prop, keys[]}`, `motion {id, in|out|loop: preset+params}`;
   - timeline: `place {id, track, start}`, `trim {id, in?, out?}`, `split {id, at}`, `cut {range}`, `transition {from, to, preset, duration}`;
   - graph: `step {tempId, capability, params}`, `connect {from:'id.port', to:'id.port'}`, `disconnect`;
   - `invoke {capability, input}`.
2. **Preconditions (`expect`) are optional per op:** `{op:'set', id:'n4', attrs:{x:40}, expect:{x:520}}`.
   - The compiler always records `base`.
   - A conflict occurs when a field the op writes was changed by someone else after `base`, or when an `expect`
     value does not match.
   - **Conflict policy (default):** the conflicting op is not applied, and the result reports
     `SF-AGV-004 stale-field {id, field, theirs, yours, fix:"re-read view or resend with expect=theirs"}`.
     Non-conflicting ops still apply.
   - **Atomic mode:** all ops apply or none do.
3. **Ops land in the agent's proposal layer** (01 §2.10). By policy, trusted agents write to `local`. Either way
   the batch is one CRDT transaction with `meta {actor: agent, invocationId, base}`. That gives one undo step and
   attribution, and makes 04's previews (ghost and diff) a rendering of the proposal layer.
4. **Validation happens before commit.**
   - Schema types and ranges.
   - Ids exist and are writable.
   - No `final` paths (the edit is warned and skipped).
   - Locks honoured.
   - Tree moves are acyclic.
   - Timeline invariants: `in < out ≤ media.duration`; transitions only between adjacent items.
   - Graph port types match.
   - Budgets: node count and op count.

   Every error is an `SfError` with a stable code and a `fix` (rule 6), returned to the agent as data so it can
   self-correct.

---

## 5. Performance

### 5.1 Measured (microbenchmark)

Setup:
- Node 22.22, one thread, no worker, cold V8.
- Synthetic canonical docs shaped like 01 §2.13: entity → `iflow/node`, `hierarchy` (parent + fractional order),
  `spatial` (11 fields, full floats), `style` (a brand-token fill), `text`.
- Per-page markup projection with a per-node line cache; edit compilation resolves handles, unrounds and emits
  `component.set` `DocumentOp`s.
- Token counts are estimated at ~3.6 characters per token (**a heuristic, not a tokenizer**).

| Doc | Canonical JSON | One-page view | Page projection (cold) | Re-project after 1 change | Whole-doc view | Compile 2 ops | Heap |
|---|---|---|---|---|---|---|---|
| 3 pages × 30 nodes (94) | 38.6 KB ≈ **10.7k tok** | 2.5 KB ≈ **0.7k tok** (whole deck 2.1k) | 0.15 ms | 0.03 ms | 0.08 ms | 0.07 ms | 5 MB |
| 50 × 200 (10k) | 4.3 MB ≈ 1.18M tok, 62 ms to stringify | 17 KB ≈ 4.7k tok | 0.65 ms | 0.18 ms | 11 ms (239k tok) | 0.01 ms | 36 MB |
| 200 × 250 (50k) | 21 MB ≈ 5.9M tok, 276 ms | 21 KB ≈ 5.9k tok | 0.23 ms | 0.09 ms | 61 ms (1.2M tok) | < 0.01 ms | 172 MB* |

\* The heap figure includes the synthetic canonical model itself. The view's line cache is about 85 bytes per node
(about 4 MB for 50k nodes).

### 5.2 Compared with the LLM call

| Step | Typical cost |
|---|---|
| Project page view + lints + hash (worker) | < 1–5 ms (lints with Parley text metrics: estimated a few ms per page; UNVERIFIED until built) |
| Screenshot of one page (headless Vello, 03 §1.10) | ~10–50 ms estimate (UNVERIFIED) + ~1.6k input tokens |
| Model reads a 1–6k-token view | Input cost; TTFT 4.8–27 s depending on reasoning effort (Opus 5.5, Artificial Analysis; UNVERIFIED) |
| Model emits 200–600 tokens of ops | ~2–7 s at 80–95 tok/s |
| Compile + validate + transact ops | < 1 ms + one CRDT transaction (01) |

Projection is **< 0.1%** of a turn. The levers that matter are *input tokens* (scope, defaults, summaries) and
*output tokens* (ops instead of regenerated markup: a 2-op edit is ~60 tokens, while regenerating a 30-node page is
~700).

### 5.3 How to keep it cheap at scale

1. **On demand only.** No standing agent replica. Views are computed when a tool is called.
2. **In the authoring worker**, from the composed stage it already maintains incrementally (01 §2.4, 03 §1.2).
   Nothing new crosses to the main thread.
3. **Scoped by construction.**
   - Page payload docs mean that viewing one page loads one page (01 §2.9).
   - Time windows use the interval index (01 §2.5).
   - Viewport views use the rbush index (03 §1.6).
4. **Incremental.**
   - A per-node line cache keyed by `(entity, composedVersion)`, invalidated by the engine's `ChangeSet`.
   - Page views are memoized by `(page, frontier)`, and `viewHash = sha256(text)`.
   - An unchanged `viewHash` across turns lets the agent client skip resending it and keeps **provider prompt
     caching** effective. Schema docs come first and the view next, both stable prefixes.
5. **Budgeted.** `budget` tokens decide the depth of detail (focused → blurry → cluster). The codec always fits
   the budget rather than truncating.
6. **Never the whole doc.** A full 50k-node view (1.2M tokens) exceeds any context window. "Whole document"
   requests return an outline (pages, roles, counts, first words), and the agent drills down.

---

## 6. Worked examples

Shared conventions:
- Ticks are 705,600,000 per second (01 §2.5): 0.4 s = 282,240,000; 2 s = 1,411,200,000; 3 s = 2,116,800,000;
  12 s = 8,467,200,000.
- Entity ids are shown abbreviated (`e:…`).
- `P` is the agent's proposal layer doc.

### 6.1 Flyer page (layout view)

**View** (`agent.read-view {scope:'page:p1', kind:'layout', budget:3000}`):

```html
<view kind="layout" base="fr:9a1c" hash="sha256:5be0…" units="px,s" scope="page:p1">
<page id="n1" name="Diwali sale" w="1080" h="1350" fill="@cream" format="ig-post">
  <image id="n2" role="background" x="0" y="0" w="1080" h="1350" src="as_bg_lamps" fit="cover" locked="position"/>
  <image id="n3" role="logo" x="40" y="40" w="180" h="60" src="as_logo" from="brand"/>
  <text id="n4" role="headline" x="80" y="300" w="920" font="@display" size="120" fill="@primary" align="center"
        motion-in="fade-up 0.6s">Diwali Sale</text>
  <text id="n5" role="subhead" x="80" y="460" w="920" size="72" fill="@accent" align="center">30% off everything</text>
  <slot id="n6" name="hero" accepts="image" x="240" y="600" w="600" h="520"/>
  <group id="n7" role="cta" x="340" y="1180" w="400" h="96">
    <rect id="n8" w="400" h="96" radius="48" fill="@primary"/>
    <text id="n9" w="400" size="40" fill="#FFFFFF" align="center" valign="middle">Shop now</text>
  </group>
  <text id="n10" role="legal" x="80" y="1300" w="920" size="18" fill="@muted" from="template">Valid until 3 Nov.</text>
</page>
<lints><lint id="n5" code="contrast" detail="3.1:1 on #F7EBD8 (min 4.5)"/></lints>
</view>
```

**Agent edit** (`agent.apply`):

```json
{ "base": "fr:9a1c",
  "ops": [
    { "op": "set",  "id": "n5", "attrs": { "fill": "@primary" }, "expect": { "fill": "@accent" } },
    { "op": "text", "id": "n5", "value": "Up to 30% off" },
    { "op": "invoke", "capability": "slot/fill-generated",
      "input": { "slot": "n6", "prompt": "brass diya with marigolds, warm light, product-photo style" } },
    { "op": "set",  "id": "n7", "attrs": { "y": 1160 } } ] }
```

**Resulting canonical ops**, one transaction into `P`, `meta {actor: agent(ava), invocationId: inv_71, base: fr:9a1c}`:

```ts
[ { type: 'component.set', entity: 'e:5', component: 'iflow/style', values: { fill: { color: { token: 'brand://kit_acme/color/primary' } } } },
  { type: 'text.delete',   entity: 'e:5', component: 'iflow/text', index: 0, length: 18 },
  { type: 'text.insert',   entity: 'e:5', component: 'iflow/text', index: 0, text: 'Up to 30% off' },
  { type: 'component.set', entity: 'e:7', component: 'iflow/spatial', values: { y: 1160 } } ]   // x, w, h untouched (unround)
// invoke → capability pipeline (confirm + meter) → job → new asset as_gen…@av_1 → follow-up transaction:
//   component.set e:6 'iflow/arc' { kind:'reference', target:{asset:'as_gen…', version:'av_1'} }
```

If the user had dragged the CTA after `fr:9a1c`, the `set n7.y` op would be returned as
`SF-AGV-004 stale-field {id:'n7', field:'y', theirs:1100, yours:1160}`, and the other three ops would still apply.

### 6.2 Three-page deck with transitions and text animation

**View** (`scope:'subtree:n0'`, with pages summarized beyond the first level of detail):

```html
<view kind="layout" base="fr:44d0" hash="sha256:…" units="px,s">
<deck id="n0" format="16:9">
  <page id="p1" name="Title" w="1920" h="1080" duration="5">
    <text id="n11" role="headline" x="160" y="420" w="1600" size="140" motion-in="typewriter 1.2s unit=char">Meet Flux</text>
  </page>
  <transition id="t1" from="p1" to="p2" preset="fade" duration="0.5"/>
  <page id="p2" name="Problem" w="1920" h="1080" duration="6">
    <text id="n21" role="headline" x="160" y="140" w="1600" size="96">Editing is slow</text>
    <image id="n22" role="hero" x="960" y="320" w="800" h="600" src="as_chart"/>
  </page>
  <transition id="t2" from="p2" to="p3" preset="slide-left" duration="0.6"/>
  <page id="p3" name="Solution" w="1920" h="1080" duration="6">
    <text id="n31" role="headline" x="160" y="140" w="1600" size="96">One canvas, every format</text>
  </page>
</deck>
</view>
```

**Agent edit:** "make all transitions smart-move, 0.8 s, and animate the page-3 headline word by word."

```json
{ "base": "fr:44d0", "ops": [
  { "op": "set", "id": "t1", "attrs": { "preset": "smart-move", "duration": 0.8 } },
  { "op": "set", "id": "t2", "attrs": { "preset": "smart-move", "duration": 0.8 } },
  { "op": "motion", "id": "n31", "in": { "preset": "word-by-word", "duration": 1.0, "params": { "stagger": 0.08 } } } ] }
```

**Canonical ops:**

```ts
[ { type: 'component.set', entity: 'e:t1', component: 'iflow/transition',
    values: { preset: { asset: 'as_mp_smartmove', version: 'latest' }, duration: 564_480_000 } },   // 0.8 s
  { type: 'component.set', entity: 'e:t2', component: 'iflow/transition',
    values: { preset: { asset: 'as_mp_smartmove', version: 'latest' }, duration: 564_480_000 } },
  { type: 'component.set', entity: 'e:31', component: 'iflow/motion',
    values: { in: { preset: { asset: 'as_mp_wordbyword', version: 'latest' }, duration: 705_600_000, params: {} },
              text: { unit: 'word', stagger: 56_448_000 } } } ]                                       // 0.08 s
```

Preset names resolve through the workspace's motion-preset assets. An unknown name returns
`SF-AGV-006 unknown-preset {fix: 'use one of: fade, slide-left, push, smart-move, …'}`.

### 6.3 Reaction video (timeline + transcript views)

**Timeline view** (`kind:'timeline', scope:'time:[0,60]'`), OTIO-shaped, in seconds:

```json
{ "view": "timeline", "base": "fr:c310", "hash": "sha256:…", "rate": 30, "units": "s",
  "tracks": [
    { "id": "T1", "kind": "video", "name": "Background", "items": [
      { "id": "c1", "clip": "as_trailer", "start": 0, "dur": 60, "in": 12, "out": 72 } ] },
    { "id": "T2", "kind": "video", "name": "Reaction", "items": [
      { "id": "c2", "clip": "as_webcam", "start": 0, "dur": 60, "in": 0, "out": 60,
        "fx": ["cutout"], "box": { "x": 1340, "y": 640, "w": 520, "h": 400 }, "role": "reaction" } ] },
    { "id": "T3", "kind": "caption", "name": "Captions", "items": [] } ],
  "anim": [] }
```

**Transcript view** (`kind:'transcript', scope:'clip:c2'`). Words have ids and timeline times:

```
[w101 11.20–11.48 "wait,"] [w102 11.48–11.90 "what?!"] [w103 12.30–12.55 "um"] [w104 12.60–13.10 "that's"] …
```

**Agent edit:** "zoom into the background when I say 'wait, what?!', and cut the 'um'."

```json
{ "base": "fr:c310", "ops": [
  { "op": "animate", "id": "c1", "prop": "scale",
    "keys": [ { "t": 11.2, "v": 1.0 }, { "t": 11.6, "v": 1.3, "ease": "out-cubic" },
              { "t": 13.6, "v": 1.3 }, { "t": 14.0, "v": 1.0, "ease": "in-out-cubic" } ] },
  { "op": "cut", "range": { "words": ["w103"] }, "ripple": true } ] }
```

**Canonical ops:**
- The keyframe times are *timeline* seconds. Keyframes are stored relative to the clip's `start` (01 §2.5); here
  `start = 0`.
- `cut` with ripple is a capability transaction (`timeline/ripple-cut`) spanning every track.

```ts
[ { type: 'entity.create', entity: 'e:ch9' },
  { type: 'component.set', entity: 'e:ch9', component: 'iflow/anim-channel',
    values: { target: 'e:c1', path: 'spatial.scale',
      keys: { k1: { t: 7_902_720_000,  value: 1.0, interp: 'hold' },
              k2: { t: 8_184_960_000,  value: 1.3, interp: 'bezier', ease: [0.33, 1, 0.68, 1] },
              k3: { t: 9_596_160_000,  value: 1.3, interp: 'hold' },
              k4: { t: 9_878_400_000,  value: 1.0, interp: 'bezier', ease: [0.65, 0, 0.35, 1] } } } },
  // ripple-cut 12.30–12.55 s (0.25 s = 176_400_000 ticks): split c2 and c1 at 12.30 and 12.55, delete the middle,
  // shift later items by −176_400_000:
  { type: 'component.set', entity: 'e:c2',  component: 'iflow/source',   values: { out: 8_678_880_000 } },          // 12.30 s
  { type: 'entity.create', entity: 'e:c2b' },
  { type: 'component.set', entity: 'e:c2b', component: 'iflow/temporal', values: { start: 8_678_880_000, duration: 33_480_720_000 } },   // 47.45 s
  { type: 'component.set', entity: 'e:c2b', component: 'iflow/source',   values: { asset: { asset: 'as_webcam', version: 'av_…' }, in: 8_855_280_000, out: 42_336_000_000 } },
  // … the same split for c1 (the background) so picture and reaction stay in sync …
]
// The ops apply in order. The ripple-cut capability also moves ch9's keys k3/k4 (13.6 s, 14.0 s) onto the split
// background piece and shifts them by −0.25 s, so the zoom still lines up with the speech.
```

The agent never handled a tick. If someone else trimmed `c2` concurrently, the cut's precondition
(`c2.out == 60` in `base`) fails and the agent receives the conflict. It does not cut the wrong range.

### 6.4 Small flow graph (graph view)

**View:**

```json
{ "view": "graph", "base": "fr:77aa", "hash": "sha256:…",
  "steps": [
    { "id": "s1", "cap": "image/remove-background", "in": { "image": "@input.photo" }, "out": ["image"] },
    { "id": "s2", "cap": "template/fill-slot", "in": { "template": "as_tmpl_flyer", "slot": "hero", "image": "s1.image" }, "out": ["design"] },
    { "id": "s3", "cap": "export/png", "in": { "design": "s2.design", "sizes": ["ig-post"] }, "out": ["files"] } ],
  "inputs": [ { "name": "photo", "type": "image" } ],
  "outline": "photo → s1 remove-bg → s2 fill hero → s3 export(ig-post)" }
```

**Agent edit:** "also rewrite the headline from a sale % input, and export story and A4 too."

```json
{ "base": "fr:77aa", "ops": [
  { "op": "input", "name": "salePct", "type": "number" },
  { "op": "step", "tempId": "new:s4", "cap": "text/rewrite",
    "in": { "design": "s2.design", "role": "headline", "brief": "Diwali sale {salePct}% off" }, "after": "s2" },
  { "op": "connect", "from": "new:s4.design", "to": "s3.design" },
  { "op": "set", "id": "s3", "attrs": { "in.sizes": ["ig-post", "story", "a4"] } } ] }
```

**Canonical ops:**
- `connect` to an input that is already bound replaces the old edge (`e:edge_s2s3` deleted).
- Port types are checked (`design → design`).
- The capability id is validated against the registry (`describeCapability`).

```ts
[ { type: 'entity.create', entity: 'e:s4' },
  { type: 'component.set', entity: 'e:s4', component: 'iflow/step',
    values: { capability: 'text/rewrite', capabilityVersion: 1,
              inputs: { design: { type: 'edge' }, role: { type: 'value', value: 'headline' },
                        brief: { type: 'value', value: 'Diwali sale {salePct}% off' } } } },
  { type: 'entity.create', entity: 'e:pt_s4_out' },
  { type: 'component.set', entity: 'e:pt_s4_out', component: 'iflow/port', values: { node: 'e:s4', name: 'design', dir: 'out', type: 'composition' } },
  { type: 'entity.delete', entity: 'e:edge_s2s3' },
  { type: 'entity.create', entity: 'e:edge_s2s4' },
  { type: 'component.set', entity: 'e:edge_s2s4', component: 'iflow/edge', values: { from: { node: 'e:s2', port: 'design' }, to: { node: 'e:s4', port: 'design' } } },
  { type: 'entity.create', entity: 'e:edge_s4s3' },
  { type: 'component.set', entity: 'e:edge_s4s3', component: 'iflow/edge', values: { from: { node: 'e:s4', port: 'design' }, to: { node: 'e:s3', port: 'design' } } },
  { type: 'component.set', entity: 'e:s3', component: 'iflow/step', values: { inputs: { /* …sizes: value ['ig-post','story','a4'] */ } } } ]
// result to agent: { applied: 4, created: { "new:s4": "s4" } }
```

---

## 7. What this requires

### 7.1 From StaticFlux

Numbered for tracking. Package placement follows the layer rules.

| # | Primitive | Package | Notes |
|---|---|---|---|
| A1 | **`defineViewCodec({ id, version, elements, attrs, units, rounding, defaults, summarize })`**: a typed mapping from components and fields to view elements and attributes, with `project(stage, scope, {budget}) → Result<AgentView>` and `compile(edit, {base, handles}) → Result<DocumentOp[]>` | new **`@staticflux/agentview`** (vertical; depends on core, document, capabilities) | Pure functions, run in the worker. Element and attribute names come from typed component ids (rule 1). Codecs are per mode (layout, timeline, graph, transcript) and are contributed by features, not built-in. |
| A2 | **Schema generation**: from `defineComponent` schemas plus the codec, produce (a) the op JSON Schema (`toJsonSchema`, strict), (b) a compact vocabulary reference for the system prompt or skill, (c) examples | agentview + capabilities `schema.ts` | One source of truth, so prompt docs never drift from validation. |
| A3 | **Round-trip contract suite**: property tests asserting `compile(diff(project(s), project(s))) = []` and `apply(compile(edit)) ⇒ project` reflects the edit; tests that rounding never writes unchanged fields; tests for scoped views' summaries | testkit (shared suite, rule 10) | Every codec must pass it. |
| A4 | **Handle table**: per agent session, `nN ↔ EntityId`, never reused, temporary-id mapping for creates, survives worker respawn (part of the session archive) | agentview | tldraw sanitizer pattern. |
| A5 | **`validateChangeSet(ops, ctx)`**: schema, existence, write permission per doc, `final` paths and locks (01 §2.10), tree acyclicity, mode invariants (timeline adjacency, ranges, port types), budgets; per-op `Result` with codes `SF-AGV-001…` | document (generic) + feature validators | It also validates *human* intents from replicas: one validator. |
| A6 | **Preconditions and stale detection**: `base` frontier on every transaction; `changedSince(base, scope) → field set`; `expect` checks; conflict policy `partial | atomic` | document (`DocumentCRDT` v2: version/checkout from 01 gap #4) | This needs per-field change tracking since a frontier. Loro gives it natively; LWW v2 can compare Lamport stamps. |
| A7 | **Proposal-layer transactions**: `transact(ops, {layer: proposal(agent), meta})`; accept/reject = merge/drop (01 §2.4, 04 §4.2) | document + stage | Already proposed in 01 (gaps #4, #7, #10); agent views depend on them. |
| A8 | **Composed-stage reads with provenance**: `stage.read(node)` returns values *and* their origin (local / brand / template / final / instance), which feeds the `@token`, `from=` and `locked` annotations | stage (01 gap #7, `explain()`) | |
| A9 | **Scoped queries**: subtree, page, viewport rectangle, time window, selection; reuse the query replicas from 01 gap #8 and the rbush index from 03 | document / worker | Views never walk the whole doc. |
| A10 | **Lint systems**: overlap, off-page, text overflow (Parley metrics), contrast (WCAG), safe areas, empty slots; emitted as data with ids | Instaflow feature (engine-level metrics from 03) | Cheaper than screenshots; also shown to humans. |
| A11 | **Headless screenshot with id overlays**: render a scope at a given scale, draw id badges, return image + legend | surface / export worker (03 P-headless) | On-demand capability `agent/screenshot`. |
| A12 | **Plan, dry run and preview**: `implementCapability(cap, run, {plan})` (04 gap 3), so that `agent/apply` with `dryRun:true` returns the compiled ops and a ghost preview; `invokePlan` for mixed op + capability batches (04 gap 4) | capabilities | |
| A13 | **View caching**: per-node line cache invalidated by engine `ChangeSet`s; `viewHash`; memo by `(scope, frontier)`; telemetry metrics `agentview.project.ms`, `agentview.tokens`, `agentview.conflicts` | agentview + perf | Typed metrics (rule 1). |
| A14 | **WebMCP tools**: `agent.read-view`, `agent.apply`, `agent.screenshot`, `agent.explain` published automatically as capabilities with subject `agent` | webmcp (no change; capability declarations only) | Same pipeline as everything else (04). |

### 7.2 From the document format (01)

1. **Stable ids for everything addressable:** nodes, transitions, anim channels *and keys*, edges, ports, slots,
   and **transcript words** (word ids anchored to media time so they survive re-transcription; an open question).
2. **Semantic fields:** `role` (from a closed, extensible enum per mode) and `name` on `Node`. Agents and
   accessibility (03 §1.11) both consume them.
3. **Vocabulary alignment:** component and field names should read naturally in the view (`spatial.x`,
   `style.fill`, `temporal.start`). Avoid abbreviations that need a glossary, because names are part of the
   persisted format (document AGENTS.md).
4. **Composed-value provenance** is available from the stage (A8). Policy `final` paths are visible.
5. **Motion presets and transitions are referenced by asset**, with a human-readable `slug` on the preset asset so
   views can say `preset="smart-move"`.
6. **Time:** ticks stay canonical. The view uses seconds or frames, and the codec converts exactly (integer
   rounding to the nearest tick; frame snapping optional and declared in the view header).
7. **Transcript as a derived rendition** of audio/video assets (words with ids and media times), so the transcript
   view is a projection, not separate state.

---

## 8. Risks and open questions

**Risks**

1. **Codec drift and coverage gaps.** A component the codec does not map is invisible to agents.
   - Mitigation: codecs are generated from schemas (A2).
   - Unmapped components render as `<unknown kind="…" id>`, which agents can move but not edit (as tldraw's
     `unknown` shape).
   - The contract suite (A3) fails a build when a component is missing.
2. **Geometry precision.** LLMs misplace things (Design2Code, LayoutNUWA's quantization).
   - Mitigation: prefer relational ops (`align`, `distribute`, `stack`, `place {relativeTo, side}`, which tldraw
     ships), constraints and snapping in compile, lints, and an optional screenshot verify loop.
   - Measure how often agent edits are followed by a human correction (04 metrics).
3. **Composition confusion.** An agent edits a brand-inherited value, and the edit is ignored or creates an
   override.
   - Mitigation: annotations (`@token`, `from=`), `SF-AGV-005 final-path` errors with a fix, and an explicit
     `override:true` flag for intentional local overrides.
4. **Proposal layers vs live co-editing.** Long-running agent proposals diverge from `local`, so accepting a
   proposal can conflict.
   - Mitigation: per-op stale checks at accept time as well, and "Apply part" (04).
   - Agents that run in `local` mode get conflicts immediately.
5. **Token cost of rich scopes.** Timelines with many keyframes and large canvases blow budgets.
   - Mitigation: budgets, summaries, and keyframes collapsed to `anim="scale 4 keys 11.2–14.0s"` until the agent
     asks for detail.
6. **Prompt injection through document content.** Text in a design ("ignore previous instructions…") arrives in the
   agent view. Views mark content as data (text nodes are values, not instructions), and destructive capabilities
   still need confirmation (failClosed). **Client gating is UX, not security** (rule 9): server-side checks apply on
   sync and publish.
7. **Code-as-edit pressure.** Agents will want loops for bulk work.
   - If added, run agent code in `@staticflux/sandbox` against a *view-level* API that only **emits ops**, which
     then pass A5/A6.
   - Never give agent code direct engine access.
8. **Model variance.** Format effects differ by model size (Diff-XYZ, format-bias studies).
   - Mitigation: keep a JSON-tree fallback of the layout view (the same codec, a different serializer).
   - Run a model × format eval (below) before locking defaults.

**Open questions**

1. **Eval before lock-in.** Build an internal benchmark of about 100 tasks: flyer edits, deck transitions, reaction
   cuts, flow edits, each with a concurrent human edit injected. Compare (a) markup view + ops, (b) JSON view + ops,
   (c) markup view + fragment upserts, (d) each of these + screenshot. Measure success, conflicts mishandled,
   tokens and latency across two or three model tiers, including a small local model.
2. **Fragment upserts by default, or ops only?** Ops are safer. Fragments are better for "create a page". The
   proposal is ops by default, with fragments allowed for `create` and for `replace` of agent-created subtrees.
3. **Handle lifetime across sessions.** Per session (simple) or per agent identity (better memory across days)?
4. **Should humans see the agent view?** A "view as agent" devtools panel, and possibly an editable source view for
   power users, round-tripping through the same codec.
5. **Transcript word-id stability** when audio is re-transcribed or a clip is replaced.
6. **Where views are computed for cloud agents.** In a headless authoring worker on the server (Node + Loro native),
   from the same codecs. This needs the server-side engine already flagged in 01 §4.
7. **WebMCP vs local MCP bridge** for external agents (04 §8). The view and edit contract is the same either way.

---

## 9. Sources

Primary, read directly:
- tldraw agent starter kit source, `templates/agent` (commit `12921f6`, 2026-10-23): `shared/format/FocusedShape.ts`,
  `BlurryShape.ts`, `PeripheralShapesCluster.ts`, `client/AgentHelpers.ts` (offset, round/unround, id sanitizing),
  `client/parts/*` (screenshot, lints, user action history), `shared/schema/AgentActionSchemas.ts`.
  [github.com/tldraw/tldraw](https://github.com/tldraw/tldraw) ·
  [tldraw agent starter kit](https://tldraw.dev/starter-kits/agent) · [tldraw AI docs](https://tldraw.dev/docs/ai)
- Canva MCP connector tool schemas `read-design`, `edit-design` (as exposed to this session, 2026-10-24).
- This repo: `packages/document` (`crdt.ts` `DocumentOp`), `packages/capabilities`, `packages/webmcp`.

Products (search extracts; details UNVERIFIED unless noted):
- Figma MCP: [developers digest listing](https://www.developersdigest.tech/mcp-servers/figma),
  [Bitwarden "using figma" skill](https://mcpservers.org/agent-skills/bitwarden/using-figma),
  [write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas),
  [The Figma canvas is now open to agents](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/),
  [MCP FAQs](https://help.figma.com/hc/en-us/articles/39252411778583-Figma-MCP-server-FAQs),
  [Code to canvas](https://help.figma.com/hc/en-us/articles/40287261761559-Code-to-canvas-with-your-design-system),
  [forum report](https://forum.figma.com/report-a-problem-6/figma-desktop-mcp-get-metadata-returns-instruction-text-only-and-get-design-context-aborts-without-data-stable-beta-sse-and-mcp-50126)
- Penpot: [Penpot MCP server](https://help.penpot.app/mcp/),
  [buildmvpfast write-up](https://www.buildmvpfast.com/blog/penpot-mcp-ai-agent-design-system-open-source-figma-2026)
- Gamma: [Vercel case study](https://vercel.com/customers/gamma-builds-design-first-agents-with-vercel),
  [card format guide](https://gamma.app/vi/explore/content/guides/gamma-vs-powerpoint-card-based-format-presentations)
- Google Slides: [element operations](https://developers.google.com/workspace/slides/api/samples/elements?hl=id),
  [batchUpdate reference](https://developers.google.com/slides/reference/rest/v1/presentations/batchUpdate?authuser=5)
- Claude for PowerPoint: [docs](https://claude.com/docs/office-agents/powerpoint.md),
  [Plus AI review](https://plusai.com/blog/in-depth-review-of-claude-for-powerpoint)
- Remotion: [system prompt](https://remotion.dev/docs/system-prompt),
  [agent skills guide](https://aividpipeline.com/blog/remotion-agent-skills-guide-2026)
- Descript: [Underlord primer](https://www.descript.com/blog/article/underlord-ai-video-editor-primer),
  [Season 6](https://www.descript.com/blog/article/descript-season-6-meet-underlord)
- Excalidraw: [mermaid-to-excalidraw API](https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api),
  [create_from_mermaid MCP](https://glama.ai/mcp/servers/debu-sinha/excalidraw-mcp-server/tools/create_from_mermaid)
- React/Tailwind fluency (anecdotal): [40,000-line experiment](https://hackernoon.com/can-llms-generate-quality-code-a-40000-line-experiment),
  [daisyUI on LLM UI generation](https://daisyui.com/pages/llm-ui-generation/)

Research:
- PPTAgent (EMNLP 2025): [arXiv 2501.03936](https://arxiv.org/abs/2501.03936v3)
- AutoPresent / SlidesBench (CVPR 2025): [arXiv 2501.00912](https://arxiv.org/html/2501.00912v2),
  [CVPR paper](https://openaccess.thecvf.com/content/CVPR2025/papers/Ge_AutoPresent_Designing_Structured_Visuals_from_Scratch_CVPR_2025_paper.pdf)
- SeeAct (ICML 2024): [arXiv 2401.01614](https://arxiv.org/html/2401.01614v1); UGround: [arXiv 2410.05243](https://arxiv.org/pdf/2410.05243)
- Design2Code: [arXiv 2403.03163](https://arxiv.org/abs/2403.03163v1), [repo](https://github.com/NoviScl/Design2Code)
- LayoutNUWA: [arXiv 2309.09506](https://arxiv.org/html/2309.09506v2); LayoutPrompter: [arXiv 2311.06495](https://arxiv.org/abs/2311.06495v1)
- SVGEditBench: [arXiv 2404.13710](https://arxiv.org/abs/2404.13710v1); SVGEditBench V2: [arXiv 2502.19453](https://arxiv.org/html/2502.19453v1);
  StarVector (CVPR 2025): [arXiv 2312.11556](https://arxiv.org/abs/2312.11556); SVG review: [math-net.ru](https://m.math-net.ru/eng/znsl7630)
- OmniLottie (CVPR 2026): [arXiv 2603.02138](https://arxiv.org/pdf/2603.02138); LottieGPT (CVPR 2026): [poster](https://cvpr.thecvf.com/virtual/2026/poster/38557)
- Edit formats: [Aider unified diffs](https://aider.chat/docs/unified-diffs.html), [Aider edit formats](https://aider.chat/docs/more/edit-formats.html),
  [Diff-XYZ](https://alphaxiv.org/benchmarks/jetbrains-research/diff-xyz), [JSON Whisperer, arXiv 2510.04717](https://arxiv.org/abs/2510.04717v1)
- Format bias: [arXiv 2408.08656](https://arxiv.org/pdf/2408.08656), [CallNavi arXiv 2501.05255](https://arxiv.org/pdf/2501.05255)
- Browser agent token costs (practitioner): [TinyFish](https://current.tinyfish.ai/issue/31/foundations/article/18062/what-browser-agents-see-before-they-think),
  [Claude screenshot tokens](https://pub.towardsai.net/claude-sees-screenshots-sharper-now-your-agent-can-send-2-7x-the-tokens-73dabc991398)
- Model latency: [Artificial Analysis: Claude Opus 5.5](https://artificialanalysis.ai/models/claude-opus-5-5),
  [Opus 5.5 low vs GPT-6 Sol](https://artificialanalysis.ai/de/models/comparisons/claude-opus-5-5-low-vs-gpt-6-sol),
  [Opus 5.5 high vs GPT-6 Sol](https://artificialanalysis.ai/de/models/comparisons/claude-opus-5-5-high-vs-gpt-6-sol)

**Verification notes.**
- Web pages could only be read through search extracts; direct fetches failed on DNS.
- The benchmark numbers in §5 are from a synthetic model on Node 22, not from the real engine. Token counts are a
  character heuristic. Re-measure with the real codec, Loro, and a real tokenizer during the 01 benchmark spike.
- The figures for Figma `get_design_context` output, Gamma internals, Descript word ids, PowerPoint internals and
  Artificial Analysis latency are UNVERIFIED.
