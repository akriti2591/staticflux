import { runThemeContract, themeContractCases } from '@staticflux/testkit';
import { defaultTheme } from '@staticflux/ui/default-theme';
import {
  compileTheme,
  contrastRatio,
  extendTheme,
  type ResolvedAppearance,
  resolveThemeValues,
  type ThemeToken,
  themeTokens as t,
  themeValue,
  ThemesToken,
  valueOf,
} from '@staticflux/ui/theme';
import { describe, expect, it } from 'vitest';
import { cleanPopPalette as p, cleanPopTheme, cleanPopThemeContribution } from './clean-pop.js';

runThemeContract('Clean Pop (Instaflow)', () => cleanPopTheme, { describe, it });

const LIGHT: ResolvedAppearance = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' };
const APPEARANCES: readonly ResolvedAppearance[] = [LIGHT, { ...LIGHT, contrast: 'more' }, { ...LIGHT, scheme: 'dark' }, { ...LIGHT, scheme: 'dark', contrast: 'more' }];
const c = t.color;

/**
 * Every pair the design README names ("Every text/background pair above meets WCAG 2.2 AA;
 * control edges meet 3:1"), as theme tokens: fails when a token regresses.
 */
const README_PAIRS: readonly { readonly what: string; readonly fg: ThemeToken; readonly bg: ThemeToken; readonly min: number }[] = [
  { what: 'ink on page', fg: c.text, bg: c.canvas, min: 4.5 },
  { what: 'ink on white', fg: c.text, bg: c.surface1, min: 4.5 },
  { what: 'ink on mist tint (tags, switchers)', fg: c.text, bg: c.neutral3, min: 4.5 },
  { what: 'muted on page', fg: c.textMuted, bg: c.canvas, min: 4.5 },
  { what: 'muted on white', fg: c.textMuted, bg: c.surface1, min: 4.5 },
  { what: 'muted on mist tint (unselected segments)', fg: c.textMuted, bg: c.neutral3, min: 4.5 },
  { what: 'white on deep tangerine (primary)', fg: c.textOnAccent, bg: c.accent, min: 4.5 },
  { what: 'white on deep tangerine hover', fg: c.textOnAccent, bg: c.accentHover, min: 4.5 },
  { what: 'white on raspberry (Claude)', fg: c.onAgent, bg: c.agent, min: 4.5 },
  { what: 'white on raspberry hover', fg: c.onAgent, bg: c.agentHover, min: 4.5 },
  { what: 'agent ink on soft pink (Claude soft, Claude tags)', fg: c.agentInk, bg: c.agentSoft, min: 4.5 },
  { what: 'control edge on white', fg: c.controlEdge, bg: c.surface1, min: 3 },
  { what: 'control edge on page mist', fg: c.controlEdge, bg: c.canvas, min: 3 },
  { what: 'focus ring on page', fg: c.focusRing, bg: c.canvas, min: 3 },
  { what: 'focus ring on white', fg: c.focusRing, bg: c.surface1, min: 3 },
  { what: 'slider fill / thumb ring on white', fg: c.accent, bg: c.surface1, min: 3 },
];

