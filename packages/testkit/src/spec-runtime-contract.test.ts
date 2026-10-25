import { createSpecLayoutPort, createSpecRuntime } from '@staticflux/shell/spec';
import { describe, expect, it } from 'vitest';
import {
  recordingSpecPort,
  runSpecMountPortContract,
  runSpecRuntimeContract,
  specContractVocabulary,
  specMountPortContractCases,
  specRuntimeContractCases,
} from './index.js';

runSpecRuntimeContract('reference createSpecRuntime', { runtime: (options) => createSpecRuntime(options) }, { describe, it }, { numRuns: 30 });

runSpecMountPortContract(
  'createSpecLayoutPort',
  {
    create: async () => {
      const port = createSpecLayoutPort();
      return { port, groups: () => port.groups(), dispose: async () => undefined };
    },
  },
  { describe, it },
);

describe('spec contract suites', () => {
  it('expose their cases and honour skip', () => {
    expect(specRuntimeContractCases.filter((c) => c.name.startsWith('property:'))).toHaveLength(2);
    expect(specMountPortContractCases.length).toBeGreaterThan(3);
    const names: string[] = [];
    const subject = { runtime: (options: Parameters<typeof createSpecRuntime>[0]) => createSpecRuntime(options) };
    runSpecRuntimeContract('skip', subject, { describe: (_n, fn) => fn(), it: (n) => names.push(n) }, { skip: [specRuntimeContractCases[0]?.name ?? ''] });
    expect(names).toHaveLength(specRuntimeContractCases.length - 1);
    const portNames: string[] = [];
    runSpecMountPortContract('skip', { create: async () => ({ port: recordingSpecPort(), groups: () => ({}), dispose: async () => undefined }) }, { describe: (_n, fn) => fn(), it: (n) => portNames.push(n) }, { skip: [specMountPortContractCases[0]?.name ?? ''] });
    expect(portNames).toHaveLength(specMountPortContractCases.length - 1);
  });

  it('specContractVocabulary and recordingSpecPort', async () => {
    const vocabulary = specContractVocabulary();
    expect(vocabulary.sections.map((s) => s.id)).toEqual(['lens', 'tool', 'panel']);
    const port = recordingSpecPort();
    const runtime = createSpecRuntime({ vocabulary, port });
    await runtime.apply({ id: 'r', context: { lens: 'contract/lens-a' }, slots: [{ section: 'lens', id: 'contract/lens-a' }, { section: 'tool', id: 'contract/t0' }] });
    expect(port.groups()).toEqual({ 'lens@default': ['lens:contract/lens-a'], 'tool@default': ['tool:contract/t0'] });
    expect(port.calls.map((c) => c.op)).toEqual(['context', 'mount', 'mount']);
  });
});
