/**
 * The StaticFlux theme contract: the one token set every theme fills and every kit
 * component reads (`themeTokens.color.text.css`). Brand themes (e.g. the Instaflow theme)
 * supply values for these tokens; they never add private tokens that components depend on.
 *
 * Categories: color (neutral ramp, surface levels, text levels, borders and control
 * edges, one accent, agent actions, semantic success/warning/danger/info, focus ring),
 * font (UI, mono, display) + type scale, spacing on a
 * 4 px grid, control sizes (density-dependent), radius (incl. control shape), elevation,
 * motion, z-index.
 *
 * Density (`focus | standard | pro`) overrides `space.*` and `size.*`; reduced motion
 * overrides `motion.*` durations. Legacy `--sf-*` variables that framework elements
 * shipped before the contract (`--sf-color-bg`, `--sf-space-2`, …) are emitted as
 * aliases of contract tokens (`legacyAliases`), so shell, messaging and skeleton styles
 * follow the active theme without changes.
 */
import { defineTokens, type GroupsOf, type PartialTokenValues, type ThemeToken, type TokenValues } from './theme-tokens.js';

export const themeTokens = /* @__PURE__ */ defineTokens('sf', {
  color: [
    'neutral1', // Neutral ramp step 1: app background
    'neutral2', // Neutral ramp step 2: subtle background
    'neutral3', // Neutral ramp step 3: control background
    'neutral4', // Neutral ramp step 4: control hover
    'neutral5', // Neutral ramp step 5: control pressed / selected
    'neutral6', // Neutral ramp step 6: subtle borders, dividers
    'neutral7', // Neutral ramp step 7: borders
    'neutral8', // Neutral ramp step 8: strong borders (≥ 3:1 on surfaces)
    'neutral9', // Neutral ramp step 9: solid neutral
    'neutral10', // Neutral ramp step 10: solid neutral hover
    'neutral11', // Neutral ramp step 11: secondary text (≥ 4.5:1)
    'neutral12', // Neutral ramp step 12: primary text
    'canvas', // Behind everything (the editor canvas surround, the page)
    'surface1', // Panels, docks, toolbars (level 1)
    'surface2', // Raised: menus, popovers, cards (level 2)
    'surface3', // Overlays: dialogs, palettes (level 3)
    'surfaceSunken', // Wells and field backgrounds
    'surfaceHover', // Hover tint for rows and quiet controls
    'surfaceActive', // Pressed tint for rows and quiet controls
    'surfaceSelected', // Selected rows and items
    'text', // Primary text (≥ 4.5:1 on every surface)
    'textMuted', // Secondary text (≥ 4.5:1 on every surface)
    'textSubtle', // Placeholder and tertiary text (≥ 3:1)
    'textDisabled', // Disabled text (exempt from contrast minimums)
    'textOnAccent', // Text and icons on the accent fill
    'border', // Hairline borders and dividers
    'borderStrong', // Strong outlines (≥ 3:1 on surfaces, SC 1.4.11)
    'controlEdge', // Edge of controls (secondary buttons, fields, segmented tracks); not a divider (≥ 3:1 on surfaces)
    'accent', // The single accent: primary actions, selection
    'accentHover', // Accent fill on hover
    'accentActive', // Accent fill when pressed
    'accentSubtle', // Accent tint for selected backgrounds
    'accentText', // Accent-colored text and links (≥ 4.5:1)
    'agent', // Agent (generative) action fill: hands work to an agent
    'agentHover', // Agent fill on hover / pressed
    'onAgent', // Text and icons on the agent fill (≥ 4.5:1)
    'agentSoft', // Soft agent fill: agent actions inside toolbars, agent tags
    'agentInk', // Text on the soft agent fill and agent-colored text (≥ 4.5:1)
    'success', // Success fill
    'successSubtle', // Success background tint
    'successText', // Success text (≥ 4.5:1)
    'warning', // Warning fill
    'warningSubtle', // Warning background tint
    'warningText', // Warning text (≥ 4.5:1)
    'danger', // Danger fill (destructive actions)
    'dangerSubtle', // Danger background tint
    'dangerText', // Danger text (≥ 4.5:1)
    'info', // Info fill
    'infoSubtle', // Info background tint
    'infoText', // Info text (≥ 4.5:1)
    'focusRing', // Keyboard focus indicator (≥ 3:1 against surfaces, SC 2.4.13)
    'backdrop', // Modal backdrop
    'skeleton', // Placeholder shimmer
  ],
  font: [
    'family', // UI font stack
    'familyMono', // Monospace stack (shortcuts, code, numbers)
    'familyDisplay', // Display stack (headings, titles)
    'weightRegular', // Regular weight
    'weightMedium', // Medium weight (labels, buttons)
    'weightSemibold', // Semibold weight (headings)
    'weightDisplay', // Display headings weight
  ],
  type: [
    'sizeXs', // Extra small (captions, badges)
    'sizeSm', // Small (dense UI, secondary)
    'sizeMd', // Body and controls
    'sizeLg', // Section titles
    'sizeXl', // Dialog titles
    'size2xl', // Page titles
    'lineTight', // Line height for controls and single lines
    'lineNormal', // Line height for paragraphs
  ],
  space: [
    'xs', // Spacing step 1 (4 px grid)
    'sm', // Spacing step 2
    'md', // Spacing step 3
    'lg', // Spacing step 4
    'xl', // Spacing step 5
    'xxl', // Spacing step 6
  ],
  size: [
    'controlSm', // Small control height (≥ 24 px, SC 2.5.8)
    'control', // Default control height
    'controlLg', // Large control height
    'row', // List, tree and inspector row height
    'toolbar', // Toolbar height
    'icon', // Icon size in controls
    'railWidth', // Collapsed dock rail width
  ],
  radius: [
    'sm', // Small radius (chips, inputs in dense UI)
    'md', // Default radius (controls, menus)
    'lg', // Large radius (dialogs, panels)
    'full', // Pill / circle
    'control', // Pressable controls: buttons, icon buttons, segmented tracks and segments, tags
  ],
  shadow: [
    'level1', // Elevation 1: raised (menus, popovers)
    'level2', // Elevation 2: floating (palettes, toasts)
    'level3', // Elevation 3: modal (dialogs)
  ],
  motion: [
    'durationFast', // Micro interactions (hover, press): 120 ms
    'durationNormal', // Enter/exit of small surfaces: 160 ms
    'durationSlow', // Larger surfaces: 200 ms
    'easeStandard', // Standard easing
    'easeEnter', // Entering easing (decelerate)
    'easeExit', // Exiting easing (accelerate)
  ],
  z: [
    'raised', // Sticky headers, resize handles
    'overlay', // Fallback layer for popovers without the Popover API
    'toast', // Fallback layer for toasts
    'tooltip', // Fallback layer for tooltips
  ],
});

