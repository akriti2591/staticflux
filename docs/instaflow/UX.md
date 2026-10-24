# Instaflow — UX

> Status: **draft for owner review** (2026-10-24). Normative for IF-12 and IF-13. Adapted from
> [research 04](research/04-agentic-authoring-ux.md) for **Chrome desktop only**: report 04's mobile and PWA-touch
> sections are dropped. [DECISIONS.md](DECISIONS.md) is authoritative. **A UX researcher is needed** to run §8
> before M2 locks the HUD.

## 1. Principles

1. **The asset is the interface.** Select something and its actions come to it. There are no permanent tool
   panels for features you are not using, and capabilities that do not apply are not shown.
2. **Say it or tap it: the same action.** HUD buttons, command-bar results, chat requests and agent calls run the
   same capability with the same preview, undo and trace.
3. **Preview before commit, undo after commit.** Generative, bulk and agent changes preview first (ghost, diff,
   takes). Every commit is one labelled undo step.
4. **Generated media is editable media.** Output lands as layers, clips or nodes. Regenerating a part is a HUD
   action on that part.
5. **One document, four lenses.** Pages, Canvas, Timeline and Flow keep the same selection, undo and chat.
6. **Calm by default, dense on demand.** Focus, Standard and Pro densities. The canvas has ≥ 85% of the viewport
   in Focus. Persistent UI docks, transient UI floats (the Figma UI3 lesson).
7. **Agents are visible collaborators.** Name, color, cursor, status, held elements and a log. You can pause,
   stop, reject or take over.
8. **Your work lives on your device.** It opens offline, there is no spinner for your own data, it is always
   saved, and it exports to an open file.
9. **Daily jobs before demos.** Every HUD slot traces to a ranked job from research (§8.6).
10. **Keyboard-complete and accessible.** Every canvas action is reachable by keyboard and screen reader. Nothing
    is drag-only.

## 2. Interaction model: HUD × command bar × chat

| | **Contextual HUD** | **"Say what you need" bar** (`Mod+K`) | **Chat** (docked) |
|---|---|---|---|
| Question it answers | "What can I do *to this*?" | "Do *X* (to this)." | "Help me make or iterate *something bigger*." |
| Scope | The selection (element, range, clip, page gap, node) | The selection if any, else the document | The project, multi-step |
| Output | Immediate (deterministic) or previewed (generative) | **One** capability call with filled params, or a hand-off to chat | A **plan** of capability calls and change sets, previewed as a batch |
| Speed | Appears in 0 ms; acts in ≤ 100 ms | ≤ 50 ms local results; model-ranked within budget | Streams; never blocks the canvas |

**Escalation.** The HUD shows 5–7 actions. **More** opens the command bar pre-filtered to the selection. Typing
turns it into natural language. When a request needs more than one capability or is ambiguous, the bar says
"This needs a plan — continue in chat" and carries the text and selection over. **De-escalation:** after chat
applies a plan, the result is selected and the HUD shows refinements (Try again, Tone, Extend), so people learn
the buttons from the chat.

**HUD anatomy** (a `toolbar` surface, SF-Δ21):

- **Placement:** a pill above the selection, or below it if there is no room. It snaps to the top edge for large
  selections.
- **Contents:**
  1. type chip (*Text · Headline*);
  2. 3–5 fixed direct manipulations (font, color, align / trim, speed / crop, mask);
  3. 1–2 ranked ✦ generative actions;
  4. **Animate**, for everything animatable;
  5. `⋯ More`;
  6. `✦ Ask`.
- **Stability:** slots 1–2 and Animate are fixed per element type. Ranked slots change at most once per selection
  and never while the HUD is open.
- **Multi-select:** the intersection of applicable actions, plus Align, Distribute, Group, Make variants and Turn
  into flow.
- **Ranges** (a timeline range, a transcript span, a text span, the **gap between pages**) are first-class
  selections with their own HUD.
- **Ranking seed** (before data):
  1. pinned manipulations;
  2. a continuation of the last action on a similar selection (local Markov);
  3. lineage actions on generated media (Extend, Regenerate, Variants);
  4. lens-specific actions (Timeline: Split, Zoom here; Pages: Transition, Animate);
  5. the user's flow units.

  Ties go to deterministic actions.

