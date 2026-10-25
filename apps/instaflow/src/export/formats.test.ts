// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_OPTIONS, EXPORT_FORMAT_IDS, EXPORT_FORMATS, exportFileName, validateExportOptions } from './formats.js';

describe('export formats and options', () => {
  it('describes every format as data', () => {
    expect(EXPORT_FORMAT_IDS).toEqual(['png', 'pdf', 'svg']);
    expect(EXPORT_FORMATS.png).toMatchObject({ kind: 'raster', scales: true, multiPage: false, mime: 'image/png' });
    expect(EXPORT_FORMATS.pdf).toMatchObject({ kind: 'vector', wire: 1, multiPage: true });
    expect(EXPORT_FORMATS.svg).toMatchObject({ kind: 'vector', wire: 0, mime: 'image/svg+xml' });
  });

  it('validates options with defaults and refuses anything else (IF-EXP-001)', () => {
    expect(validateExportOptions({})).toEqual({ ok: true, value: DEFAULT_EXPORT_OPTIONS });
    expect(validateExportOptions({ format: 'svg', scale: 3, transparent: true, scope: 'selection' })).toEqual({ ok: true, value: { format: 'svg', scale: 3, transparent: true, scope: 'selection' } });
    for (const bad of [null, 'png', { format: 'gif' }, { scale: 4 }, { scope: 'canvas' }, { transparent: 'yes' }]) {
      const r = validateExportOptions(bad);
      expect(!r.ok && r.error.code).toBe('IF-EXP-001');
    }
  });

  it('names files from the title, with a page suffix when there are several', () => {
    expect(exportFileName('Spring Flyer', 'png')).toBe('Spring Flyer.png');
    expect(exportFileName('A/B: "launch" ✦', 'pdf')).toBe('A B launch.pdf');
    expect(exportFileName('   ', 'svg')).toBe('Design.svg');
    expect(exportFileName('Deck', 'png', { index: 2, count: 12 })).toBe('Deck - 03.png');
    expect(exportFileName('One', 'png', { index: 0, count: 1 })).toBe('One.png');
  });
});
