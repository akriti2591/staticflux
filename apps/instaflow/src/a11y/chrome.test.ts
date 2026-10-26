// @vitest-environment node
/**
 * Chrome to WCAG 2.2 AA (IF-25.19–25.23), the parts that need no DOM: every Instaflow panel and the Studio frame run
 * the full audit under Clean Pop in their own suites (this file guards that none is left out), target sizes, the focus
 * ring and reduced motion come from the theme, and the canvas focus ring has contrast on the canvas well.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, DENSITIES, type ResolvedAppearance, themeTokens as t, themeValue } from '@staticflux/ui/theme';
import { describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { CANVAS_FOCUS_RING } from './dom.js';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const LIGHT: ResolvedAppearance = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' };
const APPEARANCES: readonly ResolvedAppearance[] = [LIGHT, { ...LIGHT, contrast: 'more' }, { ...LIGHT, scheme: 'dark' }, { ...LIGHT, scheme: 'dark', contrast: 'more' }];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'testing' || name === 'ime-check' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Instaflow custom elements (panels and the Studio frame): a `tag: 'if-…'` spec or an `…_TAG = 'if-…'` constant. */
const ELEMENT_MODULES = sources(SRC).filter((path) => /tag: 'if-|_TAG = 'if-/.test(readFileSync(path, 'utf8')));

describe('chrome audit coverage', () => {
  it('finds every Instaflow panel and the Studio frame', () => {
    expect(ELEMENT_MODULES.map((p) => relative(SRC, p)).sort()).toEqual(
      ['elements/panel.ts', 'export/panel.ts', 'home/home-element.ts', 'lenses/pages-panel.ts', 'library/library-panel.ts', 'repeat/panel.ts', 'studio/command-bar.ts', 'studio/hud.ts', 'studio/inspector.ts', 'studio/layers-panel.ts', 'studio/studio-element.ts', 'text/typography-panel.ts', 'tools/transform-bar.ts', 'versioning/milestones-panel.ts', 'versioning/save-status.ts'].sort(),
    );
  });

  it.each(ELEMENT_MODULES.map((p) => [relative(SRC, p), p]))('%s is audited under Clean Pop in its test', (_, path) => {
    const test = readFileSync(path.replace(/\.ts$/, '.test.ts'), 'utf8');
    expect(test).toMatch(/expectNoA11yIssues\(|auditA11y\(/);
    expect(test).toContain('compileTheme(cleanPopTheme)');
    // The full rule set: no audit narrows `rules`.
    expect(test).not.toMatch(/(expectNoA11yIssues|auditA11y)\([^)]*rules:/);
  });
});

/** Kit building blocks B11a and B11a2 added for Studio and Home (FOUNDATIONS §6): each runs the full audit under Clean Pop. */
const FOUNDATION_BLOCKS = [
  'sf-icon',
  'sf-number-field',
  'sf-inline-edit',
  'sf-swatch',
  // B11a2: overlays, feedback, hints and the shared HUD / inspector popovers.
  'sf-menu',
  'sf-menu-item',
  'sf-menu-group',
  'sf-popover',
  'sf-tooltip',
  'sf-color-popover',
  'sf-font-picker',
  'sf-align-popover',
  'sf-banner',
  'sf-progress-row',
  'sf-confirm-row',
  'sf-copy-field',
  'sf-disclosure',
  'sf-hint',
  'sf-toast',
  'sf-dialog',
  'sf-takeover',
  'sf-blocking-error',
] as const;

describe('foundation blocks audit coverage', () => {
  it.each(FOUNDATION_BLOCKS)('%s is mounted and audited under Clean Pop in a11y/foundations.test.ts', (tag) => {
    const test = readFileSync(join(SRC, 'a11y', 'foundations.test.ts'), 'utf8');
    expect(test).toContain(`<${tag}`);
    expect(test).toContain('compileTheme(cleanPopTheme)');
    expect(test).toMatch(/expectNoA11yIssues\(/);
    expect(test).not.toMatch(/(expectNoA11yIssues|auditA11y)\([^)]*rules:/);
  });
});

describe('theme facts (Clean Pop)', () => {
  it('keeps every control and row at least 24 × 24 px in every density (SC 2.5.8)', () => {
    for (const density of DENSITIES) {
      for (const token of [t.size.controlSm, t.size.control, t.size.controlLg, t.size.row]) {
        const value = themeValue(cleanPopTheme, token, { ...LIGHT, density });
        expect(Number.parseFloat(value), `${token.name} @ ${density} = ${value}`).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it('draws the canvas focus ring 2 px deep tangerine, 2 px offset, with 3:1 on the canvas well and the chrome (SC 2.4.7, 1.4.11)', () => {
    expect(CANVAS_FOCUS_RING).toEqual({ outline: `2px solid ${t.color.focusRing.ref}`, offset: '2px' });
    expect(themeValue(cleanPopTheme, t.color.focusRing, LIGHT)).toBe('#CF3D17');
    for (const appearance of APPEARANCES) {
      const ring = themeValue(cleanPopTheme, t.color.focusRing, appearance);
      for (const bg of [t.color.neutral4, t.color.canvas, t.color.surface1]) {
        const ratio = contrastRatio(ring, themeValue(cleanPopTheme, bg, appearance));
        expect(ratio.ok ? ratio.value : 0, `${bg.name} (${appearance.scheme}/${appearance.contrast})`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('turns every motion duration off under reduced motion (SC 2.3.3)', () => {
    for (const token of [t.motion.durationFast, t.motion.durationNormal, t.motion.durationSlow]) {
      expect(themeValue(cleanPopTheme, token, { ...LIGHT, motion: 'reduce' })).toBe('0ms');
      expect(Number.parseFloat(themeValue(cleanPopTheme, token, LIGHT))).toBeGreaterThan(0);
    }
  });
});