## 3. Layout and panel inventory

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ Instaflow · Diwali flyer ▾  ● Saved   [Pages|Canvas|Timeline|Flow]   ◉◉ agents   ▶  Export │ 44 px top bar
│                                                                          ┌ right dock ─────┐│
│            ┌── HUD ───────────────────────────────────────────┐          │ Layers          ││
│            │ Text·Headline  Aa  ■  ≡ │ ✦Rewrite │ Animate │ ⋯ │ ✦Ask │          │ Properties (Pro)││
│            └──────────────────────────────────────────────────┘          │ Chat            ││
│                         ┌──────────────────┐                             │ Comments        ││
│                         │   [ selected ]   │                             │ Assets          ││
│                         └──────────────────┘                             │ History & Miles.││
│                                                                          │ (extension tabs)││
│  ⟲ ⟳             ( ✦ Say what you need…  ⌘K )                   100% ±   └─────────────────┘│
│ ───────────────────────────────────────────────────────────────────────────────────────── │
│  ▭▭▭▭ bottom tray: filmstrip (Pages) · tracks (Timeline) · hidden (Canvas, Flow)           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Persistent, docked:**

- **Right dock, tabbed, resizable, collapsible to an icon rail:**
  - **Layers**: outline and z-order, lock and visibility, ✦ badges on generated items;
  - **Properties** (Pro only): precise numbers, `explain` for inherited values;
  - **Chat**: agent log, plans, Apply and Reject;
  - **Comments** (when comments ship);
  - **Assets / Library**: workspace assets, brand kits, templates, motion presets, flows;
  - **History & Milestones**: the actor log with Undo and Show diff, milestones with create, pin, open
    read-only, compare side by side and New document from milestone;
  - **extension panels** (D7).

  Two tabs can be split vertically in Pro.
- **Bottom tray**, depending on the lens: the filmstrip (Pages) or the track area (Timeline). It can be resized and
  collapsed.

**Transient, floating:** HUD, command bar, context menus, previews (ghosts, before/after, takes, diffs), toasts,
agent cursors and status, presence ghosts, coach marks.

**Dialogs:** only **Share/Export** (routable `/d/share`, gated before content loads) and the model-key setup. All
other confirmations are **inline**, for example "Delete 12 clips? Confirm · Cancel" in the HUD row, or the agent
client's own confirmation for WebMCP.

**Density** (shell workspaces, remembered per device):

| Level | Shows |
|---|---|
| **Focus** (default for new users) | Top bar, HUD, command bar. The dock is collapsed to a rail. |
| **Standard** | + one dock tab open on demand, plus the bottom tray |
| **Pro** | + Properties, split dock, keyboard hints in the HUD, rulers |

**Visual language:** one accent color for generative (✦), neutral greys elsewhere, and agent colors from a
separate palette. Motion is 120–200 ms, respects reduced motion, and lens switches use View Transitions that morph
the selection into place.

## 4. Lenses and modes

| Lens | What it really is | Primary selections | Switch moment |
|---|---|---|---|
| **Pages** (`1`) | The story: pages in order | Element, page, **gap between pages** | "Show this deck as video" → Timeline |
| **Canvas** (`2`) | Pages at their canvas positions plus loose elements | Element, region | "Turn these frames into pages" → Pages |
| **Timeline** (`3`) | The story in time: pages as clips, page transitions, tracks, story audio | Clip, range, word, keyframe | "Edit this clip's frame" → Canvas, focused |
| **Flow** (`4`) | Workflows: steps and edges; also the lineage view | Step, edge, unit | "Where did this image come from?" → Lineage |

- Selection, undo, chat and the HUD persist across lenses. The HUD only gains or loses lens actions.
- Any document opens in any lens. A static flyer in Timeline is a single 5 s page, which is useful for "animate
  this".
