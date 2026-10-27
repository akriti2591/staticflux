# apps/instaflow/src/settings — AGENTS.md

**Work package:** Instaflow M1c **B11c slice 2** Settings and density (IF-36.41, IF-36.42, IF-36.46; LIFECYCLES §38 density,
SURF-17). **Layer:** app.
**Depends on:** `@staticflux/core` (box, watch, scope), `@staticflux/ui` (+ `/theme`), `@staticflux/kit` (button, disclosure, segmented,
shortcut-sheet). **Never** the editor, render, Loro, worker, Wasm or GPU code: Home renders `<if-settings>` as a page
(`../home/home-imports.test.ts` allows this folder).
**Used by:** `../home` (the Settings page in Home's shell, the density and units on Home), `../app/studio-app.ts` (the Settings dialog over
Studio, the density both ways with the spec, Reset hints, the shortcut snapshot).
**Budget:** counts in Home's boot (`.size-limit.json`, "@instaflow/app/home").

## Purpose
What this device remembers for Home and Studio alike, and the one Settings view both surfaces show.

## Public API (by file)
- `device-settings.ts` — `createDeviceSettings({ storage?, window? })` → `DeviceSettings` (`current` reactive, `set(patch)`,
  `apply(root, scope)`: `data-sf-density` / `data-sf-motion` on the root, follows other tabs), `DeviceSettingsValue` (`density`, `motion`,
  `units`, `hints`), `DEFAULT_DEVICE_SETTINGS` (Standard, follow the system, px, hints on), `DEVICE_SETTINGS_KEY`
  (`instaflow/ui/settings`), `DEVICE_DENSITIES`, `MOTION_SETTINGS`, `UNIT_SETTINGS`, `DENSITY_LINES` (the one-liners), `nextDensity`
  (the `Mod+.` cycle), `parseDeviceSettings` (tolerant).
- `settings-element.ts` — `<if-settings section settings storage shortcuts diagnostics userFonts>` (`defineSettings`, `SETTINGS_TAG`):
  General (density cards with preview drawings; `More ▾`: units, reduced motion, hints, Reset hints), Keyboard shortcuts (the cheat
  sheet), Storage (usage bar, persistence and the request, Open Trash), About (version, Copy diagnostics, licences). Events:
  `if-section` (`{ section }`), `if-reset-hints`, `if-open-trash`. `focusSection()`. `SETTINGS_SECTIONS`, `settingsMessages`,
  `SettingsStorage`, `INSTAFLOW_VERSION`, `LICENCES`, `diagnosticsText({ surface, density, extra? })` (no document content).
- `shortcuts-snapshot.ts` — `SHORTCUTS_SNAPSHOT_KEY` (`instaflow/ui/shortcuts`), `writeShortcutsSnapshot` (Studio, when it mounts and
  when the cheat sheet opens), `readShortcutsSnapshot` (Home, tolerant), `HINT_STORAGE_PREFIXES`, `resetHintsOnDevice(storage, prefixes)`.

## Semantics (do not regress)
- Per device only (NAVIGATION §2.3): never in a document, a milestone, an export or a URL. Blocked storage keeps the value for this tab.
- One value: Studio keeps the spec's density and the device setting equal (`studio-app.ts`); a mode only reveals, never moves a control
  (DENSITY §1).
- The element decides nothing about routing: the host turns `if-section` into a URL (Home: a replaced `/settings/:section`; Studio: a
  replaced `?section=` on `/d/settings`).

## Rules
- Repo rules 1–10. UI from the kit under Clean Pop; a new setting is a field in `DeviceSettingsValue` with its parse rule and a row in
  the section's table, never a branch elsewhere.

## Test
`settings-element.test.ts` (device settings, the snapshot and Reset hints, every section audited under Clean Pop); Home's
`home-element.test.ts` (the page, Pro Home and Files), `studio-app.test.ts` (density both ways, `Mod+.`).
