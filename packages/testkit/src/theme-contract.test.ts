import { defaultTheme } from '@staticflux/ui/default-theme';
import { extendTheme } from '@staticflux/ui/theme';
import { describe, expect, it } from 'vitest';
import { runThemeContract, themeContractCases } from './theme-contract.js';

runThemeContract('default theme', () => defaultTheme, { describe, it });

const caseNamed = (fragment: string) => {
  const found = themeContractCases.find((c) => c.name.includes(fragment));
  if (found === undefined) throw new Error(`no case ${fragment}`);
  return found;
};

describe('theme contract catches regressions', () => {
  it('fails low text contrast with the failing pair and appearance', async () => {
    const low = extendTheme(defaultTheme, { id: 'test/low', dark: { color: { textMuted: '#4a4f57' } } });
    await expect(caseNamed('4.5:1').run(low)).rejects.toThrow(/dark\/normal\/standard\/full color\.textMuted on color\.canvas/);
  });

  it('fails a weak focus ring', async () => {
    const weak = extendTheme(defaultTheme, { id: 'test/weak', values: { color: { focusRing: '#c7d2fe' } } });
    await expect(caseNamed('3:1').run(weak)).rejects.toThrow(/focusRing/);
  });

  it('fails off-grid spacing, inverted density and tiny targets', async () => {
    const off = extendTheme(defaultTheme, { id: 'test/off', density: { pro: { space: { md: '6px' }, size: { controlSm: '20px', control: '30px' } } } });
    await expect(caseNamed('4 px grid').run(off)).rejects.toThrow(/pro space\.md = 6px/);
    await expect(caseNamed('control heights').run(off)).rejects.toThrow(/size\.controlSm: 20px < 24px in pro/);
    await expect(caseNamed('control heights').run(off)).rejects.toThrow(/size\.control: focus 32 \/ standard 28 \/ pro 30/);
  });

  it('fails slow or unreduced motion', async () => {
    const slow = extendTheme(defaultTheme, { id: 'test/slow', values: { motion: { durationSlow: '400ms' } }, reducedMotion: { motion: { durationFast: '120ms' } } });
    await expect(caseNamed('motion').run(slow)).rejects.toThrow(/durationFast = 120ms \(reduced motion\)[\s\S]*durationSlow = 400ms \(full motion\)/);
  });

  it('fails an invalid theme', async () => {
    const invalid = extendTheme(defaultTheme, { id: 'test/invalid', values: { color: { text: '' } } });
    await expect(caseNamed('complete').run(invalid)).rejects.toThrow(/SF-UI-008|missing/);
  });
});
