// @vitest-environment node
import { alwaysActivePort, allowAllDecidePort, createCapabilityRegistry, failClosedConfirmPort, unmeteredPort } from '@staticflux/capabilities';
import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { ExportCapability, ExportShortcut, implementExport } from './capability.js';
import { ExportRenderError } from './errors.js';
import type { ExportOptions } from './formats.js';
import type { ExportOutcome } from './service.js';

function registry(run: (o: ExportOptions) => Promise<ReturnType<typeof ok<ExportOutcome>> | ReturnType<typeof err>>) {
  return createCapabilityRegistry({
    decide: allowAllDecidePort,
    confirm: failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    declarations: [ExportCapability],
    implementations: [implementExport({ run: (o) => run(o) as never })],
  });
}

describe('instaflow/export (capability)', () => {
  it('fills the defaults, runs the service and reports the files without their bytes', async () => {
    const seen: ExportOptions[] = [];
    const caps = registry(async (o) => {
      seen.push(o);
      return ok({ options: o, files: [{ name: 'Flyer.svg', mime: 'image/svg+xml', bytes: new Uint8Array(42) }], patches: 0, missingImages: ['as_x'] });
    });
    const out = await caps.invoke(ExportCapability, { format: 'svg' }, { subject: 'agent', signal: new AbortController().signal });
    expect(out).toEqual({ ok: true, value: { files: [{ name: 'Flyer.svg', mime: 'image/svg+xml', size: 42 }], missingImages: ['as_x'] } });
    expect(seen).toEqual([{ format: 'svg', scale: 2, transparent: false, scope: 'page' }]);
    const bad = await caps.invoke(ExportCapability, { format: 'gif' } as never, { subject: 'agent', signal: new AbortController().signal });
    expect(bad.ok).toBe(false);
  });

  it('passes failures through, and has a shortcut', async () => {
    const caps = registry(async () => err(ExportRenderError()));
    const out = await caps.invoke(ExportCapability, { format: 'png', scale: 3, transparent: true, scope: 'pages' }, { subject: 'user', signal: new AbortController().signal });
    expect(!out.ok && out.error.code).toBe('IF-EXP-005');
    expect(ExportShortcut.keys).toEqual(['Mod+Shift+E']);
  });
});
