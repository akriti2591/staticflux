import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import {
  documentCrdtContractCases,
  documentRepoContractCases,
  documentStoreContractCases,
  runDocumentCrdtContract,
  runDocumentRepoContract,
  runDocumentStoreContract,
} from './index.js';

const runner = { describe, it, expect };
const engine = createLoroEngine();

runDocumentStoreContract('memory', () => createMemoryDocumentStore(), runner);

runDocumentRepoContract(
  'reference repo · Loro · memory store',
  {
    store: () => createMemoryDocumentStore(),
    repo: (store, options) => createDocumentRepo({ store, engine, ...options }),
    liveHandles: () => engine.liveHandles(),
  },
  runner,
);

runDocumentCrdtContract('Loro', engine, runner, { numRuns: 40, maxPeers: 5, maxSteps: 40 });

describe('document contract suites', () => {
  it('expose their cases and honour skip', () => {
    expect(documentStoreContractCases.length).toBeGreaterThan(3);
    expect(documentRepoContractCases.length).toBeGreaterThan(5);
    expect(documentCrdtContractCases.map((c) => c.name)).toContain('N-peer convergence: random move / reorder / text / set under partitions and heals (property)');
    const names: string[] = [];
    runDocumentStoreContract('skip', () => createMemoryDocumentStore(), { describe: (_n, fn) => fn(), it: (n) => names.push(n) }, { skip: [documentStoreContractCases[0]?.name ?? ''] });
    expect(names).toHaveLength(documentStoreContractCases.length - 1);
    const repoNames: string[] = [];
    runDocumentRepoContract('skip', { store: () => createMemoryDocumentStore(), repo: (store) => createDocumentRepo({ store, engine }) }, { describe: (_n, fn) => fn(), it: (n) => repoNames.push(n) }, { skip: [documentRepoContractCases[0]?.name ?? ''] });
    expect(repoNames).toHaveLength(documentRepoContractCases.length - 1);
    const crdtNames: string[] = [];
    runDocumentCrdtContract('skip', engine, { describe: (_n, fn) => fn(), it: (n) => crdtNames.push(n) }, { skip: [documentCrdtContractCases[0]?.name ?? ''] });
    expect(crdtNames).toHaveLength(documentCrdtContractCases.length - 1);
  });
});
