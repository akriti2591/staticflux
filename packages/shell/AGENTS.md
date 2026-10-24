# @staticflux/shell — AGENTS.md

**Layer:** shell (depends on `@staticflux/core`, `@staticflux/ui`, `@staticflux/messaging`, `@staticflux/a11y`, `lit` 3.3.3).
**Budget:** no size-limit entry yet; `<sf-shell>` + slots + workspace + theme ≈ 5 KB gzip (tsc output);
palette/commands/shortcuts ≈ 3 KB, loadable after first render.

## Purpose
The app frame: layout regions (slots) filled by contributions, per-region error boundaries, skeletons,
design-token theming (light/dark/high-contrast), workspaces as declarative config, command palette,
keyboard shortcuts (glue over the a11y registry), skip links + landmarks, View Transitions, shell presets per app profile.
Implements R13.1–R13.3, R12.19 (view transitions, placeholders), R15.2/R15.3 (shell parts), R18.4/R18.5 (presets).

## Public API (by file)
- `slots.ts` — `BUILT_IN_SLOTS`, `SlotId` (open via `Registry.slots`), `SlotContribution`, `SlotContributionsToken` (multi),
  `slotContribution(item)`.
- `workspace.ts` — `defineWorkspace({ id, label, gate, add, remove, swap, move, order, features })`, `defaultWorkspace`,
  `arrangeSlots(contributions, workspace, allowed)` (pure), `createWorkspaceManager({ workspaces, initial, decide, store })`
  → `current`, `switchTo`, `restore`, `onSwitch`; `WorkspacesToken` (multi), `WorkspaceManagerToken`,
  `WorkspacePreferenceStoreToken`, `workspaceContribution`.
- `presets.ts` — `defineShellPreset` (optional `skipTargets`), `shellPresets` (expanded, medium, compact, embedded), `ShellPresetToken`, `shellPresetUnit`.
- `theme.ts` — `DesignTokens`, `tokenVar`, `cssVar`, `defineTheme`, `lightTheme`/`darkTheme`/`highContrastTheme`,
  `themeToCss`, `createThemeController({ media, store })` (`preference`, `theme`, `forcedColors`, `set`, `restore`,
  `apply(element, scope)`), `browserMedia`, `ThemeControllerToken`, `ThemePreferenceStoreToken`.
- `commands.ts` — `defineCommand` (`shortcut?: KeyCombo`, `shortcutScope?: ShortcutScopeDef` from a11y), `CommandsToken` (multi), `commandContribution`, `createCommandRegistry`
  (`search`, `run`, `available`, `register(cmd, scope)`, `refreshDecisions`), `fuzzyMatch`, `CommandRegistryToken`.
- `shortcuts.ts` — thin glue over `@staticflux/a11y` shortcuts (registry, `KeyCombo`, scopes, conflicts, labels and
  `checkShortcuts` all live there): `CommandPaletteShortcut` (`Mod+K`, global, fires in inputs), `commandShortcut(cmd)`,
  `commandShortcutDefs(cmds)` (feed to `checkShortcuts` in CI), `bindCommandShortcut`/`bindCommandShortcuts`
  (`when` = command available, runs with `source: 'shortcut'`), `commandShortcutLabels`, `CommandShortcutBindingsToken`.
- `palette.ts` — `<sf-command-palette>` (`registry`, `shortcuts` → `<kbd>` labels), `commandPaletteSurface` (a messaging
  dialog), `openCommandPalette({ manager, registry, owner, shortcuts? })`, `bindCommandPalette({ …, shortcut? })`, `CommandRanEvent`.
- `skip-links.ts` — `<sf-skip-links>` (`links`, `label`, `focusManager`, `resolve`; `skipTo(slot)`, `SkipLinkEvent`),
  `defineSkipLinks`, `skipLinksFor(rendered, targets, messages)` (pure), `focusSkipTarget`, `DEFAULT_SKIP_TARGETS`,
  `SLOT_LANDMARKS`/`landmarkOf`, `ShellMessages`/`defaultShellMessages`/`ShellMessagesToken` (localized labels, app-bound).
- `transitions.ts` — `withViewTransition(update, { document, reducedMotion, signal })` → `Result<{ animated }>`.
- `boundary.ts` — `<sf-boundary region label>` (catches `sf-error`, fallback with Retry, metric `shell/boundary-errors`).
- `shell-element.ts` — `<sf-shell>` (`defineShell`): preset grid, workspace-arranged contributions in boundaries,
  gated contributions hidden until allowed, theme applied, `switchWorkspace(id)` in a View Transition; skip links first,
  landmarks (header→banner, sidebar→`nav`, `main`, panel→`aside` complementary, other slots→named region); lazy deps
  a11y `FocusManagerToken`, `ShellMessagesToken`, `CommandShortcutBindingsToken` (idle).
- `units.ts` — `shellUnits`, `workspaceManagerUnit`, `commandRegistryUnit`, `themeControllerUnit`, `defaultShellPresetUnit`;
  `commandShortcutsUnit` / `shellKeyboardUnits` (binds palette + command shortcuts into a11y `ShortcutRegistryToken`;
  needs a11y units + `SurfaceManagerToken`; conflicts land in `bindings.errors` as `SF-A11Y-002`, telemetry `shell.shortcut-error`).
- `telemetry.ts` — `SHELL_SUBSYSTEM` (`shell/layout`), `shellMetrics`. `errors.ts` — `SF-SHELL-001, 002, 005…008`
  (003/004 retired → `SF-A11Y-002`/`SF-A11Y-003`).

## Rules
- Features fill slots via contributions only; the shell never imports features. Workspace feature swaps are
  data (`features`) handled by the app's `onSwitch`.
- No `if/else` on modes: pick a preset per profile by binding `ShellPresetToken`.
- Preferences persist through async KV ports (AsyncStore-compatible), never sync storage.
- Keyboard: a11y units are the source of truth (`ShortcutRegistryToken`, `FocusManagerToken`); shell never creates its own
  registry or keydown listener. Command `shortcut`s are typed `KeyCombo`s; CI runs `checkShortcuts` over them.
- No i18n dependency: user-facing shell strings come from `ShellMessagesToken` (or element props).

## Test
`npx vitest run packages/shell` · `npx tsc -p packages/shell --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/shell (full, excl. lit) | 9.5 KB | packages/shell/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** shell

- Internal: `@staticflux/a11y`, `@staticflux/core`, `@staticflux/messaging`, `@staticflux/ui`
- External: `lit` (3.3.3)

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
