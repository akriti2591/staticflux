import { listErrorDefinitions } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { abortedError, BlobIoError, isQuotaExceeded, toBlobError } from './errors.js';

describe('blob errors', () => {
  it('declares SF-BLOB-001…014, each with a fix', () => {
    const codes = listErrorDefinitions().filter((d) => d.code.startsWith('SF-BLOB-'));
    expect(codes.map((d) => d.code)).toEqual(Array.from({ length: 14 }, (_, i) => `SF-BLOB-${String(i + 1).padStart(3, '0')}`));
    for (const definition of codes) expect(definition.fix.length).toBeGreaterThan(20);
  });

  it('isQuotaExceeded recognizes QuotaExceededError and legacy code 22', () => {
    expect(isQuotaExceeded(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaExceeded({ code: 22 })).toBe(true);
    expect(isQuotaExceeded(new Error('x'))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
  });

  it('toBlobError maps DOMExceptions to stable codes', () => {
    const map = (name: string): string => toBlobError(new DOMException('m', name), 'write', 'a/b').code;
    expect(map('AbortError')).toBe('SF-BLOB-006');
    expect(map('QuotaExceededError')).toBe('SF-BLOB-001');
    expect(map('NotAllowedError')).toBe('SF-BLOB-004');
    expect(map('SecurityError')).toBe('SF-BLOB-004');
    expect(map('NotFoundError')).toBe('SF-BLOB-005');
    const io = toBlobError(new Error('disk on fire'), 'move');
    expect(io.code).toBe('SF-BLOB-007');
    expect(io.message).toContain('disk on fire');
    expect(io.details).toEqual({ op: 'move' });
    const existing = BlobIoError();
    expect(toBlobError(existing, 'x')).toBe(existing);
  });

  it('abortedError reports an aborted signal only', () => {
    const controller = new AbortController();
    expect(abortedError(undefined)).toBeUndefined();
    expect(abortedError(controller.signal)).toBeUndefined();
    controller.abort('stop');
    expect(abortedError(controller.signal)?.code).toBe('SF-BLOB-006');
  });
});
