# 04 — Agentic authoring UX for Instaflow

**Status:** research draft, October 2026 · **Owner:** UX research · **Audience:** product design, platform (StaticFlux) maintainers, feature teams.

Instaflow is a local-first, agent-first authoring app. You make an asset, then you act on it, and the
same actions are open to humans (through the UI) and to agents (through WebMCP/MCP). This document turns the
owner's vision and a competitive scan into principles, an interaction model, a layout direction, agent UX,
a mode model, a research plan the owner can run, and a list of platform requirements.

> Source reliability: many 2025–2026 product details come from vendor help centres and secondary coverage.
> First-party sources are marked as such. Where sources disagreed, the disagreement is stated. Claims marked
> *(unverified)* need checking before anyone relies on them.

---

## 0. What the market tells us (condensed scan)

| Product | Pattern worth stealing | Pattern to avoid | Source |
|---|---|---|---|
| **Canva** (editor, Magic Studio, Canva AI, Visual Suite 2.0) | The fixed toolbar became a **quick-actions toolbar that suggests tools for the selected element** (image → crop/filter/effects; text → font/size/style), with `>>` opening the full panel. Canva AI is a conversational assistant that builds whole designs from text or voice. The video editor moved from page-based to a **multi-track timeline where each page acts as a clip**. | Feature sprawl: more than 15 "Magic" tools spread across panels, apps and tabs. Users have to know a tool's *name* before they can find it. | [Canva help: glow-up](https://www.canva.com/help/glow-up/), [Visual Suite 2.0](https://www.businesstoday.in/amp/technology/news/story/canva-unveils-visual-suite-20-adds-sheets-ai-powered-tools-and-one-stop-design-workflows-471602-2025-04-11), [Canva video editing help](https://www.canva.com/help/creating-and-editing-videos/), [fast.io review 2026](https://fast.io/resources/canva-ai-review-2026/) |
| **Figma UI3** | The goal was to keep work "center stage". Toolbars still float at the bottom of every Figma product. | **Floating side panels were reverted** after beta. Heavy users said they cramped the canvas, let designs peek out behind them, pushed rulers away and *slowed people down*. Penpot dropped the same idea. Lesson: float the *transient* UI, dock the *persistent* UI. | [Figma blog: our approach to UI3](https://www.figma.com/blog/our-approach-to-designing-ui3/), [uxdesign.cc](https://uxdesign.cc/figma-scrapes-ui3s-floating-panels-44303803c1ad), [Penpot community](https://community.penpot.app/t/penpot-discarded-figmas-ui3-approach-more-than-a-year-ago/5995) |
| **Figma Make / Buzz / Slides / Weave / MCP** | Buzz gives marketing teams template-locked brand assets. Slides has a **tone dial** (Executive/Technical/…) with "Try again". Weave (ex-Weavy) is a node canvas for branching prompts across models. The MCP server hands design context to coding agents. | Four or more separate apps for what users think of as one job. | [Config 2025](https://help.figma.com/hc/en-us/articles/30965205437975-What-s-new-from-Config-2025), [Adjust tone](https://help.figma.com/hc/en-us/articles/24244814883735), [Welcome Weavy](https://www.figma.com/blog/welcome-weavy-to-figma/), [Dev Mode MCP guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server), [Design context everywhere](https://www.figma.com/blog/design-context-everywhere-you-build/) |
| **Photoshop Contextual Task Bar** | An on-canvas bar that **offers next steps based on the current tool, selection and recent actions**. It can be docked, floated or hidden. | The ranking changes without warning. Users complained when "Select Subject" was swapped out. | [Adobe: Contextual Task Bar](https://helpx.adobe.com/photoshop/using/contextual-task-bar.html), [Photoshop web workspace](https://helpx.adobe.com/photoshop/using/workspace-web.html) |
| **Adobe Express AI Assistant / Firefly AI Assistant** | Conversational, **targeted non-destructive edits** that leave other parts of the design alone. Picks a model per job (Firefly and third-party). | Desktop-only and premium-only at launch. | [Adobe press release (Oct 2025)](https://news.adobe.com/news/downloads/pdfs/2025/10/10282025-adobe-announces-express-ai-assistant-85.pdf), [TechCrunch Apr 2026](https://techcrunch.com/2026/04/15/adobes-new-firefly-ai-assistant-can-use-creative-cloud-apps-to-complete-tasks/) |
| **Descript + Underlord** | **Edit video by editing the transcript** ("if you know backspace, you know how to edit video"). An agentic co-editor in the sidebar with a user-chosen model. | Lag on long projects. | [Descript video](https://www.descript.com/video), [Underlord help](https://help.descript.com/hc/en-us/articles/36803785502221) |
| **Clipchamp** | Silence removal **shows detected cuts highlighted on the timeline before you accept them**, leaves a small pause so cuts are not jarring, and can be undone. Auto-compose output stays editable in the timeline. | Fixed 3 s threshold with no parameter. | [Microsoft support: silence removal](https://support.microsoft.com/en-US/Clipchamp/how-to-use-silence-removal) |
| **CapCut** | Keyframe zoom (100% → 120%) with an ease curve, plus preset zooms on mobile. These are the building blocks of a reaction video. | Keyframes are expert UI on a phone. | [Submagic: zoom in CapCut](https://submagic.co/blog/how-to-zoom-in-on-capcut) |
| **Runway Aleph / Pika** | Aleph: *edit existing footage* (add/remove objects, relight, new angles), with multi-shot edits up to 30 s in 2.0. Pikaframes: **start frame + end frame → generated in-between** (up to 25 s). Pikadditions and Pikaswaps insert or replace elements. | Separate generation tools that never return to an editor. | [Alternativeto: Aleph](https://alternativeto.net/news/2025/7/runway-releases-aleph-model-enabling-advanced-ai-powered-video-editing), [Picsart: Aleph 2.0](https://picsart.com/blog/runway-aleph-2-0-launch/), [Pika 2.2](https://alternativeto.net/news/2025/3/pika-labs-launches-video-model-2-2-with-longer-1080p-videos-and-new-pikaframes-tool) |
| **Krea** | Nodes: 50+ models on an infinite canvas. **Prompt-to-Workflow** (Feb 2026) turns text into a node graph. Realtime Edit lets you paint while the AI re-renders live. | | [Krea: node apps](https://www.krea.ai/blog/top-node-based-ai-workflow-apps), [Krea release notes](https://www.krea.ai/release-notes) |
| **ComfyUI** | **Subgraphs** collapse a selection into one node. **App Mode** (Mar 2026) hides the graph behind a form of chosen inputs and outputs, shareable by URL. | A steep curve for non-technical users. Even subgraphs waste space. | [ComfyUI subgraphs](https://comfyui-wiki.com//en/news/2025-08-07-subgraph-official-release), [Gigazine: App Mode](https://www.gigazine.net/gsc_news/en/20260312-comfyui-app-mode) |
| **n8n / Miro Flows / tldraw computer** | Left-to-right flows. Miro Flows chain steps where **each step is visible and editable and can be saved as a template**. Miro AI sees whatever is selected, so there is no copy/paste of context. | Developer-centric node panels. | [Miro 2025 recap](https://miro.com/blog/2025-recap/), [Miro Oct 2025](https://miro.com/blog/whats-new-october-2025/), [tldraw workflow kit](https://tldraw.dev/starter-kits/workflow), [everydev: n8n](https://www.everydev.ai/tools/n8n) |
| **tldraw** (Make Real, agent starter kit, fairies) | Make Real puts generated output **next to the source** and lets you iterate by drawing on top. The agent kit has a chat panel and an agent that reads and changes the canvas. **Fairies** are visible multi-agent collaborators whose location, actions and overlapping work you can see. Good canvas a11y: live-region selection announcements, Tab in reading order, `getAriaDescriptor`. | | [tldraw agent kit](https://tldraw.dev/starter-kits/agent), [Agents on the canvas](https://gitnation.com/contents/agents-on-the-canvas-with-tldraw), [Make Real story](https://tldraw.dev/blog/make-real-the-story-so-far), [tldraw a11y](https://tldraw.dev/sdk-features/accessibility) |
| **Excalidraw** | Radical simplicity. Share links are **E2E encrypted with the key in the URL fragment** (the server never sees it). | Anyone holding the full link can decrypt. Shorteners and URL loggers leak it. | [Excalidraw E2EE blog](https://plus.excalidraw.com/blog/end-to-end-encryption) |
| **Gamma / Tome** | Gamma: a sparkle per card (card scope) and an agent button plus `Cmd+E` (deck scope). **Constrained layouts** keep output consistent. Tome shut down its consumer slides in 2025, and users who had not exported lost their decks. **Local-first is a trust feature.** | No free-form positioning in Gamma. | [Gamma help: edit with AI](https://help.gamma.app/en/articles/8033284-how-to-edit-content-using-ai), [Vercel: Gamma agents](https://vercel.com/customers/gamma-builds-design-first-agents-with-vercel), [Tome shutdown](https://www.chatslide.ai/articles/tome-ai-shut-down-what-happened) *(competitor source)* |
| **Framer / Pitch** | Framer Wireframer: prompt → layout → chat refine. Workshop builds components without leaving the canvas. Pitch: per-slide assignees and status, speaker view. | | [Framer AI launch](https://www.dutchnews.nl/businesswire/framer-launches-ai-features-to-supercharge-web-design-democratizing-how-stunning-websites-are-built/), [Pitch product](https://pitch.com/product) |
| **Linear / Raycast** | One command bar where every action is reachable. Context menus with diagonal "safe areas". Raycast AI extensions use `@`-invocation and **show a confirmation with a preview for actions that change things**. | | [Linear: invisible details](https://linear.app/now/invisible-details), [MacStories: Raycast AI extensions](https://www.macstories.net/reviews/hands-on-with-raycasts-new-ai-extensions/) |

**Cross-cutting research.**
- *Articulation barrier* (Jakob Nielsen): prompts push all the work of articulation onto the user. The fixes are prompt augmentation patterns: style galleries, rewrites, related prompts, builders, parametrization ([UX Tigers](https://www.uxtigers.com/post/ai-articulation-barrier), [Prompt augmentation](https://jakobnielsenphd.substack.com/p/prompt-augmentation)). This is the main argument for a HUD and against chat-only UI.
- *Palette vs. toolbar*: practitioner evidence says visible toolbars are better for finding and learning, and palettes are better for experts who know what they want. Palettes become more discoverable when they show shortcuts and paths. No controlled study was found ([Binary Ninja](https://binary.ninja/2024/02/15/command-palette.html), [GNOME Nautilus MR](https://gitlab.gnome.org/GNOME/nautilus/-/merge_requests/201)).
- *Fitts's law*: proximity to the selection beats distance. Screen edges behave as infinitely large targets. It models motor time only, not decision time, so labels still matter ([Switas glossary](https://www.switas.com/glossary/fitts-law)).
- *Human–AI guidelines* (Amershi et al., CHI 2019): 18 guidelines grouped by *initially / during interaction / when wrong / over time* ([Microsoft Research](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)).
- *Local-first ideals* (Ink & Switch): no spinners, multi-device, network optional, collaboration, the long now, privacy, user control ([Ink & Switch](https://inkandswitch.com/local-first/)).
- *WebMCP* is a W3C Community Group draft, not standards-track. Chrome shipped preview and origin trials. Sources disagree on whether the API lives on `navigator.modelContext` or `document.modelContext`. There are no Safari or Firefox signals ([danielvaughan.com, Oct 2026](https://codex.danielvaughan.com/2026/10/15/webmcp-browser-native-model-context-protocol-navigator-modelcontext-agent-web/), [studiomeyer reality check](https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026.md)). `@staticflux/webmcp` already isolates both shapes in `adapter.ts`.
- *Mobile bottom sheets*: use them for supplementary, short tasks and for three or more actions. Never use them for the main flow ([Android spec](https://spot.pcc.edu/~mgoodman/developer.android.com/design/spec/components/bottom-sheets.html), [Air France DS](https://design.airfrance.com/latest/components/blueweb-components/bottom-sheet/usage-CFOQ0Rya)).

**The gap Instaflow can own:** nobody joins *object-contextual actions*, *one action set shared by humans and agents*, *generate → edit → regenerate in one place* and *local-first ownership* together. Canva has breadth but sprawls. Descript has the right editing model but only for video. Node tools have power but no polish. tldraw has agent presence but is not a media editor.

---

## 1. Design principles (opinionated, ≤ 10)

1. **The asset is the interface.** Select something and its actions come to it. There are no permanent tool panels for features you are not using. If a capability does not apply to the selection, it is not shown.
2. **Say it or tap it — same action.** Every HUD button, command-bar result, chat request and agent tool call runs the same capability, with the same validation, confirmation, undo and trace. Chat never gets a hidden superpower, and buttons never lag behind chat.
3. **Preview before commit; undo after commit.** Generative and bulk actions show a preview (ghost, diff or A/B) before they change the document. Every commit, whoever made it, is one undo step with a readable label.
4. **Generated media is editable media.** Output lands as layers, clips, tracks or nodes you can manipulate, never as a flat black box. Regenerating a part (inpaint, extend, re-voice) is a HUD action on that part.
5. **One document, many lenses.** Pages, canvas, timeline and graph are *views over one model*, not four apps. Switching modes keeps the selection, undo history and chat context.
6. **Calm by default, dense on demand.** Three density levels (Focus / Standard / Pro). The canvas owns at least 85% of the viewport in Focus. Persistent panels dock; transient UI floats (the Figma UI3 lesson).
7. **Agents are visible collaborators, not ghosts.** An agent has a name, a colour, a cursor, a working area and a log. Its work is attributed. You can pause it, reject its work, or take over.
8. **Your work lives on your device.** It opens offline, never shows a spinner for your own data, and exports to an open file. Sharing is opt-in, encrypted, and never needed to keep your work.
9. **Daily jobs before demos.** Ship flyers, decks with transitions, reaction videos, captions and resizes before novelty effects. Every HUD slot must trace to a real task in the research plan (§6), much like FEATURE-NEEDS.
10. **Accessible and touch-first by construction.** Everything on the canvas is reachable by keyboard and screen reader, and every HUD action is reachable by touch at ≥ 44 px. If an action works only by mouse drag, it does not ship.

---

## 2. Interaction model: HUD × command bar × chat

### 2.1 The three surfaces and how they divide work

| | **Contextual HUD** | **"Say what you need" bar** | **Chat panel** |
|---|---|---|---|
| Question it answers | "What can I do *to this*, right now?" | "Do *X* (to this)." | "Help me make/plan/iterate *something bigger*." |
| Scope | The current selection (element, range, clip, node) | Selection if any, else document | Whole project, multi-step, multi-asset |
| Input | Tap/click, sliders, swatches | Typed or spoken intent, fuzzy + natural language | Conversation, attachments, references |
| Output | Immediate (deterministic) or previewed (generative) | Resolves to **one** capability call (with filled params) or hands off to chat | A **plan** of capability calls, previewed as a batch |
| Speed target | 0 ms to appear (sync), ≤ 100 ms to act | ≤ 50 ms local results; model-ranked within budget | Streaming; never blocks the canvas |
| Analogue | Photoshop Contextual Task Bar, Canva quick actions | Linear Cmd+K, Raycast, Gamma Cmd+E | Descript Underlord, tldraw agent, Canva AI |

**Escalation ladder.** The HUD shows the top 5–7 actions. **More** opens the full applicable list, which is the command bar pre-filtered to the selection. Typing anything turns it into natural language. When the request needs more than one capability, or is ambiguous, the bar says *"This needs a plan — continue in chat"* and carries the text and selection into chat. **De-escalation:** after chat applies a plan, the result is selected and the HUD shows refinement actions for it (for example "Try again", "Tone ↔", "Extend"). People learn the buttons from the chat.

**Anatomy of the HUD.**
- **Placement:** a pill above the selection (below it if there is no room). It snaps to the **top edge** when the selection is large, which gives an edge target in Fitts's terms and matches the owner's "HUD at the top". On mobile it sits at the bottom, above the keyboard or safe area.
- **Contents, left to right:**
  1. Type chip (for example *Text · Headline*).
  2. 3–5 **direct manipulations** (font, colour, align / trim, speed / crop, mask).
  3. A divider, then 1–2 **generative actions** marked with a sparkle (*Rewrite*, *Vectorize*, *Remove background*, *Extend*).
  4. **Animate**, which is always present for animatable things, because the owner's must-have is motion.
  5. `⋯ More`.
  6. A `✦ Ask` field that opens the command bar scoped to the selection.
- **Stability rule:** slots 1–3 are fixed per element type (muscle memory). Only the generative slot and "suggested next" slot are ranked by advisors, and they change at most once per selection, never while the HUD is open. This avoids the Photoshop "where did Select Subject go" complaint.
- **Multi-select:** the HUD shows the intersection of applicable capabilities plus set operations (*Align*, *Distribute*, *Group*, *Make variants*, *Turn into flow*).
- **Ranges:** a selected transcript span, timeline range or text span is a first-class selection with its own HUD (*Cut*, *Extend*, *Re-voice*, *Caption style*, *Zoom here*).

### 2.2 Flows for the owner's scenarios

Each step names the surface used. **[H]** = HUD, **[B]** = command bar, **[C]** = chat, **[A]** = agent via WebMCP.

#### A. Campaign flyer (marketing asset)
1. Home → **"New: Flyer"**, picked from 6 intent tiles (Flyer, Post, Deck, Video, Reaction, Flow). Each tile asks for a format chip (A4, IG post, Story).
2. **[C]** *"Flyer for our Diwali sale, 30% off, warm colours, our logo."* The agent proposes **3 layout variants** as side-by-side ghosts (Gamma-style constrained layouts, Canva-style templates). Tap one → **Apply** creates one undo step: *"Agent: created flyer (variant B)"*.
3. Tap headline → **[H]** `Text · Headline`: font, size, colour, **✦ Rewrite** (tone dial, Figma Slides style), **Animate**.
4. Tap the hero image → **[H]** crop, filter, **✦ Remove background**, **✦ Generate vector** (image → SVG trace, or a generated SVG illustration in the brand palette), **✦ Replace…**.
5. **[B]** *"make versions for Instagram story and A4 print"* → the `resize/variants` capability. The preview shows a grid of re-flowed sizes. Apply.
6. Share → **Export PNG/PDF** or **Share link (encrypted)**.

*Success:* first export in ≤ 3 minutes for a first-time user, without opening any panel.

#### B. Multi-page piece with transitions and text animation
1. Pages mode (filmstrip at the bottom). **[C]** *"5-page product teaser deck from this brief"* → a plan with 5 page creations, previewed as a filmstrip.
2. Select the **gap between two pages** in the filmstrip. The gap is a selectable object. **[H]** `Transition`: Fade, Slide, Push, **Smart move** (shared elements morph, like Keynote Magic Move), and duration.
3. Select the title → **[H] Animate** opens an animation sheet with a short preset list: Fade up, Typewriter, Word-by-word, Scale pop, Mask reveal. Each has *In / Emphasis / Out*. Tap previews in place (loop), and tap again applies.
4. **[B]** *"apply the same transition to all pages"* → bulk capability. The preview badges every gap.
5. **Present ▶** → presentation mode (§5.4). Transitions play. Elements marked *on click* advance per tap.
6. Toggle **Timeline view**: the same pages appear as clips with transition overlaps. This shows that pages and video are one model.

#### C. Simple reaction video (cutout over background video + zoom)
1. Home → **Reaction** tile. Drop **background clip** (the thing being reacted to) and **reaction clip** (webcam) or record in-app.
2. The app auto-builds the template: background on track 1, reaction on track 2. It runs **✦ Cut out person** on the reaction clip by default and shows a preview with an *"Undo cutout"* toast.
3. Tap the cutout → **[H]** `Video · Cutout`: position presets (corner L/R, bottom-third, side-by-side), **Outline/Shadow**, **Size**, **✦ Fix edges**.
4. **Transcript strip** (Descript pattern): the reaction clip's speech appears as text under the timeline. Select the words *"wait, what?!"* → **[H]** `Range`: **Zoom here** (punch-in to 130% on the background with an eased in/out, written as two keyframes like the CapCut recipe but with no keyframe UI), **Emphasis caption**, **Sound effect**.
5. **[B]** *"remove silences and ums"* → shows detected cuts highlighted on the timeline (Clipchamp pattern) with *Accept all / Review*.
6. **[B]** *"captions, big bold style"* → caption track. Export 9:16 / 16:9.

*Success:* a 60 s reaction video exported in ≤ 10 minutes by a non-editor, without touching a keyframe.

#### D. Generate → edit → extend a clip ("take half a clip, stretch it into a new clip")
1. **[C]** *"8-second clip of a paper boat on a rainy street, cinematic."* Generation runs with a progress chip on a placeholder clip in the timeline, and the canvas stays usable. Two takes arrive. Choose one.
2. Scrub, then select the range **3.0–7.0 s** → **[H]** `Range`: **Split**, **Speed**, **✦ Extend from here**, **✦ Re-generate range**, **✦ Edit objects** (Aleph-style), **Make new clip**.
3. **✦ Extend from here** opens a sheet with a prompt prefilled from the source clip's prompt, a duration of 8 s, and *"Use the last frame as the start"* (Pikaframes start/end-frame pattern). Optionally pick an end frame from any image on the canvas.
4. The result lands as a **new clip linked to its parent** (a lineage badge). **[H] Lineage** shows *source → range → extension*. *Regenerate* re-runs just that step with a new seed.
5. **[B]** *"crossfade them and add rain sound"* → transition plus audio generation, previewed.

*Key rule:* generated media keeps its **recipe** (model, prompt, inputs, seed, source range) as metadata. That makes "regenerate", "extend" and "make variants" HUD actions rather than chat archaeology. It also makes the asset reproducible when the user switches models later (BYO model).

#### E. Building a flow graph (steps → atomic unit → graph)
1. **Record a sequence:** the user does the flyer steps once (remove BG → place on template → rewrite headline → export 3 sizes). The history panel shows them as steps. Select the steps → **[H]** **Turn into flow**.
2. Graph mode opens with 4 nodes left-to-right (n8n/Miro Flows layout). Inputs the user touched become **exposed parameters** (image, headline, sale %).
3. Select the 4 nodes → **[H]** **Collapse into unit** (ComfyUI subgraph). The unit gets a name, an icon and an input/output form.
4. That unit now appears as **a capability in the HUD and the command bar** (*"Make sale flyer"*), and is published to agents through WebMCP. The graph becomes a tool.
5. **App view** (ComfyUI App Mode pattern): share the unit as a form-only page, for example so a teammate can drop 20 product photos and get 60 flyers. The batch preview shows a grid, then *Apply all*.
6. **[C]** *"make a flow that turns any blog post into a 30 s captioned video"* → the agent drafts the graph (Krea Prompt-to-Workflow), and every node is inspectable before the first run.

---

## 3. Layout and visual direction

### 3.1 Canvas-first, floating where it is transient

```
┌────────────────────────────────────────────────────────────────────────┐
│ ◧ Instaflow · Diwali flyer ▾        [Pages|Canvas|Timeline|Graph]  ●●  ▶ Share │ ← 44px top bar (mode switch, presence, present, share)
│                                                                        │
│            ┌── HUD ─────────────────────────────────────┐              │
│            │ Text·Headline  Aa  ■  ≡  │ ✦Rewrite │ Animate │ ⋯ │ ✦Ask │ │ ← floats at selection, snaps to top
│            └────────────────────────────────────────────┘              │
│                       ┌───────────────────┐                            │
│                       │   [ selected ]    │        ┌─ Chat (docked) ─┐ │
│                       │                   │        │ agent log, plan │ │ ← docked & resizable when open;
│                       └───────────────────┘        │ preview/apply   │ │   closed by default in Focus
│                                                    └─────────────────┘ │
│  ⟲ ⟳                  ( ✦ Say what you need…  ⌘K )             100% ± │ ← bottom: undo, command bar, zoom
│ ─────────────────────────────────────────────────────────────────────  │
│  ▭▭▭▭  filmstrip / timeline tray (collapsible; mode-dependent)         │
└────────────────────────────────────────────────────────────────────────┘
```

- **Persistent UI docks**: chat, layers/outline, timeline tray. They are resizable and collapsible to a rail, never floating cards over the work (Figma UI3 lesson).
- **Transient UI floats**: HUD, command bar, previews, agent cursors, toasts.
- **One accent colour** for "generative" (sparkle). Neutral greys for everything else. Agent colours come from a separate palette so they are never mistaken for brand colours in the design.
- **Motion** is short (120–200 ms), respects `prefers-reduced-motion` (which `@staticflux/messaging` already supports), and uses View Transitions for mode switches (`@staticflux/shell` already does this for workspaces).
- **Empty state**: a large "Say what you need" field, 6 intent tiles and 8 recent files. No template wall on first launch. Templates appear *after* intent ("Flyer → 12 flyers"), which keeps onboarding to two choices.

### 3.2 Density levels (maps to shell presets/workspaces)

| Level | Who | What shows | Shell mapping |
|---|---|---|---|
| **Focus** (default for new users, mobile) | Casual creators | Top bar, HUD, command bar. Chat, layers and properties hidden. | `compact` preset + "focus" workspace |
| **Standard** | Weekly users | + docked chat or layers on demand, filmstrip/timeline tray | `medium` preset |
| **Pro** | Daily users, designers | + docked properties inspector (precise numbers), layers, history, keyboard hints in the HUD | `expanded` preset + "pro" workspace |

The density level is a **workspace** (`defineWorkspace`), not an `if/else`, which is consistent with the platform's rule 4. It is remembered per device. Pro users can pin any HUD action to a docked inspector.

### 3.3 Mobile web and PWA adaptations

- **HUD → bottom action bar** that scrolls horizontally (thumb zone). Tapping an action opens a **half-height bottom sheet** for parameters, with the canvas still visible above it. Sheets are only for supplementary steps; main flows never live in a sheet stack deeper than one.
- **Command bar → mic-first** field above the action bar. Voice is a primary input on mobile.
- **Chat → full-height sheet** with a "peek" state that shows the last agent message and the Apply/Reject buttons.
- **Gestures:** pinch zoom, two-finger pan, long-press for the context HUD, two-finger tap to undo and three-finger tap to redo (Procreate convention), swipe on a timeline clip to trim. Every gesture has a visible button equivalent.
- **Timeline on phones:** a vertical-friendly single-track "story" view with clips as cards and a transcript as the editing surface, which is easier than multi-track on 375 px. Multi-track is available in landscape.
- **Graph on phones:** read and run only by default (App view). Editing graphs on a phone is a non-goal for v1.
- **PWA:** installable, offline-first, file handling (open `.iflow`), share target ("Share to Instaflow" from the camera roll starts a Reaction or Flyer).

---

## 4. Agent UX

### 4.1 How agents act: the same capabilities, one pipeline
- Every action in §2 is a `defineCapability(...)`. The in-app chat agent, an external agent through WebMCP (`createWebMcpPublisher`), and a desktop MCP client all go through `registry.invoke(cap, input, { subject: 'agent' })`. That gives validation, gating with the agent subject, confirmation for destructive actions (the default confirm port **fails closed**), meter reservation for paid generations, and a `capability.invoke` span. No per-feature agent code (consistent with `@staticflux/webmcp`).
- **BYO model:** the chat agent's model comes from `@staticflux/ai`'s `ModelRouter`: a remote provider with the user's key/transport, browser built-in AI for small tasks, or none. Every AI feature must have a **non-AI fallback** (platform rule). The HUD's deterministic actions always work, and generative slots show "Connect a model" when no provider is available.
- **Agent context:** "what is selected" goes in as structured data (selection, element types, applicable capabilities, a low-res snapshot) so the agent does not need to scrape the page. This is the Miro "AI sees what you select" pattern.

### 4.2 Preview, approval and autonomy levels

| Autonomy (per agent, per project) | Behaviour |
|---|---|
| **Suggest** | The agent only proposes. Every plan shows as a preview and needs **Apply**. |
| **Auto-apply safe** (default) | Non-destructive, unmetered, reversible edits apply immediately as undoable steps. Generations, deletions and bulk changes over N items still preview. |
| **Autopilot (bounded)** | Runs a plan inside a **credit budget and time box** with live progress. It stops at destructive steps (confirm port). |

Preview forms, by asset type:
- **Ghost overlay** for layout and element changes (dashed outline, 60% opacity).
- **Before/after slider** for image edits.
- **A/B/C takes** for generations.
- **Text diff** (strike/insert) for copy rewrites.
- **Timeline diff**: added clips hatched, cut ranges red, like the Clipchamp purple highlights.
- **Graph diff**: new nodes outlined, changed parameters badged.

Apply, Reject and **Apply part** (per element) are always present. A plan lists its steps with checkboxes before it runs.

### 4.3 Attribution
- Every committed change records **who** (user / named agent + model id / flow), **via what** (HUD, bar, chat, WebMCP, flow), and **capability id + input**.
- Generated assets carry the recipe (§2.2 D) and a visible ✦ badge in the layers list and export metadata. Content credentials (C2PA) should be evaluated for export.
- History reads like a log: *"Ava (agent · your model) rewrote headline — Undo · Show diff"*.

### 4.4 Undo
- One capability invocation = one undo step, including agent plans (a plan applies as a group, and you can expand it to undo a single step).
- **Per-actor undo:** "Undo my last" never undoes the agent's concurrent edit, and the reverse holds too. **Reject agent session** reverts everything an agent did since you last approved, if it does not conflict with your later edits. If it conflicts, it shows which.
- Undo survives reload (local-first) and works offline.

### 4.5 Presence
- Agents appear like human collaborators (tldraw fairies pattern): an avatar chip in the top bar, a **cursor with a name and a status line** ("Generating take 2/3…"), and a **working-area highlight** on the elements they hold. Other actors see a soft lock on those elements and can override them.
- **Pause / Stop / Take over** on the agent chip. Stopping aborts in-flight invocations through `AbortSignal` (platform rule 5).
- External WebMCP agents appear with the agent client's name and a distinct "external" badge. Their destructive calls get confirmed in the agent client's `requestUserInteraction` (`webMcpConfirmPort`).

---

## 5. Modes without separate apps

### 5.1 One model, four lenses
All modes edit the same entities (ECS world in `@staticflux/document`): **Elements** (text, image, vector, video, audio, shape) placed in **Frames** (a page is a frame; the infinite canvas is the world with no frames required), arranged in **Time** (frame duration, element in/out, keyframes), and connected by **Edges** (graph).

| Mode | It is really… | Primary selection | Example "switch" moment |
|---|---|---|---|
| **Pages** | Frames in order | Element / page / gap | "Show this deck as video" → Timeline |
| **Canvas** | Frames and loose elements in space | Element / region | "Turn these 4 frames into pages" → Pages |
| **Timeline** | Frames and elements in time | Clip / range / word | "Edit this clip's thumbnail" → Canvas, with the frame focused |
| **Graph** | Capabilities as nodes, assets as data | Node / edge / unit | "Show me where this image came from" → Lineage graph |

### 5.2 Switching rules
- The segmented control in the top bar has shortcuts `1`–`4`. The switch uses a View Transition that **morphs the selected object into place**, so the user sees continuity.
- **Selection, undo, chat and the HUD persist** across modes. The HUD only gains or loses mode-specific actions (for example Timeline adds *Split* and *Speed*).
- **Mode is a lens, not a file type.** Any document can be opened in any mode. Modes that do not fit hide (for example Timeline for a static flyer shows a single 5 s frame, which is still useful for "animate this flyer").
- **Graph is both an authoring mode and a lineage view.** Every generated asset can be opened as "how it was made".
- Implementation: each mode is a **feature** that contributes slots and capabilities. Switching is a workspace switch (`switchWorkspace`) with the right `features`, never branching in feature code.

### 5.3 Read-only mode
- The same renderer has editing capabilities not declared. The HUD shows only *Copy*, *Download*, *Comment* (if allowed), *Duplicate to edit*.
- Read-only is the default for opened share links unless the link grants edit.

### 5.4 Presentation mode
- Full-screen, chrome-less. Pages play with transitions, timelines play as video, graphs run as App view.
- Presenter view (second window): notes, next slide and timer. Phone as remote via a local pairing link is a stretch goal.
- Per-element "on click" builds, plus keyboard/clicker support. Reduced motion swaps transitions for fades.

### 5.5 Shareable links (local-first first)

| Tier | Mechanism | Trade-off |
|---|---|---|
| **1. File** | Export `.iflow` (archive snapshot) or a **self-contained viewer HTML** (assets inlined, read-only player) | Works forever, no server. Large video makes big files. |
| **2. URL-embedded** | Small docs (flyers, short decks without video) compressed into the URL fragment | Zero server. Size-capped. The URL is the secret. |
| **3. Encrypted blob link** | Excalidraw model: the client encrypts, the server stores an opaque blob, the **key lives in `#fragment`** | Needs a dumb blob store. Whoever holds the link can read. Warn about shorteners. |
| **4. Live collaboration** | `CollaborationTransport` (Yjs updates) over a relay, keys in the fragment, presence | Needs a relay. Supports co-editing with humans and agents. |

The share dialog explains in plain words *who can see this* and *where it is stored*, and offers "Stop sharing" (rotate key). The link is the authorization token **only** for client-side UX. Any server-side store must enforce its own access (rule 9: client gating is UX, not security).

---

## 6. UX research plan (runnable by the owner)

### 6.1 Goals
1. Validate that the **HUD + bar + chat** split matches how people want to work, and find where each surface wins or loses.
2. Find the **top 20 daily jobs** that fill HUD slots (the evidence base for principle 9).
3. Test trust and comprehension of **agent previews, attribution and undo**.
4. Test that the **mode switch** feels like one app.

### 6.2 Participants (6–8, 60 min each, remote, moderated)

| # | Profile | Why |
|---|---|---|
| 1–2 | Small-business owner / marketer who makes flyers and social posts weekly in Canva | Core flyer and campaign job |
| 3 | Creator who makes short-form or reaction videos on CapCut / phone | Reaction video, mobile |
| 4 | Podcaster or educator who uses Descript or Clipchamp | Text-based editing, generate → extend |
| 5 | Product/visual designer, daily Figma user | Pro density, keyboard, the Figma UI3 lesson |
| 6 | Ops/automation person (n8n / Zapier / Make) or ComfyUI hobbyist | Flows and units |
| 7 | Power user of ChatGPT/Claude with their own API key | BYO model, agent autonomy |
| 8 (optional) | Screen-reader or keyboard-only user | Canvas a11y |

Screener: has made at least 3 visual assets in the last month. Mix of devices (at least 3 on mobile web). Mix of AI comfort levels.

### 6.3 Session structure
1. **Context interview (15 min):** the last asset you made: walk me through it. Where did you get stuck? What did you search for and fail to find? What do you redo every week? *(Feeds the job list.)*
2. **Tasks on a clickable prototype (35 min).** Figma prototype for the HUD and modes, plus a Wizard-of-Oz agent: a researcher plays the agent through a shared doc or live prototype.

   | Task | Measures |
   |---|---|
   | T1 Flyer: "Make a sale flyer from this photo and logo; export for IG and print." | Time to first export, number of panels opened, surface used for each step |
   | T2 Transition: "Add a fade between pages 2 and 3 and make the title type itself in." | Success without help; does the user find the "gap" selection? |
   | T3 Reaction: "React to this clip; zoom in when you say 'wait what'." | Success; does the transcript-range zoom make sense? |
   | T4 Extend: "Take the second half of this clip and make it 8 s longer." | Range selection success; understanding of lineage |
   | T5 Agent trust: the agent rewrites all headlines and changes one image. "Keep the image, reject the text." | Partial-apply success; attribution comprehension (ask: "who changed this?") |
   | T6 Flow: "You'll do this every week — make it one click." | Discovery of "Turn into flow"; mental model of units |
   | T7 Share: "Send this to a client so they can only view it." | Understanding of where data lives |
3. **Debrief (10 min):** SUS-lite or UMUX-Lite, then *"What felt cluttered?"*, *"When would you trust the agent to act without asking?"*

Counterbalance T1–T4 order. Run T5 after a deliberate agent mistake to measure recovery.

### 6.4 Success metrics (prototype now, product later)

| Metric | Target (v1) | How measured |
|---|---|---|
| Task success (T1–T4) unaided | ≥ 80% | Moderated sessions |
| Time to first export, flyer | ≤ 3 min (novice) | Sessions → product telemetry (journey span) |
| HUD hit rate: action used came from the HUD's visible slots | ≥ 60% of edits | Telemetry `capability.invoke` origin = HUD |
| Bar → chat escalation rate | 10–25% (too low means chat is unnecessary; too high means the HUD fails) | Telemetry |
| Preview acceptance / partial-accept / reject | Track; a reject rate over 40% for a capability means it needs fixing | Telemetry per capability |
| Undo within 10 s after agent apply | < 15% | Telemetry |
| "Who made this change?" answered correctly | ≥ 90% | T5 probe |
| Perceived clutter (1–7, "the screen felt crowded") | ≤ 2.5 | Debrief |
| UMUX-Lite | ≥ 75 | Debrief |
| Mode-switch continuity ("felt like the same app") | ≥ 6/7 agree | Debrief |

### 6.5 Competitor benchmark (run the same T1–T4 on each)
- **Canva** (flyer, transitions, video): the breadth benchmark.
- **Adobe Express** (flyer + AI Assistant): conversational edit benchmark.
- **CapCut web/mobile** (reaction video): the mobile video benchmark.
- **Descript** (text edit + Underlord): the agentic video benchmark.
- **Figma Buzz / Slides** (brand assets, transitions): the pro-designer benchmark.
- **Krea Nodes or Figma Weave** (generate → extend, flows): the node-canvas benchmark.
- **tldraw (agent kit demo)** and **Excalidraw** (simplicity, share): presence and share benchmark.

Record time on task, clicks/taps, panels opened, and one quote per task about friction. Repeat each quarter.

### 6.6 Synthesis outputs
A ranked **job list** that maps each job to its HUD slot and capability. An updated principle list. A HUD ranking heuristic seed (§7.3). A list of "chat-only" requests that should become buttons.

---

## 7. What the platform must provide to power the HUD

The current StaticFlux packages cover a lot of this already. Below is what exists, and the gaps a design partner should raise with the platform team.

### 7.1 Already there (use as is)

| Need | Package / API |
|---|---|
| One action pipeline for UI, palette and agents | `@staticflux/capabilities` `defineCapability`, `registry.invoke(…, { subject, origin })` |
| Publish actions to agents | `@staticflux/webmcp` `createWebMcpPublisher` (auto-registers, `destructiveHint`) |
| Agent confirmations inside the agent client | `webMcpConfirmPort` |
| Paid generations (credits) | `CapabilityMeterPort`, `costEstimate`, `reportCost` |
| BYO model, fallbacks, availability facts | `@staticflux/ai` `ModelRouter`, `createRemoteLlmProvider`, browser AI |
| Fast ranking with time boxes, never blocking | `@staticflux/advisors` `decide()` (sync) / `ask()` (time-boxed), Markov advisor |
| Command bar | `@staticflux/shell` `defineCommand`, `createCommandRegistry.search`, `<sf-command-palette>` (Mod+K) |
| HUD, sheets, toasts, coach marks; focus and a11y | `@staticflux/messaging` surfaces (popover/sheet/toast/coach-mark), `<sf-surface-host>` |
| Density levels, mode switching | `@staticflux/shell` `defineWorkspace`, `shellPresets`, `switchWorkspace` (View Transition) |
| Document, co-editing, presence | `@staticflux/document` engine `transact`, `createPresenceStore`, `CollaborationTransport` |

### 7.2 Gaps (proposals)

1. **Applicability predicates on capabilities.** Add `appliesTo: { selection: SelectionShape; when?(ctx): boolean }` (pure, sync, cheap) to `defineCapability`. A `SelectionShape` is a typed descriptor: element kinds and components, cardinality, range kinds (time range / text range / word span), mode. The registry exposes `applicable(selection, mode)`, which is reactive and **separate from authorization**. The HUD shows applicable capabilities and grays out denied ones with an upsell. It must not hide them for security reasons, because client gating is UX.
2. **HUD presentation metadata.** `presentation: { group: 'manipulate' | 'generate' | 'animate' | 'arrange' | 'export'; icon; shortLabel; slot?: 'pinned' | 'ranked'; paramsUi?: 'inline' | 'sheet' | 'none'; keywords; examples }`. `examples` feed natural-language matching in the command bar and help agent tool descriptions. Pinned slots give HUD stability (§2.1).
3. **Dry-run previews.** `registry.preview` today returns an *authorization decision*, not a visual preview. Add `implementCapability(cap, run, { plan })`, where `plan(input, ctx)` returns a **proposed change set** (document ops plus ephemeral preview assets) without committing. Then `commit(plan)` and `discard(plan)`. That supports ghosts, diffs, A/B takes and "Apply part".
4. **Batch/plan invocations.** `registry.invokePlan(steps[], { atomic, budget })` for chat and autopilot plans. Each step is still one invocation (trace, gate, meter) but they group into one undo entry and one approval.
5. **Attribution in the document model.** `CrdtOrigin` is currently `'local' | 'remote' | 'restore'`, and `CapabilitySubject` is a coarse `'agent'`. Add an **actor record** (`{ kind: user|agent|flow, id, displayName, model?, via: hud|bar|chat|webmcp|flow, invocationId }`) carried into `transact` and the change sets, so history, per-actor undo and badges work.
6. **Undo/redo service.** No undo stack exists in `@staticflux/document` today. Add per-actor, transaction-grouped undo (for example Yjs `UndoManager` behind the engine API), persisted with snapshots.
7. **Asset recipes and lineage.** A `Recipe` component (capability id, model id, inputs, seed, parent asset, source range) on generated entities, and a lineage query. This powers Extend, Regenerate, Lineage graph and export provenance.
8. **Advisor purpose for UI ranking.** `AdvisoryPurpose` is a closed set (`warmup | retention | scheduling | prefetch | messaging-timing | sampling`), and none of these fits "order the HUD's ranked slots". Propose adding `ui-ranking`, which, like the others, changes presentation only and never correctness or access. Example decision point: `instaflow/hud-next-action` with `latency: 'sync'`, options = applicable ranked capabilities, a heuristic seeded from research (§6.6), and a Markov advisor trained on local `capability.invoke` sequences (stays on device). The selection is the cacheKey. `constrain` = applicable ∧ allowed.
9. **Selection as shared context.** A typed `SelectionToken` / reactive selection store (entities + ranges + mode), readable by the HUD, the command bar, the chat agent context builder and WebMCP (a `get_selection` tool), so agents and humans talk about the same "this".
10. **HUD surface kind.** Messaging kinds today are dialog/sheet/popover/tooltip/toast/banner/coach-mark/inline-alert. Either define the HUD as an anchored `popover` with a "non-modal, follows the target, top-edge snap" placement, or add a `toolbar` kind so attention arbitration knows that coach marks must not cover the HUD.
11. **Agent presence publisher.** Extend `createPresenceStore` entries with `actor.kind = agent`, status text and a held-entity set (soft locks), so in-app agents and WebMCP agents render like fairies.
12. **Long-running generation tasks.** Generation is a `Task` with progress, partial results (takes), cancellation and resume after reload (handoff), shown as a placeholder entity in the document. The canvas must never block on it.
13. **Canvas a11y contract.** Each element type supplies `ariaDescriptor()` and a reading-order key (tldraw pattern). The HUD is a `toolbar` role with roving tabindex and an `Alt+Enter` shortcut to focus the HUD from a selection. Agent actions are announced through the live region ("Agent Ava changed 3 headlines").
14. **Share/export capabilities.** `share/encrypted-link`, `export/viewer-html` and `export/iflow` as normal capabilities, so agents can share too, with confirmation because sharing is outward-facing.

### 7.3 HUD ranking: heuristic seed (before data)
1. **Pinned manipulations** for the element type (fixed).
2. **Continuation** of the user's last capability on a similar selection (Markov, local).
3. **Lineage actions** if the selection is generated (Extend, Regenerate, Variants).
4. **Mode-specific** actions (Timeline: Split, Zoom here; Pages: Transition, Animate).
5. **Flow units** the user created that apply to this selection.

Ties break toward deterministic (non-AI) actions, which follows the platform rule that AI is never on the critical path.

---

## 8. Open questions
- Is "Animate" a HUD action, a mode (Timeline), or both? *Recommendation: both, sharing one keyframe model.*
- How much of the graph should non-technical users see? *Recommendation: hidden by default; "Turn into flow" and App view only.*
- WebMCP is pre-standard and Chromium-only. Do we also ship a local MCP bridge (desktop) for agents in other browsers or tools?
- What is the default autonomy level per model (built-in small model vs. strong remote)?
- What is the budget and UX when the user's own key runs out mid-plan (meter port denial mid-batch)?