describe('Clean Pop: the approved values', () => {
  it('maps the README colours onto the contract', () => {
    const v = (token: ThemeToken): string | undefined => valueOf(cleanPopTheme.values, token);
    expect(v(c.canvas)).toBe('#F1F4F7');
    expect(v(c.neutral3)).toBe('#E7ECF2');
    expect(v(c.border)).toBe('#DCE3EA');
    expect(v(c.controlEdge)).toBe('#7D8897');
    expect(v(c.neutral7)).toBe('#C3CCD7');
    expect(v(c.textMuted)).toBe('#56606C');
    expect(v(c.text)).toBe('#16151A');
    expect(v(c.accent)).toBe('#CF3D17');
    expect(v(c.focusRing)).toBe('#CF3D17');
    expect(v(c.agent)).toBe('#D6265F');
    expect(v(c.agentSoft)).toBe('#FDE8EF');
    expect(v(c.agentInk)).toBe('#B3174C');
    expect(v(c.surface1)).toBe('#FFFFFF');
    expect(v(c.surfaceSunken)).toBe('#FFFFFF'); // fields are white
  });

  it('has pill controls, 18 px cards, 12 px fields and the three type families', () => {
    expect(themeValue(cleanPopTheme, t.radius.control, LIGHT)).toBe('9999px');
    expect(themeValue(cleanPopTheme, t.radius.lg, LIGHT)).toBe('18px');
    expect(themeValue(cleanPopTheme, t.radius.md, LIGHT)).toBe('12px');
    expect(themeValue(cleanPopTheme, t.font.familyDisplay, LIGHT)).toMatch(/^"Bricolage Grotesque"/);
    expect(themeValue(cleanPopTheme, t.font.family, LIGHT)).toMatch(/^"Geist",/);
    expect(themeValue(cleanPopTheme, t.font.familyMono, LIGHT)).toMatch(/^"Geist Mono"/);
    expect(themeValue(cleanPopTheme, t.font.weightDisplay, LIGHT)).toBe('800');
    expect([t.size.controlLg, t.size.control, t.size.controlSm].map((token) => themeValue(cleanPopTheme, token, LIGHT))).toEqual(['42px', '34px', '28px']);
  });

  it('has no purple anywhere and keeps the default theme untouched', () => {
    const css = compileTheme(cleanPopTheme);
    expect(css).not.toMatch(/#6847d1|#a48bff/i);
    expect(valueOf(defaultTheme.values, t.radius.control)).toBe('6px');
    expect(valueOf(defaultTheme.values, c.accent)).toBe('#3a5bd9');
  });

  it('defers dark: the dark scheme repeats the light palette (TODO DS2)', () => {
    const light = resolveThemeValues(cleanPopTheme, LIGHT);
    const dark = resolveThemeValues(cleanPopTheme, { ...LIGHT, scheme: 'dark' });
    expect(dark.color).toEqual(light.color);
  });

  it('is contributed above the default theme', () => {
    expect(cleanPopThemeContribution.provides).toBe(ThemesToken);
    expect(cleanPopThemeContribution.order).toBeGreaterThan(-100);
  });
});

describe('Clean Pop: README contrast pairs (WCAG 2.2 AA)', () => {
  for (const pair of README_PAIRS) {
    it(`${pair.what} ≥ ${pair.min}:1 in every scheme and contrast`, () => {
      for (const appearance of APPEARANCES) {
        const values = resolveThemeValues(cleanPopTheme, appearance);
        const ratio = contrastRatio(valueOf(values, pair.fg) ?? '', valueOf(values, pair.bg) ?? '');
        expect(ratio.ok && ratio.value >= pair.min, `${appearance.scheme}/${appearance.contrast} ${pair.fg.name} on ${pair.bg.name}`).toBe(true);
      }
    });
  }

  it('the published ratios hold: primary 4.85:1, Claude 4.88:1', () => {
    const ratio = (fg: string, bg: string): number => {
      const r = contrastRatio(fg, bg);
      return r.ok ? Math.round(r.value * 100) / 100 : 0;
    };
    expect(ratio(p.white, p.primary)).toBeGreaterThanOrEqual(4.85);
    expect(ratio(p.white, p.agent)).toBeGreaterThanOrEqual(4.88);
    expect(ratio(p.controlEdge, p.page)).toBeGreaterThanOrEqual(3);
  });

  it('a regressed token fails the contract (control edge, agent ink)', async () => {
    const caseNamed = (fragment: string) => {
      const found = themeContractCases.find((x) => x.name.includes(fragment));
      if (found === undefined) throw new Error(`no case ${fragment}`);
      return found;
    };
    const faintEdge = extendTheme(cleanPopTheme, { id: 'test/faint-edge', values: { color: { controlEdge: p.hairline } } });
    await expect(caseNamed('3:1').run(faintEdge)).rejects.toThrow(/controlEdge/);
    const paleInk = extendTheme(cleanPopTheme, { id: 'test/pale-ink', values: { color: { agentInk: '#E0477A' } } });
    await expect(caseNamed('4.5:1').run(paleInk)).rejects.toThrow(/agentInk on color\.agentSoft/);
  });
});
