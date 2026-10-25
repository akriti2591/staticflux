/**
 * Accessibility pairs of the theme contract: which token combinations must meet WCAG 2.2
 * AA contrast. Read by the testkit theme contract (`runThemeContract`) and by theme tooling;
 * not needed at runtime (own module, so apps never bundle it).
 */
import { themeTokens } from './theme-contract.js';
import type { ThemeToken } from './theme-tokens.js';

const c = themeTokens.color;

/** Text/background pairs that must reach 4.5:1 (SC 1.4.3) in every scheme and contrast. */
export const TEXT_CONTRAST_PAIRS: readonly (readonly [ThemeToken, ThemeToken])[] = [
  ...[c.canvas, c.surface1, c.surface2, c.surface3, c.surfaceSunken].flatMap((bg) => [[c.text, bg] as const, [c.textMuted, bg] as const]),
  [c.text, c.surfaceSelected],
  [c.text, c.surfaceHover],
  [c.accentText, c.surface1],
  [c.accentText, c.surface2],
  [c.textOnAccent, c.accent],
  [c.textOnAccent, c.accentHover],
  [c.successText, c.surface1],
  [c.successText, c.successSubtle],
  [c.warningText, c.surface1],
  [c.warningText, c.warningSubtle],
  [c.dangerText, c.surface1],
  [c.dangerText, c.dangerSubtle],
  [c.infoText, c.surface1],
  [c.infoText, c.infoSubtle],
  [c.textOnAccent, c.danger],
  [c.onAgent, c.agent],
  [c.onAgent, c.agentHover],
  [c.agentInk, c.agentSoft],
  [c.agentInk, c.surface1],
  [c.text, c.neutral3],
  [c.textMuted, c.neutral3],
];

/** Non-text pairs that must reach 3:1 (SC 1.4.11 controls, SC 2.4.13 focus, placeholder text). */
export const UI_CONTRAST_PAIRS: readonly (readonly [ThemeToken, ThemeToken])[] = [
  [c.focusRing, c.canvas],
  [c.focusRing, c.surface1],
  [c.focusRing, c.surface3],
  [c.borderStrong, c.surface1],
  [c.borderStrong, c.surfaceSunken],
  [c.accent, c.surface1],
  [c.textSubtle, c.surface1],
  [c.textSubtle, c.surfaceSunken],
  [c.controlEdge, c.canvas],
  [c.controlEdge, c.surface1],
  [c.controlEdge, c.surfaceSunken],
  [c.agent, c.surface1],
];
