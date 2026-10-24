import { describe, expect, it } from 'vitest';
import { createTelemetry } from '@staticflux/core';
import {
  createVerbosityControl,
  DEBUG_SESSION_KEY,
  effectiveLevel,
  formatDebugFlag,
  parseDebugFlag,
  readDebugFlag,
  readSessionFlag,
  type SessionStoragePort,
} from './levels.js';

function memorySession(): SessionStoragePort & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('sf-debug flag', () => {
  it('parses subsystem:level lists, prefixes and the default', () => {
    const parsed = parseDebugFlag('core/di:verbose, router/*:debug,*:critical');
    expect(parsed.ok && parsed.value).toEqual([
      { subsystem: 'core/di', level: 'verbose' },
      { subsystem: 'router/*', level: 'debug' },
      { subsystem: '*', level: 'critical' },
    ]);
  });

  it('treats a bare level as the default, and empty/1/true as *:debug', () => {
    expect(parseDebugFlag('verbose')).toEqual({ ok: true, value: [{ subsystem: '*', level: 'verbose' }] });
    for (const v of ['', '1', 'true']) expect(parseDebugFlag(v)).toEqual({ ok: true, value: [{ subsystem: '*', level: 'debug' }] });
  });

  it('rejects the whole flag when any entry is invalid (SF-DEV-001)', () => {
    const parsed = parseDebugFlag('core/di:loud,nope,Router/x:debug,core/di:verbose');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('SF-DEV-001');
    expect(parsed.error.details).toEqual({ invalid: ['core/di:loud', 'nope', 'Router/x:debug'] });
    expect(parsed.error.fix).toContain('sf-debug=');
  });

  it('formats entries in stable order', () => {
    expect(formatDebugFlag([{ subsystem: 'router/pipeline', level: 'debug' }, { subsystem: '*', level: 'verbose' }, { subsystem: 'core/di', level: 'off' }])).toBe(
      '*:verbose,core/di:off,router/pipeline:debug',
    );
  });

  it('reads the param from full URLs, search strings, URL and URLSearchParams', () => {
    expect(readDebugFlag('https://app.test/studio?x=1&sf-debug=core/di:verbose')).toBe('core/di:verbose');
    expect(readDebugFlag('?sf-debug=verbose')).toBe('verbose');
    expect(readDebugFlag('/studio?sf-debug=')).toBe('');
    expect(readDebugFlag(new URL('https://a.test/?sf-debug=debug'))).toBe('debug');
    expect(readDebugFlag(new URLSearchParams('a=1'))).toBeUndefined();
  });
});

describe('verbosity control', () => {
  it('switches levels at runtime and probes the effective level', () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard', levels: { 'core/di': 'critical' } });
    const control = createVerbosityControl({ telemetry });
    expect(control.levelOf('core/di')).toBe('critical');
    expect(effectiveLevel(telemetry, 'router/pipeline')).toBe('standard');
    control.setLevel('core/di', 'debug');
    expect(telemetry.enabled('core/di', 'debug')).toBe(true);
    control.setLevel('router/*', 'verbose');
    expect(control.levelOf('router/pipeline')).toBe('verbose');
    control.setLevel('*', 'off');
    expect(control.levelOf('data/request')).toBe('off');
    expect(control.overrides()).toEqual([
      { subsystem: 'core/di', level: 'debug' },
      { subsystem: 'router/*', level: 'verbose' },
      { subsystem: '*', level: 'off' },
    ]);
  });

  it('reset restores the level that was effective before the first override', () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard', levels: { 'core/di': 'critical' } });
    const control = createVerbosityControl({ telemetry });
    control.setLevel('core/di', 'verbose');
    control.setLevel('core/di', 'debug');
    control.setLevel('*', 'verbose');
    control.reset('core/di');
    expect(control.levelOf('core/di')).toBe('critical');
    expect(control.overrides()).toEqual([{ subsystem: '*', level: 'verbose' }]);
    control.reset();
    expect(control.levelOf('data/x')).toBe('standard');
    expect(control.overrides()).toEqual([]);
  });

  it('applyFlag applies valid flags and leaves levels untouched for invalid ones', () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard' });
    const control = createVerbosityControl({ telemetry });
    expect(control.applyFlag('core/di:bogus').ok).toBe(false);
    expect(control.overrides()).toEqual([]);
    expect(control.applyFlag('core/di:debug').ok).toBe(true);
    expect(control.levelOf('core/di')).toBe('debug');
  });

  it('persists overrides for the tab session and notifies listeners', () => {
    const telemetry = createTelemetry();
    const session = memorySession();
    const control = createVerbosityControl({ telemetry, session });
    let changes = 0;
    control.onChange(() => (changes += 1));
    control.setLevel('core/di', 'verbose');
    expect(session.data.size).toBe(0); // not persisted until enabled
    control.persistSession(true);
    expect(readSessionFlag(session)).toBe('core/di:verbose');
    control.setLevel('router/*', 'debug');
    expect(session.data.get(DEBUG_SESSION_KEY)).toBe('core/di:verbose,router/*:debug');
    control.reset();
    expect(session.data.has(DEBUG_SESSION_KEY)).toBe(false);
    control.setLevel('core/di', 'debug');
    control.persistSession(false);
    expect(session.data.has(DEBUG_SESSION_KEY)).toBe(false);
    expect(changes).toBe(4);
  });

  it('survives throwing storage', () => {
    const telemetry = createTelemetry();
    const throwing: SessionStoragePort = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const control = createVerbosityControl({ telemetry, session: throwing });
    control.persistSession(true);
    expect(() => control.setLevel('core/di', 'debug')).not.toThrow();
    expect(() => control.persistSession(false)).not.toThrow();
    expect(readSessionFlag(throwing)).toBeUndefined();
  });
});
