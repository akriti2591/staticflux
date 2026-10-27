# UI component inventory (generated 2026-10-27)

Every custom element in the repo (`tag:` / `*_TAG` / `customElements.define`), with its file. Regenerate with the
command in `docs/instaflow/handoffs/COORDINATOR.md` (UI inventory). Render-helper UI without its own element
(inspector rows and stacks in `apps/instaflow/src/studio/inspector-*.ts`, HUD controls in `studio/hud.ts`) is listed
at the end.

| Element | File |
|---|---|
| `if-command-bar` | `apps/instaflow/src/studio/command-bar.ts` |
| `if-export-panel` | `apps/instaflow/src/export/panel.ts` |
| `if-find-bar` | `apps/instaflow/src/studio/find-bar.ts` |
| `if-home` | `apps/instaflow/src/home/home-element.ts` |
| `if-hud` | `apps/instaflow/src/studio/hud.ts` |
| `if-inspector` | `apps/instaflow/src/studio/inspector.ts` |
| `if-layers-panel` | `apps/instaflow/src/studio/layers-panel.ts` |
| `if-library-panel` | `apps/instaflow/src/library/library-panel.ts` |
| `if-milestones-panel` | `apps/instaflow/src/versioning/milestones-panel.ts` |
| `if-missing-design` | `apps/instaflow/src/home/missing-design.ts` |
| `if-new-design` | `apps/instaflow/src/home/new-design.ts` |
| `if-pages-panel` | `apps/instaflow/src/lenses/pages-panel.ts` |
| `if-paint-inspector` | `apps/instaflow/src/elements/panel.ts` |
| `if-repeat-inspector` | `apps/instaflow/src/repeat/panel.ts` |
| `if-save-status` | `apps/instaflow/src/versioning/save-status.ts` |
| `if-settings` | `apps/instaflow/src/settings/settings-element.ts` |
| `if-studio` | `apps/instaflow/src/studio/studio-element.ts` |
| `if-transform-bar` | `apps/instaflow/src/tools/transform-bar.ts` |
| `if-typography-panel` | `apps/instaflow/src/text/typography-panel.ts` |
| `sf-align-popover` | `packages/kit/src/align-popover.ts` |
| `sf-anonymous` | `packages/ui/src/element.ts` |
| `sf-banner` | `packages/kit/src/feedback.ts` |
| `sf-blocking-error` | `packages/kit/src/feedback.ts` |
| `sf-boundary` | `packages/shell/src/boundary.ts` |
| `sf-button` | `packages/kit/src/button.ts` |
| `sf-capability-palette` | `packages/kit/src/command-palette.ts` |
| `sf-card` | `packages/kit/src/card.ts` |
| `sf-color-field` | `packages/kit/src/color-field.ts` |
| `sf-color-popover` | `packages/kit/src/color-popover.ts` |
| `sf-command-palette` | `packages/shell/src/palette.ts` |
| `sf-confirm-row` | `packages/kit/src/confirm-row.ts` |
| `sf-copy-field` | `packages/kit/src/copy-field.ts` |
| `sf-devtools` | `packages/devtools/src/panel.ts` |
| `sf-dialog` | `packages/kit/src/surfaces.ts` |
| `sf-disclosure` | `packages/kit/src/disclosure.ts` |
| `sf-dock` | `packages/kit/src/dock.ts` |
| `sf-font-picker` | `packages/kit/src/font-picker.ts` |
| `sf-hint` | `packages/kit/src/hint.ts` |
| `sf-icon` | `packages/kit/src/icon.ts` |
| `sf-icon-button` | `packages/kit/src/icon-button.ts` |
| `sf-inline-edit` | `packages/kit/src/inline-edit.ts` |
| `sf-inspector-group` | `packages/kit/src/inspector.ts` |
| `sf-inspector-row` | `packages/kit/src/inspector.ts` |
| `sf-island` | `packages/hydrate/src/marker.ts` |
| `sf-menu` | `packages/kit/src/menu.ts` |
| `sf-menu-group` | `packages/kit/src/menu.ts` |
| `sf-menu-item` | `packages/kit/src/menu.ts` |
| `sf-number-field` | `packages/kit/src/number-field.ts` |
| `sf-panel` | `packages/kit/src/dock.ts` |
| `sf-popover` | `packages/kit/src/popover.ts` |
| `sf-progress-row` | `packages/kit/src/feedback.ts` |
| `sf-scope` | `packages/ui/src/scope.ts` |
| `sf-segmented` | `packages/kit/src/segmented.ts` |
| `sf-shell` | `packages/shell/src/shell-element.ts` |
| `sf-shortcut-sheet` | `packages/kit/src/shortcut-sheet.ts` |
| `sf-size-field` | `packages/kit/src/size-field.ts` |
| `sf-skeleton` | `packages/ui/src/skeleton.ts` |
| `sf-skip-links` | `packages/shell/src/skip-links.ts` |
| `sf-slider` | `packages/kit/src/slider.ts` |
| `sf-status` | `packages/kit/src/status.ts` |
| `sf-surface-host` | `packages/messaging/src/host.ts` |
| `sf-surface-layer` | `packages/kit/src/surfaces.ts` |
| `sf-surface-outlet` | `packages/messaging/src/outlet.ts` |
| `sf-swatch` | `packages/kit/src/swatch.ts` |
| `sf-tab` | `packages/kit/src/tabs.ts` |
| `sf-tab-panel` | `packages/kit/src/tabs.ts` |
| `sf-tabs` | `packages/kit/src/tabs.ts` |
| `sf-tag` | `packages/kit/src/tag.ts` |
| `sf-takeover` | `packages/kit/src/surfaces.ts` |
| `sf-text-field` | `packages/kit/src/text-field.ts` |
| `sf-toast` | `packages/kit/src/surfaces.ts` |
| `sf-toolbar` | `packages/kit/src/toolbar.ts` |
| `sf-tooltip` | `packages/kit/src/tooltip.ts` |
| `sf-tree` | `packages/kit/src/tree.ts` |

Render helpers (no element of their own): `studio/inspector-paint.ts` (paint rows, fill/stroke/effects stacks, + Add),
`studio/inspector-text.ts`, `studio/inspector.ts` sections, `studio/hud.ts` controls, `studio/context-menu.ts` menus.
