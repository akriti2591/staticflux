# @staticflux/shell — AGENTS.md

**Layer:** shell (depends on `@staticflux/core`, `@staticflux/ui`, `@staticflux/messaging`, `lit` 3.3.3).
**Budget:** no size-limit entry yet; `<sf-shell>` + slots + workspace + theme ≈ 5 KB gzip (tsc output);
palette/commands/shortcuts ≈ 3 KB, loadable after first render.

## Purpose
The app frame: layout regions (slots) filled by contributions, per-region error boundaries, skeletons,
design-token theming (light/dark/high-contrast), workspaces as declarative config, command palette,
keyboard shortcuts, View Transitions, shell presets per app profile.
Implements R13.1–R13.3, R12.19 (view transitions, placeholders), R15.2/R15.3 (shell parts), R18.4/R18.5 (presets).

## Public API (by file)
- `slots.ts` — `BUILT_IN_SLOTS`, `SlotId` (open via `Registry.slots`), `SlotContribution`, `SlotContributionsToken` (multi),
  `slotContribution(item)`.
- `workspace.ts` — `defineWorkspace({ id, label, gate, add, remove, swap, move, order, features })`, `defaultWorkspace`,
  `arrangeSlots(contributions, workspace, allowed)` (pure), `createWorkspaceManager({ workspaces, initial, decide, store })`
  → `current`, `switchTo`, `restore`, `onSwitch`; `WorkspacesToken` (multi), `WorkspaceManagerToken`,
  `WorkspacePreferenceStoreToken`, `workspaceContribution`.
- `presets.ts` — `defineShellPreset`, `shellPresets` (expanded, medium, compact, embedded), `ShellPresetToken`, `shellPresetUnit`.
- `theme.ts` — `DesignTokens`, `tokenVar`, `cssVar`, `defineTheme`, `lightTheme`/`darkTheme`/`highContrastTheme`,
  `themeToCss`, `createThemeController({ media, store })` (`preference`, `theme`, `forcedColors`, `set`, `restore`,
  `apply(element, scope)`), `browserMedia`, `ThemeControllerToken`, `ThemePreferenceStoreToken`.
- `commands.ts` — `defineCommand`, `CommandsToken` (multi), `commandContribution`, `createCommandRegistry`
  (`search`, `run`, `available`, `register(cmd, scope)`, `refreshDecisions`), `fuzzyMatch`, `CommandRegistryToken`.
- `shortcuts.ts` — `parseShortcut`, `formatShortcut`, `createShortcutRegistry({ target, scope, platform })`
  (conflicts → SF-SHELL-003, contexts, `when`, inputs ignored unless `allowInInputs`), `bindCommandShortcuts`.
- `palette.ts` — `<sf-command-palette>`, `commandPaletteSurface` (a messaging dialog), `openCommandPalette`,
  `bindCommandPalette` (default `Mod+K`), `CommandRanEvent`.
- `transitions.ts` — `withViewTransition(update, { document, reducedMotion, signal })` → `Result<{ animated }>`.
- `boundary.ts` — `<sf-boundary region label>` (catches `sf-error`, fallback with Retry, metric `shell/boundary-errors`).
- `shell-element.ts` — `<sf-shell>` (`defineShell`): preset grid, workspace-arranged contributions in boundaries,
  gated contributions hidden until allowed, theme applied, `switchWorkspace(id)` in a View Transition.
- `units.ts` — `shellUnits`, `workspaceManagerUnit`, `commandRegistryUnit`, `shortcutRegistryUnit`, `themeControllerUnit`,
  `defaultShellPresetUnit`, `ShortcutRegistryToken`.
- `telemetry.ts` — `SHELL_SUBSYSTEM` (`shell/layout`), `shellMetrics`. `errors.ts` — `SF-SHELL-001…008`.

## Rules
- Features fill slots via contributions only; the shell never imports features. Workspace feature swaps are
  data (`features`) handled by the app's `onSwitch`.
- No `if/else` on modes: pick a preset per profile by binding `ShellPresetToken`.
- Preferences persist through async KV ports (AsyncStore-compatible), never sync storage.

## Test
`npx vitest run packages/shell` · `npx tsc -p packages/shell --noEmit`
