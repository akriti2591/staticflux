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
  `apply(element, scope)`), `browserMedia` (tokens in `tokens.ts`). The pre-contract token set: new apps theme with
  `@staticflux/ui/theme` (typed tokens, density, reduced motion, themes as contributions) and leave `ThemeControllerToken`
  unbound; the ui default theme emits the same `--sf-*` names as aliases, so shell elements follow either.
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
- `tokens.ts` — `CommandsToken` (multi), `CommandRegistryToken`, `CommandShortcutBindingsToken`, `ThemeControllerToken`,
  `ThemePreferenceStoreToken` (token-only: `<sf-shell>` names them at boot while apps may defer or replace their implementation,
  e.g. Studio binds `CommandShortcutBindingsToken` to the kit capability palette).
- `units.ts` — `shellUnits`, `workspaceManagerUnit`, `themeControllerUnit`, `defaultShellPresetUnit`.
- `keyboard-units.ts` — `commandRegistryUnit`, `commandShortcutsUnit` / `shellKeyboardUnits` (binds palette + command shortcuts
  into a11y `ShortcutRegistryToken`; needs a11y units + `SurfaceManagerToken`; conflicts land in `bindings.errors` as
  `SF-A11Y-002`, telemetry `shell.shortcut-error`). Separate module: deferrable after first paint (`<sf-shell>` resolves
  the bindings when idle).
- `telemetry.ts` — `SHELL_SUBSYSTEM` (`shell/layout`), `shellMetrics`. `errors.ts` — `SF-SHELL-001, 002, 005…008`
  (003/004 retired → `SF-A11Y-002`/`SF-A11Y-003`).

### `@staticflux/shell/spec` — the layout spec runtime (R13.25–R13.30; Instaflow M1b B0, D16)
Its own entry point (budget below), not part of the shell boot entry. **Why the shell:** a spec decides *which
contributions fill which regions* — the shell's job (slots, workspaces, presets) generalized from a fixed workspace table
to declarative, validated, diffable specs. It needs only what the shell already depends on (core, ui `DecidePort` /
`GateResource`); gating reaches `@staticflux/gate` through the app-bound `DecidePort`, as workspaces and slots do, so no
new dependency. It is not kit (no elements; kit renders, the shell composes) and not app code (any app that composes screens
from contributions can use it).
- `spec-model.ts` — `defineSpecSection({ id, cardinality: one|many, pinnable, placements })`, `defineSpecContribution({ section,
  id, label, gate, when, placements })`, `createSpecVocabulary({ sections, contributions })` → `Result<SpecVocabulary>`
  (`section`, `contribution`, `list`), `ShellSpec { id, context, slots, pinned }`, `SpecSlotRequest`, `ResolvedSlot`,
  `slotKey(section, id)` (`tool:pkg/name`), `groupKey(slot)` (`panel@dock`), `DEFAULT_PLACEMENT`.
- `spec-validate.ts` — `validateSpec(spec, vocabulary, { decide, signal })` → `Result<ValidatedSpec>`; every issue at once
  (`SpecIssue { code, kind, message, fix, slot, section, details }`), `specIssues(error)`, `appliesIn(contribution, context)`.
- `spec-diff.ts` — `diffSpecs(current, next, { pinned })` → `SpecDiff { unmount (reverse order), move, mount, after (insertion
  anchors), kept, retained (pins), context, target, empty }`, `applySpecDiff` (reference), `layoutGroups`,
  `longestIncreasingSubsequence`, `MountedLayout`, `EMPTY_LAYOUT`.
- `spec-motion.ts` — `DEFAULT_SPEC_MOTION` (enter 160, move 200, exit 120, context 160 ms), `clampSpecMotion` (120–200 ms),
  `specMotionStep(motion, kind, reduced)` (0 ms under reduced motion), `SpecMotionStep`.
- `spec-runtime.ts` — `createSpecRuntime({ vocabulary, port, decide, motion, reducedMotion, telemetry })` → `state`, `layout`,
  `spec`, `pinned` (reactive), `validate`, `preview`, `apply(spec, { signal, decide })` → `SpecApplied { spec, diff, failures,
  droppedPins }`, `revalidate`, `pin`, `unpin`, `onApplied`, `dispose`; the **`SpecMountPort`** (`mount(slot, after, step, signal)`,
  `move(move, step, signal)`, `unmount(slot, step, signal)`, `context?(changes, context, step, signal)`); machine
  `SpecRuntimeLifecycle` (`shell/spec-runtime`, LIFECYCLES §20).
- `spec-layout-port.ts` — `createSpecLayoutPort({ wait })`: a reactive `SpecMountPort` a view renders from (`entries(group)` with
  phases `entering | present | moving | exiting`, `groups()`, `mountedContext`, `contextStep`).
- `spec-errors.ts` — `SF-SHELL-009` invalid (issues) · `010` unknown contribution · `011` context mismatch · `012` gated out ·
  `013` slot (duplicate, placement, cardinality, pin) · `014` mount port failed · `015` disposed.

Spec runtime rules: the vocabulary is closed (never mount what is not registered); never skip the `DecidePort` (agents get their
own subject's port per `apply`); port calls stay in the documented order and start in one task (one frame), motion is the
port's job within the given step; pins are added by specs and removed only by `unpin` or a gate denial.

## Rules
- Features fill slots via contributions only; the shell never imports features. Workspace feature swaps are
  data (`features`) handled by the app's `onSwitch`.
- No `if/else` on modes: pick a preset per profile by binding `ShellPresetToken`.
- Preferences persist through async KV ports (AsyncStore-compatible), never sync storage.
- Keyboard: a11y units are the source of truth (`ShortcutRegistryToken`, `FocusManagerToken`); shell never creates its own
  registry or keydown listener. Command `shortcut`s are typed `KeyCombo`s; CI runs `checkShortcuts` over them.
- No i18n dependency: user-facing shell strings come from `ShellMessagesToken` (or element props).

## Test
`npx vitest run packages/shell` · `npx tsc -p packages/shell --noEmit` · spec runtime suites:
`npx vitest run packages/testkit/src/spec-runtime-contract.test.ts` (`runSpecRuntimeContract`, `runSpecMountPortContract`)

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/shell (full, excl. lit) | 9.5 KB | packages/shell/dist/index.js |
| @staticflux/shell/spec (spec runtime, diff, layout port; excl. framework) | 6 KB | packages/shell/dist/spec.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** shell

- Internal: `@staticflux/a11y`, `@staticflux/core`, `@staticflux/messaging`, `@staticflux/ui`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
