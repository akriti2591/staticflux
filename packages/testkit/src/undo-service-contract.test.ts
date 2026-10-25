import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore } from '@staticflux/document/v2';
import { createUndoService } from '@staticflux/stage';
import { describe, expect, it } from 'vitest';
import { runUndoServiceContract, undoServiceContractCases } from './index.js';

const engine = createLoroEngine();
const subject = {
  store: () => createMemoryDocumentStore(),
  repo: (store: Parameters<typeof createDocumentRepo>[0]['store']) => createDocumentRepo({ store, engine }),
  service: (doc: Parameters<typeof createUndoService>[0]['doc']) => createUndoService({ doc }),
};

runUndoServiceContract('reference undo service · Loro · memory store', subject, { describe, it }, { numRuns: 25, maxSteps: 30 });

describe('undo service contract suite', () => {
  it('exposes its cases and honours skip', () => {
    expect(undoServiceContractCases.length).toBeGreaterThan(6);
    expect(undoServiceContractCases.filter((c) => c.name.startsWith('property:'))).toHaveLength(2);
    const names: string[] = [];
    runUndoServiceContract('skip', subject, { describe: (_n, fn) => fn(), it: (n) => names.push(n) }, { skip: [undoServiceContractCases[0]?.name ?? ''] });
    expect(names).toHaveLength(undoServiceContractCases.length - 1);
  });
});
