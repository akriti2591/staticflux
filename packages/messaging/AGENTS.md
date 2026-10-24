# @staticflux/messaging — AGENTS.md

**Layer:** ui (depends on `@staticflux/core`, `@staticflux/ui`, `lit` 3.3.3).
**Budget:** no size-limit entry yet; manager + bridge ≈ 5 KB gzip (tsc output), host element ≈ 3 KB more.
Load the host after core-ready (it is a normal component).

## Purpose
One surface manager for every user-messaging surface (dialog, sheet, popover, tooltip, toast, banner,
coach-mark, inline-alert): declared surfaces, the surface machine, scope-bound lifetimes (I-7), attention
arbitration, coach marks (targets, sequencing, seen-once), gating with upsell, metrics, one focus/a11y
model, and the routable dialog bridge the router calls.
Implements R13.4–R13.10, R7.16–R7.21 (surface side), LIFECYCLES §8, I-7.

## Public API (by file)
- `surface.ts` — `defineSurface({ id, kind, scope, priority, label, render, routable, gate, upsell, dismissible,
  durationMs, dedupe, target, targetTimeoutMs, once, outlet })`, `defineCoachTarget`, `defineCoachSequence`,
  `surfaceMachine`, `SURFACE_KINDS`, `PRIORITIES`, `DismissReason`, `USER_REASONS`.
- `manager.ts` — `createSurfaceManager({ telemetry, decide, seen, visibility, clock, toastConcurrency,
  bannerConcurrency, defaultToastMs, exitMs, reducedMotion })`: `request(def, { owner, props, anchor, stack,
  durationMs, signal })` → `SurfaceHandle` (`state`, `closed`, `dismiss`), `active`, `showing(...kinds)`, `topModal`,
  `dismissTop`, `setUserBusy`, `targets` (coach targets), `startSequence`, `onTransition`, `dispose`; `ownerOf(injector)`.
- `routable.ts` — `createRoutableDialogBridge({ manager, owner, surfaces, decide })`: `openDialog(key, params,
  { source: 'in-app'|'deep-link', owner })`, `closeDialog`, `current`, `onDismissIntent` (`back`|`replace`), `register`.
- `host.ts` — `<sf-surface-host>` (`defineSurfaceHost`): layers, focus trap/restore, Escape, aria-modal, inert
  background, live regions, anchored placement via measure→mutate, reduced motion.
- `outlet.ts` — `<sf-surface-outlet outlet="…">` (inline alerts), `coachTarget(target)` element directive.
- `focus.ts` — `deepActiveElement`, `focusableWithin`, `focusFirst`, `trapTab`, `inertSiblings`.
- `ports.ts` — `KeyValuePort<V>` (async get/set/delete; structural subset of storage's AsyncStore),
  `createMemoryKeyValue`, `MessagingClock` (`systemClock`, `createManualClock`).
- `units.ts` — `SurfaceManagerToken`, `RoutableDialogBridgeToken`, `RoutableSurfacesToken` (multi), `SeenStoreToken`;
  `messagingUnits`, `surfaceManagerUnit`, `routableDialogBridgeUnit`, `memorySeenStoreUnit`, `routableSurface(def)`.
- `telemetry.ts` — `MESSAGING_SUBSYSTEM` (`messaging/surfaces`), `messagingMetrics` (shown, dismissed, rejected, dwell, deduped).
- `errors.ts` — `SF-MSG-001…007`.

## Surface machine (mirror of LIFECYCLES §8, with the implementation's explicit events)
`requested → queued | rejected` (gate, seen, invalid owner) · `requested → dismissing` (cancel) ·
`queued → showing | dismissing | rejected` (target timeout) · `showing ⇄ suspended` · `showing|suspended → dismissing → dismissed`.

## Arbitration rules
Modals: one stack; higher priority or `stack: true` suspends the current top. Toasts: cap (urgent bypasses, urgent
sticky). Banners: dedup by id (or `dedupe(props)`), cap. Tooltip: one. Popover/inline-alert: immediate.
Coach marks: one; need a registered+visible target; suppressed by modals, urgent toasts, `setUserBusy(true)`.

## Rules
- Features request surfaces; they never render overlays (R13.4). Every request names an owner scope (I-7).
- Gate before lazy-loading routable dialog content (I-8). Router-initiated closes emit no dismiss intent.
- Storage ports are async only (R9.0a).

## Test
`npx vitest run packages/messaging` · `npx tsc -p packages/messaging --noEmit`
