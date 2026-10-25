import type { DepHandle } from '@staticflux/core';
import type { I18n } from '@staticflux/i18n';
import { describe, expect, it } from 'vitest';
import { versioningMessages, versioningText } from './messages.js';

describe('versioningText', () => {
  it('falls back to the source text with parameters until i18n arrives', () => {
    expect(versioningText(undefined, versioningMessages.saved)).toBe('Saved');
    expect(versioningText(undefined, versioningMessages.notSaved, { cause: 'disk full' })).toBe('Not saved yet: disk full');
  });

  it('uses the I18n service when it is there', () => {
    const i18n = { value: { t: () => 'Enregistré' } } as unknown as DepHandle<I18n>;
    expect(versioningText(i18n, versioningMessages.saved)).toBe('Enregistré');
  });

  it('has no save-button wording (D2)', () => {
    const sources = (Object.values(versioningMessages) as unknown[]).filter((v): v is { source: string } => typeof v === 'object' && v !== null && 'source' in v).map((v) => v.source);
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => /^save$|restore/i.test(s))).toBe(false);
  });
});
