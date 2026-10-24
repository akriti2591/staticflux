# @staticflux/sandbox — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/capabilities`, `@staticflux/worker`).
**Budget (proposed):** not on the boot path — loaded with the first feature that hosts a plugin. Host side ≤ 8 KB brotli;
plugin-side SDK (`connectToHost`) ships in the plugin bundle (≈ link + SDK).

> ## ⚠ CLIENT GATING IS UX, NOT SECURITY (R6.16)
> The sandbox limits what a plugin can ask the app to do; it does not authorize anything.
> Capability implementations still call servers that re-check every request.

## Purpose
Host untrusted third-party plugins (R3.4) across a real isolation boundary — a sandboxed iframe (opaque origin, CSP) or a
worker — talking only typed RPC over a MessagePort (worker `Link` envelopes). A plugin can only: invoke capabilities granted
to it (through `registry.invoke`, so gating, confirmation, activation and metering apply), receive declared events, and
render into a host-provided slot (iframe + `render`). First-party features never need this (research §2: Figma).

## Public API (by file)
- `manifest.ts` — `PluginManifest { id, version, name?, entry: { kind: 'iframe', url | code } | { kind: 'worker', url },
  capabilities, events, permissions: ('render'|'resize')[], limits? }`, `definePluginManifest`, `validateManifest` (untrusted
  input, SF-SBX-001), `isAllowedEntryUrl`, `PluginLimits` + `DEFAULT_PLUGIN_LIMITS`, `effectiveLimits` (clamp to host ceiling),
  `definePluginEvent(id).type<P>()`.
- `protocol.ts` — `SandboxChannels` (`sandbox/hello|invoke|resize|event|grants|ping`), `ConnectMessage`, payload guards,
  `PLUGIN_ALLOWED` (channel allowlist per envelope kind).
- `limits.ts` — `estimateBytes(value, budget)` (stops early), `createRateLimiter(perSecond, now)` (token bucket).
- `realm.ts` — `RealmFactory`/`RealmFactories`, `iframeRealm({ sandbox, csp, maxHeight, channel, connect })`,
  `buildPluginDocument`, `defaultPluginCsp`, `workerRealm({ acknowledgeSameOrigin: true, create })`, `inMemoryRealm(start)`.
- `host.ts` — `createPluginHost({ registry, realms, events, limits, subject, grantPolicy, autoGrant, allowedPermissions,
  handshakeTimeoutMs, heartbeatMs, restart, maxViolations, killSwitch, clock, telemetry })` → `register`, `load`, `get`, `list`,
  `emit`, `onViolation`, `killAll`, `dispose`; `PluginInstance` (`state`, `grants`, `element`, `start`, `whenRunning`, `grant`,
  `revoke`, `emit`, `restart`, `kill`, `stop`, `onStateChange`, `inspect`); `PluginLifecycle`, `SandboxMetrics`,
  `PluginSubject` + `pluginSubjectOf(origin)`, `PLUGIN_ORIGIN_CHANNEL`, `PluginViolation`.
- `sdk.ts` — plugin side: `connectToHost({ pluginId, port?, target?, timeoutMs, signal })` → `PluginClient` (`invoke(cap | id)`,
  `on(event)`, `grants`, `onGrantsChange`, `resize`, `close`).
- `units.ts` — `PluginHostToken`, `pluginHostUnit({ options })` (requires `CapabilityRegistryToken`),
  `pluginUnit({ id, provides, manifest, slot?, grants?, scope = 'feature' })`.
- `errors.ts` — `SF-SBX-001` … `SF-SBX-012`.

## Lifecycle (`sandbox/plugin`, mirror into docs/LIFECYCLES.md §14)
`idle → loading → handshaking → running`; `loading|handshaking|running → crashed → restarting → loading` (backoff);
`crashed → failed` when crashes in `periodMs` exceed `intensity`; `* → killed` (kill switch, violation budget, `kill()`);
`failed|killed → restarting` via `restart()`; `* → stopped` (terminal). Crash causes: realm port closed/error, handshake
timeout or wrong id, two missed heartbeats.

## Semantics
- Guard order for every plugin message (before the Link): rate (token bucket) → size (`estimateBytes`) → envelope shape →
  channel allowlist → payload guard. Rejected requests are answered with the error; everything rejected is a `violation`
  telemetry event (critical, subsystem `sandbox/host`) + `sandbox/violations` metric + `onViolation`. More than
  `maxViolations` per window kills the plugin.
- Calls: running? → granted? (SF-SBX-002) → concurrency (SF-SBX-004) → `registry.invoke(id, input, { subject, origin:
  { channel: 'sandbox/plugin', details: { kind: 'plugin', id, version } }, signal, parent: span })` with `callTimeoutMs`
  (SF-SBX-005). Each call is a `sandbox.call` span (parent of `capability.invoke`) + `sandbox/calls` / `sandbox/call-duration`.
- Grants ⊆ manifest capabilities. Default: all requested (`autoGrant`), or `grantPolicy` / `load({ grants })`. `revoke` aborts
  in-flight calls of that capability and pushes `sandbox/grants`.
- Events reach a plugin only if declared in its manifest AND offered by the host (`events`).
- iframe: `sandbox="allow-scripts"` (+ allowed extras; `allow-same-origin`/top-navigation refused), `srcdoc` with CSP meta
  (`default-src 'none'`, `connect-src 'none'`, scripts pinned to the entry origin or a nonce), `referrerpolicy=no-referrer`,
  `credentialless`, empty `allow`. No `render` → hidden. Cross-origin module entries need CORS for `Origin: null`.
- worker: no DOM but same origin (network/storage) — hence `acknowledgeSameOrigin: true`. Prefer iframe for untrusted code.

## Rules
- Treat everything from the realm as untrusted input; never add a channel without adding it to `PLUGIN_ALLOWED` and a guard.
- Never pass the plugin anything but the MessagePort; never use `allow-same-origin`.
- Plugin calls use a non-user subject (default `'agent'`) so destructive capabilities always need confirmation.

## Test
`npx vitest run packages/sandbox` · `npx tsc -p packages/sandbox --noEmit` (in-memory realms; a load-event shim for iframes).

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/sandbox (host) | 8 KB | packages/sandbox/dist/index.js · import `{ createPluginHost }` |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/capabilities`, `@staticflux/core`, `@staticflux/worker`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