- **Read-only mode** (milestones, read-only documents): the same canvas, no editing capabilities. The HUD shows
  Copy, Export and New document from milestone. A banner names what you are looking at ("Milestone 'Client v2' ·
  24 Oct").
- **Presentation mode** (`▶`): full screen, no chrome, pages with transitions and on-click builds, timelines as
  video, flows as App view. Presenter view in a second window shows notes, the next page and a timer. Reduced
  motion swaps transitions for fades.

## 5. Agent UX

- **Autonomy** per agent per document (in the chat header): **Suggest**; **Auto-apply safe** (default:
  non-destructive edits apply as undoable steps, while generation, deletions and bulk edits over 20 nodes preview);
  **Autopilot** (bounded by an op count, a generation count and a time box, with live progress, stopping at
  destructive steps).
- **Proposals:** ghosts at 60% opacity with dashed outlines, before/after sliders, A/B/C takes, text diffs,
  timeline diffs (added clips hatched, cut ranges red) and graph diffs. A plan lists its steps with checkboxes.
  **Apply**, **Reject** and **Apply part** (click any ghost) are always present. Proposals are shared, so other tabs
  see them too.
- **Conflicts:** an op whose target someone changed meanwhile shows a split chip "yours / agent's". The default is
  to keep yours. Stale ops reported back to the agent appear in the chat log as "skipped: Priya moved the CTA".
- **Attribution:** the History tab reads like a log: *"Ava (agent · Claude) rewrote headline · via chat · Undo ·
  Show diff"*. Generated items carry ✦ and a recipe.
- **Undo:** `Mod+Z` undoes **your** last step only. Agent steps are undone from the History tab or the agent chip.
  **Reject agent session** reverts everything since your last approval and names conflicts.
- **Presence:** an agent avatar chip in the top bar, a named cursor with a status line ("Generating take 2/3…"), a
  highlight on held elements (soft locks: you can still override), and **Pause / Stop / Take over**. Stop aborts
  in-flight work. External WebMCP agents show the client's name and an "external" badge.
- **No model configured:** generative slots read "✦ Connect a model". Everything deterministic works.

## 6. The owner's five scenarios

Legend: **[H]** HUD, **[B]** command bar, **[C]** chat, **[A]** agent through WebMCP. Each flow is an e2e test
against mock providers (IF-1.5).

### A. Campaign flyer

1. Home → **New: Flyer** (intent tiles: Flyer, Post, Deck, Video, Reaction, Flow) → format chip (A4, IG post,
   Story).
2. **[C]** "Flyer for our Diwali sale, 30% off, warm colours, our logo." The agent proposes **3 layout variants**
   as side-by-side ghosts. Tap one → Apply. One undo step: *"Ava: created flyer (variant B)"*.
3. Tap the headline → **[H]** `Text · Headline`: font, size, colour, **✦ Rewrite** (tone dial), **Animate**.
4. Tap the hero image → **[H]** crop, filter, **✦ Remove background**, **✦ Replace…**, **✦ Vectorize**.
5. **[B]** "make versions for Instagram story and A4 print" → `resize/variants` → a grid preview of re-flowed
   format variants → Apply.
6. **Export** → PNG / PDF per format. A milestone is created in the same click ("Export · PNG · 24 Oct").

*Success:* first export in ≤ 3 minutes for a first-time user, with no panel opened.

### B. Multi-page piece with page transitions and text animation

1. Pages lens, filmstrip at the bottom. **[C]** "5-page product teaser from this brief" → a plan of 5 pages,
   previewed in the filmstrip → Apply.
2. Select the **gap between pages 2 and 3** → **[H]** `Transition`: Fade, Slide, Push, **Smart move**, duration.
3. Select the title → **[H] Animate** → preset sheet: Fade up, Typewriter, Word-by-word, Scale pop, Mask reveal,
   each with In / Emphasis / Out. Hover previews in place, and a click applies.
4. **[B]** "same transition between all pages" → a bulk capability. The preview badges every gap.
5. **▶ Present**: transitions play, and "on click" elements advance per click.
6. Press `3`: the same pages appear as clips with transition overlaps in the Timeline.

### C. Reaction video (person cutout over background video, zoom)

1. Home → **Reaction**. Drop the background clip and the reaction clip (or record from the webcam in the app).
2. The app builds it: background on track 1, reaction on track 2, **✦ Cut out person** runs as a job (live preview
   mask immediately, baked matte in the background), and an "Undo cutout" toast appears.
3. Tap the cutout → **[H]** `Video · Cutout`: position presets (corner L/R, bottom third, side by side), outline,
   shadow, size, **✦ Fix edges**.
4. **Transcript strip** under the tracks: select "wait, what?!" → **[H]** `Range`: **Zoom here** (punch-in to 130%
   with eased in/out, no keyframe UI), Emphasis caption, Sound effect.
5. **[B]** "remove silences and ums" → detected cuts highlighted on the timeline → Accept all / Review.
6. **[B]** "captions, big bold style" → a caption track → Export 9:16 and 16:9 MP4.

*Success:* a 60 s reaction video exported in ≤ 10 minutes by a non-editor, without touching a keyframe.

### D. Generate → edit → extend a clip

1. **[C]** "8-second clip of a paper boat on a rainy street, cinematic." A placeholder clip with a progress chip
   appears, and the canvas stays usable. Two takes arrive. Choose one.
2. Select the range 3.0–7.0 s → **[H]** `Range`: Split, Speed, **✦ Extend from here**, **✦ Regenerate range**,
   **Make new clip**.
3. **✦ Extend from here** opens an inline sheet: the prompt prefilled from the recipe, 8 s, "use last frame as
   start", and an optional end frame picked from any image on the canvas.
4. The result lands as a new clip with a **lineage badge**. **[H] Lineage** shows source → range → extension.
   *Regenerate* re-runs just that step with a new seed.
5. **[B]** "crossfade them and add rain sound" → a transition plus audio generation, previewed.

### E. Steps → atomic unit → workflow graph

1. Do the flyer steps once. In the History tab, select those steps → **[H] Turn into flow**.
2. The Flow lens opens with the steps left to right. Touched inputs (image, headline, sale %) become exposed
   parameters.
3. Select the steps → **[H] Collapse into unit**, give it a name and an icon. It appears in the HUD and the
   command bar as "Make sale flyer" and is published to agents.
4. **App view:** run it from a form, including a batch of 20 product photos → a grid preview → Apply all.
5. **[C]** "a flow that turns a blog post into a 30 s captioned video" → the agent drafts the graph, and every
   step is inspectable before the first run.

## 7. Saving, milestones and sharing

- **Always saved.** The top bar shows "● Saved" (or "Not saved yet: <cause>" after 2 s). `Mod+S` shows a toast
  "Instaflow saves automatically · **Create milestone**". `Mod+Alt+S` opens "Create milestone" (name, note) inline.
- **History & Milestones tab:** a milestone list with name, author, time, cover and pin. Actions are Open
  (read-only), Compare with Latest (side by side), **New document from milestone** and Export. There is no
  Restore.
- **Templates:** using one is "New document from milestone" plus slot filling, which the user sees as "Use
  template".
- **Export / Share** (`/d/share`): format, size and variant, and range. The dialog states in plain words where the
  file goes and that it is a snapshot (a milestone). Formats are `.iflow`, viewer HTML, MP4, PDF, PNG, SVG and GIF.
  There are no links in V1.
- **Storage:** first run uses the browser store, with zero setup. The storage panel shows space used and offers
  **Move workspace to a folder** (Chrome) at 2 GB. Firefox offers "Back up workspace (.zip)".
- **Unsupported browser:** one calm screen: "Instaflow needs Chrome on desktop", the missing capability, the code
  (`IF-PLAT-00x`) and a link to the fix.
- **Models:** Settings → Models: provider, key (stored only on this device), and a test call. Dev builds show
  "Mock models" as the active provider.

## 8. UX research plan (from report 04, desktop only)

### 8.1 Goals

1. Validate the HUD + bar + chat split, and where each surface wins or loses.
2. Find the **top 20 daily jobs** that fill HUD slots.
3. Test trust in and comprehension of agent previews, attribution, per-actor undo and conflicts.
4. Test that lens switches feel like one app, and that Latest + Milestones is understood without a save button.

### 8.2 Participants (6–8, 60 min, remote, moderated, on desktop Chrome)

| # | Profile | Why |
|---|---|---|
| 1–2 | Small-business owner or marketer who makes flyers and posts weekly in Canva | Flyer and campaign |
| 3 | Creator who makes reaction or short-form videos (CapCut desktop / web) | Reaction video |
| 4 | Podcaster or educator using Descript or Clipchamp | Transcript editing, generate → extend |
| 5 | Product or visual designer, daily Figma user | Pro density, keyboard |
| 6 | Automation person (n8n, Zapier, Make) or ComfyUI hobbyist | Flows and units |
| 7 | Power user of ChatGPT or Claude with their own API key | BYO model, autonomy |
| 8 | Screen-reader or keyboard-only user | Canvas accessibility |

Screener: made at least 3 visual assets in the last month. Mixed AI comfort.

### 8.3 Sessions

1. **Context interview (15 min):** the last asset you made; where you got stuck; what you searched for and did not
   find; what you redo every week.
2. **Tasks on a clickable prototype (35 min)** with a Wizard-of-Oz agent:
   - **T1 Flyer:** "Make a sale flyer from this photo and logo; export for IG and print." Measure time to first
     export, panels opened, and the surface used per step.
   - **T2 Transition:** "Fade between pages 2 and 3, and make the title type itself in." Do they find the gap
     selection?
   - **T3 Reaction:** "React to this clip; zoom in when you say 'wait what'." Does the transcript-range zoom make
     sense?
   - **T4 Extend:** "Make the second half of this clip 8 s longer." Range selection, and understanding of lineage.
   - **T5 Agent trust:** the agent rewrites all headlines and changes one image while the participant moves a
     logo. "Keep the image, reject the text." Measure partial apply, conflict understanding, and "who changed
     this?"
   - **T6 Flow:** "You'll do this every week — make it one click." Discovery of Turn into flow.
   - **T7 Milestones:** "Send the client a version, then keep working; next week start a variant from what they
     saw." Understanding of no-save, milestones and New document from milestone.

   Counterbalance T1–T4. Run T5 after a deliberate agent mistake.
3. **Debrief (10 min):** UMUX-Lite, "What felt cluttered?", "When would you let the agent act without asking?"

### 8.4 Success metrics

| Metric | V1 target | Source |
|---|---|---|
| T1–T4 success, unaided | ≥ 80% | Sessions |
| Time to first flyer export (novice) | ≤ 3 min | Sessions, then the journey span |
| Edits from visible HUD slots | ≥ 60% | Local telemetry, `capability.invoke` origin |
| Bar → chat escalation | 10–25% | Telemetry |
| Proposal reject rate per capability | Track; > 40% means fix it | Telemetry |
| Undo within 10 s of an agent apply | < 15% | Telemetry |
| "Who made this change?" correct | ≥ 90% | T5 |
| Milestone model understood (T7 unaided) | ≥ 80% | T7 |
| Perceived clutter (1–7) | ≤ 2.5 | Debrief |
| UMUX-Lite | ≥ 75 | Debrief |

### 8.5 Competitor benchmark (T1–T4 each quarter)

Canva (breadth), Adobe Express with its AI Assistant (conversational edits), CapCut desktop/web (reaction), Descript
with Underlord (agentic video), Figma Buzz/Slides (brand assets, transitions), Krea Nodes or Figma Weave (flows),
tldraw agent kit and Excalidraw (presence, simplicity). Record time on task, clicks, panels opened and one friction
quote per task.

### 8.6 Outputs

A ranked job list mapped to HUD slots and capabilities (the IF-1.6 evidence base), an updated principle list, the
HUD ranking seed, and a list of "chat-only" requests that should become buttons.

## 9. Accessibility and keyboard

- The accessibility layer exposes the visible region, the selection and the focus path. Tab and arrow keys
  traverse in reading order, and Enter edits.
- `Alt+Enter` focuses the HUD (a `toolbar` with roving tabindex). `Mod+K` opens the bar. `1`–`4` switch lenses.
  `Space` plays and pauses. `J`/`K`/`L` shuttle. `I`/`O` set range in and out. `S` splits.
- Agent actions are announced politely in a live region ("Ava changed 3 headlines").
- Every drag has a keyboard and inspector equivalent. Every HUD action has a visible label or tooltip with its
  shortcut.

## 10. Rejected alternatives

- **Chat-only UI:** the articulation barrier; people need visible, learnable actions.
- **Floating persistent panels (Figma UI3 beta):** they cramp the canvas and were reverted.
- **A left plus right panel layout:** one tabbed right dock plus the bottom tray keeps the canvas wide.
- **A template wall on first launch:** intent first, templates after ("Flyer → 12 flyers").
- **A save button or "Restore version":** they conflict with D2. `Mod+S` teaches milestones instead.
- **Modal confirmations for routine actions:** inline confirmations keep flow. Dialogs are for Share/Export only.
- **Mobile layouts (report 04 §3.3):** dropped (D1).