export type ThemeTokens = typeof themeTokens;
export type ThemeGroups = GroupsOf<ThemeTokens>;

/** A complete value map for the contract. */
export type ThemeValues = TokenValues<ThemeGroups>;
/** A partial value map (variants). */
export type PartialThemeValues = PartialTokenValues<ThemeGroups>;

const c = themeTokens.color;

/** Pre-contract `--sf-*` variables (shell, messaging, skeleton, site) → contract tokens. */
export const legacyAliases: Readonly<Record<`--sf-${string}`, ThemeToken>> = {
  '--sf-color-bg': c.canvas,
  '--sf-color-fg': c.text,
  '--sf-color-surface': c.surface1,
  '--sf-color-muted': c.textMuted,
  '--sf-color-accent-fg': c.textOnAccent,
  '--sf-color-focus': c.focusRing,
  '--sf-font-body': themeTokens.font.family,
  '--sf-font-mono': themeTokens.font.familyMono,
  '--sf-radius': themeTokens.radius.md,
  '--sf-radius-small': themeTokens.radius.sm,
  '--sf-space-1': themeTokens.space.xs,
  '--sf-space-2': themeTokens.space.sm,
  '--sf-space-3': themeTokens.space.lg,
  '--sf-space-4': themeTokens.space.xl,
  '--sf-shadow-overlay': themeTokens.shadow.level3,
  '--sf-motion-duration': themeTokens.motion.durationNormal,
};
