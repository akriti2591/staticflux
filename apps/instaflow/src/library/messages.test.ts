import { describe, expect, it } from 'vitest';
import { libraryMessages, libraryText } from './messages.js';

describe('libraryText', () => {
  it('formats the source text with params until I18n arrives, and uses I18n when it has', () => {
    expect(libraryText(undefined, libraryMessages.importing, { name: 'hero.png', percent: 40 })).toBe('Importing hero.png · 40%');
    expect(libraryText(undefined, libraryMessages.import)).toBe('Import');
    const i18n = { value: { t: () => 'Importer' } } as unknown as Parameters<typeof libraryText>[0];
    expect(libraryText(i18n, libraryMessages.import)).toBe('Importer');
  });
});
