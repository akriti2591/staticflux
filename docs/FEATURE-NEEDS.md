# StaticFlux — Feature Needs (outside-in API design)

> Every package API must trace to a need listed here (R11.12). These are the
> example app's features, written as if the framework already existed.
> Example app: **"Studio"** — an AI-assisted mixed-media document editor.

## The example features

| Feature | Kind | Weight | Modes | Notes |
|---|---|---|---|---|
| `studio-desktop` / `studio-mobile` | UI + logic | heavy (archive) | expanded+medium / compact | Document editor; doc lives in a document worker; co-editing + presence |
| `agent-chat` | headless logic + UI panel | warm | all | Agentic chat; tools call capabilities (edit doc, insert image); consumes credits |
| `onboarding` | wizard | cheap | all | Steps as sub-routes; persisted progress; coach marks |
| `settings` | UI | cheap | all | User-data slices (theme, locale); workspace switch (expert mode) |
| `billing` | UI + dialogs | cheap | web, pwa | Upsell dialog (routable), credit balance banner, plan facts |

## Needs per package

### core (DI, scopes, telemetry) — implemented
- Studio: `required` doc store, `lazy` presence, `functional` exportPdf (pre-warm on hover).
- Every feature: `onReady` hooks to subscribe to stores; `refreshOn: [SessionToken]`.

### runtime
- App: boot → core-ready → running; `pause()` while a modal "reconnecting" shows; `refresh()` after token change; degraded when the document worker dies.
- Feature host: activate/mount/hide/unmount/deactivate/archive studio; ref-count (agent-chat depends on studio's document capability while mounted).
- Scheduler: read/write phases for the editor's canvas measurement; `yield` in long ops; idle tasks.
- Resource manager: archive studio under memory pressure on compact devices.

### platform / config
- Facts: form factor (compact → studio-mobile), host mode (embed-agent-host → no SW, memory history), device tier, network, reduced motion, AI availability.
- Flags: `studio/ai-suggestions: boolean`, `onboarding/variant: 'A' | 'B'` (experiment → variant binding), pre-auth-safe flags.

### auth
- Guest can open `/` and `/onboarding`; `/studio/*` needs login; login redirect keeps the deep-link intent.
- Providers used: `bff-cookie` (default), `embed-host` (ChatGPT), `guest`.
- Session change → `refresh('epoch')` across app; logout disposes session scope.

### gate
- Policies: `route:/studio` requires authenticated; `capability:agent/insert-image` requires `plan:pro` or credits ≥ cost; `ui-slot:studio/ai-panel` requires flag + entitlement.
- Decisions explain themselves (devtools); denied → upsell surface.
- Meters: `credits` (reserve → commit/release around each agent call).

### data
- Resources: `docs.list` (paginated), `doc.get` (single), `agent.reply` (streamed), `user.batchProfiles` (batched).
- SWR caching keyed by epoch; retries with jitter; breaker on `agent` endpoint.
- Stores: schema-first `DocumentListStore`, `ChatStore` with snapshots/patches.
- User-data slices: `settings/theme` (user), `onboarding/progress` (user), `studio/last-doc` (device).

### worker / document
- Document worker owns `DocumentStore`; main thread has a read-only replica; edits are intents.
- Core context (session state, flags, decisions, platform, trace context) replicated to every worker.
- Worker crash → respawn → rehydrate from snapshot; app degraded until ready.
- Document engine: ECS entities (text block, image block), CRDT-backed text, presence.

### router / urlstate
- `/studio/doc/:id?tab=comments` — path → studio feature; `tab` is view state.
- `/studio/doc/:id/d/share` — routable share dialog.
- `?panel=chat&prompt=…` — intent consumed by agent-chat after authorize; prefill only.
- Exit guard: studio blocks navigation until pending save flushes.
- Sticky: `workspace`, `lang`, `sf-debug`.

### loader / perf
- Chunks: `feature:studio-desktop` (heavy), `feature:agent-chat` (likely), `feature:onboarding`.
- Warmup: `agent-chat` likely after studio first render; `billing` speculative on hover of upgrade CTA.
- Journey: cold `/studio/doc/42` → boot, pipeline stages, feature first-render/interactive/complete.

### ui / messaging / shell
- Components declare `render`/`lazy`/`functional` deps; placeholders sized.
- Surfaces: share dialog (routable), credit toast, low-balance banner, coach mark on the AI button.
- Shell: slots (`header`, `sidebar`, `main`, `panel`), theme tokens, `expert` workspace adds the inspector panel.

### i18n / a11y / handoff
- Messages per feature, lazy locale catalogs, runtime locale switch.
- Route-change focus, dialog focus trap, announcer for "Saved".
- Handoff: guest draft → after login; studio archive snapshot; scroll position on reload.

### ai / webmcp / advisors
- Advisor: predict next feature to warm (statistical default).
- WebMCP: expose `agent/insert-image`, `studio/summarize` capabilities as tools (gated, confirmed).
