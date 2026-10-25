/**
 * Theme contract suite (R13.11–R13.14, R15.1). Every theme over the StaticFlux token
 * contract (`themeTokens` from `@staticflux/ui/theme`) runs it — the default theme, the
 * Instaflow brand theme, any app theme:
 *
 * - complete and valid (`validateTheme`), compiles to CSS;
 * - WCAG 2.2 AA: every `TEXT_CONTRAST_PAIRS` pair ≥ 4.5:1 and every `UI_CONTRAST_PAIRS` pair
 *   ≥ 3:1, in light, dark, and both `contrast: more` variants;
 * - spacing on a 4 px grid in every density; control heights ordered Focus ≥ Standard ≥ Pro
 *   and never below 24 px (SC 2.5.8 target size);
 * - motion durations within 120–200 ms (0 allowed only when reduced) and 0 under reduced motion.
 *
 * @example
 * runThemeContract('default theme', () => defaultTheme, { describe, it });
 */
import {
  compileTheme,
  contrastRatio,
  DENSITIES,
  type ResolvedAppearance,
  resolveThemeValues,
  TEXT_CONTRAST_PAIRS,
  type ThemeDef,
  type ThemeToken,
  themeTokens,
  UI_CONTRAST_PAIRS,
  validateTheme,
  valueOf,
} from '@staticflux/ui/theme';
import { assertTrue, type ContractRunner } from './contract-runner.js';

export type ContractTheme = ThemeDef;

export interface ThemeContractCase {
  readonly name: string;
  run(theme: ContractTheme): Promise<void>;
}

export interface ThemeContractOptions {
  readonly skip?: readonly string[];
}

const BASE: ResolvedAppearance = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' };
const COLOR_APPEARANCES: readonly ResolvedAppearance[] = [
  BASE,
  { ...BASE, scheme: 'dark' },
  { ...BASE, contrast: 'more' },
  { ...BASE, scheme: 'dark', contrast: 'more' },
];

const label = (a: ResolvedAppearance): string => `${a.scheme}/${a.contrast}/${a.density}/${a.motion}`;

function px(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match === null ? undefined : Number(match[1]);
}

function ms(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (match === null) return undefined;
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
}

function checkPairs(theme: ContractTheme, pairs: readonly (readonly [ThemeToken, ThemeToken])[], minimum: number): string[] {
  const failures: string[] = [];
  for (const appearance of COLOR_APPEARANCES) {
    const values = resolveThemeValues(theme, appearance);
    for (const [fg, bg] of pairs) {
      const ratio = contrastRatio(valueOf(values, fg) ?? '', valueOf(values, bg) ?? '');
      if (!ratio.ok) failures.push(`${label(appearance)} ${fg.name} on ${bg.name}: ${ratio.error.message}`);
      else if (ratio.value < minimum) failures.push(`${label(appearance)} ${fg.name} on ${bg.name}: ${ratio.value}:1 < ${minimum}:1`);
    }
  }
  return failures;
}

const failIf = (failures: readonly string[], what: string): void =>
  assertTrue(failures.length === 0, `${what}:\n  ${failures.slice(0, 12).join('\n  ')}${failures.length > 12 ? `\n  … ${failures.length - 12} more` : ''}`);

export const themeContractCases: readonly ThemeContractCase[] = [
  {
    name: 'is complete, valid and compiles',
    async run(theme) {
      const valid = validateTheme(theme);
      assertTrue(valid.ok, valid.ok ? '' : `${valid.error.message} ${JSON.stringify(valid.error.details)}`);
      assertTrue(theme.tokens === themeTokens, 'the theme fills the StaticFlux token contract (themeTokens)');
      const cssText = compileTheme(theme);
      assertTrue(cssText.includes(themeTokens.color.text.property) && !cssText.includes('undefined'), 'compiled CSS declares the contract');
    },
  },
  {
    name: 'text reaches 4.5:1 on its surfaces (SC 1.4.3) in every scheme and contrast',
    async run(theme) {
      failIf(checkPairs(theme, TEXT_CONTRAST_PAIRS, 4.5), 'text contrast below AA');
    },
  },
  {
    name: 'controls, focus ring and placeholders reach 3:1 (SC 1.4.11, 2.4.13)',
    async run(theme) {
      failIf(checkPairs(theme, UI_CONTRAST_PAIRS, 3), 'non-text contrast below AA');
    },
  },
  {
    name: 'spacing sits on a 4 px grid in every density',
    async run(theme) {
      const failures: string[] = [];
      for (const density of DENSITIES) {
        const values = resolveThemeValues(theme, { ...BASE, density });
        for (const token of Object.values(themeTokens.space)) {
          const value = px(valueOf(values, token));
          if (value === undefined || value % 4 !== 0 || value <= 0) failures.push(`${density} ${token.name} = ${valueOf(values, token) ?? '—'}`);
        }
      }
      failIf(failures, 'spacing off the 4 px grid');
    },
  },
  {
    name: 'control heights: Focus ≥ Standard ≥ Pro, never below 24 px (SC 2.5.8)',
    async run(theme) {
      const failures: string[] = [];
      const heights = [themeTokens.size.controlSm, themeTokens.size.control, themeTokens.size.controlLg, themeTokens.size.row];
      const at = (density: (typeof DENSITIES)[number], token: ThemeToken): number | undefined => px(valueOf(resolveThemeValues(theme, { ...BASE, density }), token));
      for (const token of heights) {
        const [focus, standard, pro] = [at('focus', token), at('standard', token), at('pro', token)];
        if (focus === undefined || standard === undefined || pro === undefined) {
          failures.push(`${token.name}: not a px value`);
          continue;
        }
        if (!(focus >= standard && standard >= pro)) failures.push(`${token.name}: focus ${focus} / standard ${standard} / pro ${pro}`);
        if (pro < 24) failures.push(`${token.name}: ${pro}px < 24px in pro`);
      }
      failIf(failures, 'density sizes');
    },
  },
  {
    name: 'motion stays within 120–200 ms and is 0 under reduced motion',
    async run(theme) {
      const failures: string[] = [];
      const durations = [themeTokens.motion.durationFast, themeTokens.motion.durationNormal, themeTokens.motion.durationSlow];
      const full = resolveThemeValues(theme, BASE);
      const reduced = resolveThemeValues(theme, { ...BASE, motion: 'reduce' });
      for (const token of durations) {
        const value = ms(valueOf(full, token));
        if (value === undefined || value < 120 || value > 200) failures.push(`${token.name} = ${valueOf(full, token) ?? '—'} (full motion)`);
        if (ms(valueOf(reduced, token)) !== 0) failures.push(`${token.name} = ${valueOf(reduced, token) ?? '—'} (reduced motion)`);
      }
      failIf(failures, 'motion');
    },
  },
];

/** Run the theme contract against a theme factory. */
export function runThemeContract(name: string, factory: () => ContractTheme | Promise<ContractTheme>, runner: ContractRunner, options: ThemeContractOptions = {}): void {
  const skip = new Set(options.skip ?? []);
  runner.describe(`Theme contract: ${name}`, () => {
    for (const testCase of themeContractCases) {
      if (skip.has(testCase.name)) continue;
      runner.it(testCase.name, async () => testCase.run(await factory()));
    }
  });
}
