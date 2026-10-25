// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENSES, classifyLicense, classifyLicenseId } from './license-classify.js';

const verdict = (license: string | undefined | null): string => classifyLicense(license).verdict;

describe('classifyLicenseId', () => {
  it('allows permissive ids case-insensitively and reports the canonical id', () => {
    expect(classifyLicenseId('mit')).toEqual({ verdict: 'allowed', reason: 'MIT' });
    for (const id of ALLOWED_LICENSES) expect(classifyLicenseId(id).verdict).toBe('allowed');
  });

  it('denies the GPL family, SSPL, NC, source-available and UNLICENSED ids', () => {
    for (const id of ['GPL-2.0-only', 'GPL-3.0-or-later', 'GPL-2.0+', 'LGPL-2.1-only', 'AGPL-3.0', 'SSPL-1.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-SA-NC-1.0', 'PolyForm-Noncommercial-1.0.0', 'BUSL-1.1', 'Elastic-2.0', 'Commons-Clause', 'UNLICENSED', 'bria-rmbg-1.4']) {
      expect(classifyLicenseId(id).verdict, id).toBe('denied');
    }
    expect(classifyLicenseId('AGPL-3.0-only').reason).toContain('GPL family');
  });

  it('keeps Boost (BSL-1.0) allowed while the Business Source License is denied', () => {
    expect(classifyLicenseId('BSL-1.0').verdict).toBe('allowed');
    expect(classifyLicenseId('BSL-1.1').verdict).toBe('denied');
  });

  it('reports anything else as unknown', () => {
    expect(classifyLicenseId('LicenseRef-Acme')).toEqual({ verdict: 'unknown', reason: 'LicenseRef-Acme: not on the allowlist' });
  });
});

describe('classifyLicense (expressions)', () => {
  it('treats missing or placeholder licenses as unknown', () => {
    expect(verdict(undefined)).toBe('unknown');
    expect(verdict(null)).toBe('unknown');
    expect(verdict('  ')).toBe('unknown');
    expect(verdict('UNKNOWN')).toBe('unknown');
    expect(verdict('NOASSERTION')).toBe('unknown');
    expect(classifyLicense('SEE LICENSE IN LICENSE.md').reason).toContain('custom license file');
  });

  it('OR is allowed when any branch is allowed', () => {
    expect(verdict('MIT OR Apache-2.0')).toBe('allowed');
    expect(verdict('(MIT OR GPL-3.0-only)')).toBe('allowed');
    expect(verdict('GPL-3.0-only OR LicenseRef-Acme')).toBe('unknown');
    expect(verdict('GPL-3.0-only OR AGPL-3.0-only')).toBe('denied');
  });

  it('AND is denied when any part is denied, unknown when any is unknown', () => {
    expect(verdict('(MIT OR Apache-2.0) AND Unicode-3.0')).toBe('allowed');
    expect(classifyLicense('MIT AND Zlib').reason).toBe('MIT AND Zlib');
    expect(verdict('MIT AND GPL-2.0-only')).toBe('denied');
    expect(verdict('MIT AND LicenseRef-Acme')).toBe('unknown');
    expect(verdict('LicenseRef-Acme AND GPL-2.0-only')).toBe('denied');
  });

  it('binds AND tighter than OR', () => {
    // MIT OR (GPL AND Apache) → allowed via MIT.
    expect(verdict('MIT OR GPL-2.0-only AND Apache-2.0')).toBe('allowed');
    // (MIT OR GPL) AND GPL → denied.
    expect(verdict('(MIT OR GPL-2.0-only) AND GPL-3.0-only')).toBe('denied');
  });

  it('keeps the base verdict under WITH exceptions', () => {
    expect(verdict('Apache-2.0 WITH LLVM-exception')).toBe('allowed');
    expect(verdict('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('denied');
    expect(verdict('Apache-2.0 WITH LLVM-exception OR MIT')).toBe('allowed');
  });

  it("reads cargo's legacy slash as OR and lowercase operators", () => {
    expect(verdict('MIT/Apache-2.0')).toBe('allowed');
    expect(verdict('Apache-2.0 / GPL-3.0')).toBe('allowed');
    expect(verdict('mit or apache-2.0')).toBe('allowed');
  });

  it('denies non-commercial and watermark free text even when it is not SPDX', () => {
    expect(verdict('Free for non-commercial use')).toBe('denied');
    expect(verdict('Noncommercial research license')).toBe('denied');
    expect(classifyLicense('Free, output carries a watermark').reason).toContain('watermark');
  });

  it('reports malformed expressions as unknown', () => {
    for (const bad of ['MIT OR', '(MIT', 'MIT)', 'MIT WITH', 'MIT AND OR Apache-2.0', 'MIT, Apache-2.0']) {
      expect(classifyLicense(bad).reason, bad).toContain('not a valid SPDX expression');
    }
  });
});
