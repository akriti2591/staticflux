// @vitest-environment node
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeRustToolchain, REQUIRE_RUST_ENV, requireRustFrom } from './rust-toolchain.js';
import { fakeRunner } from './test-helpers.js';

describe('requireRustFrom', () => {
  it('is true only for 1/true', () => {
    expect(REQUIRE_RUST_ENV).toBe('SF_REQUIRE_RUST');
    expect(requireRustFrom({ SF_REQUIRE_RUST: '1' })).toBe(true);
    expect(requireRustFrom({ SF_REQUIRE_RUST: ' TRUE ' })).toBe(true);
    expect(requireRustFrom({ SF_REQUIRE_RUST: '0' })).toBe(false);
    expect(requireRustFrom({})).toBe(false);
  });
});

describe('probeRustToolchain', () => {
  const tools = (over: { cargo?: number; rustc?: number; sysroot?: string } = {}): ReturnType<typeof fakeRunner> =>
    fakeRunner((c) => {
      if (c.command === 'cargo') return { code: over.cargo ?? 0, stdout: 'cargo 1.97.0', stderr: over.cargo ? 'error: toolchain not installed' : '' };
      if (c.args[0] === '-V') return { code: over.rustc ?? 0, stdout: 'rustc 1.97.0 (2d8144b78 2026-07-07)\n' };
      if (c.args[0] === '--print') return { stdout: `${over.sysroot ?? '/sys'}\n` };
      return undefined;
    });

  it('returns versions when cargo, rustc and the wasm32 sysroot exist', async () => {
    const runner = tools();
    const probe = await probeRustToolchain(runner, '/engine', { exists: (p) => p === join('/sys', 'lib', 'rustlib', 'wasm32-unknown-unknown') });
    expect(probe).toEqual({ ok: true, toolchain: { rustc: 'rustc 1.97.0 (2d8144b78 2026-07-07)', cargo: 'cargo 1.97.0' } });
    expect(runner.calls.every((c) => c.cwd === '/engine')).toBe(true);
  });

  it('names what is missing', async () => {
    const noCargo = await probeRustToolchain(fakeRunner(() => undefined), '/e');
    expect(!noCargo.ok && noCargo.missing).toBe('cargo is not installed or not runnable (spawn cargo ENOENT)');
    const broken = await probeRustToolchain(tools({ cargo: 1 }), '/e');
    expect(!broken.ok && broken.missing).toContain('toolchain not installed');
    const noRustc = await probeRustToolchain(tools({ rustc: 2 }), '/e');
    expect(!noRustc.ok && noRustc.missing).toBe('rustc is not runnable (exit 2)');
    const noTarget = await probeRustToolchain(tools(), '/e', { exists: () => false });
    expect(!noTarget.ok && noTarget.missing).toContain('rustup target add wasm32-unknown-unknown');
  });

  it('can skip the Wasm target check (cargo metadata does not need it)', async () => {
    const runner = tools();
    expect((await probeRustToolchain(runner, '/e', { wasmTarget: false, exists: () => false })).ok).toBe(true);
    expect(runner.calls.some((c) => c.args[0] === '--print')).toBe(false);
  });
});
