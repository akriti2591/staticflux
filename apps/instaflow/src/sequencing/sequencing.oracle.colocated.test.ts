// @vitest-environment node
/**
 * IF-7.3 / D15 — the S2 oracle on the default topology: both modules in one worker (`local` pipes),
 * with the input ring on each cross-thread medium, rAF-only drawing as the control, and lost deltas.
 */
import { runSequencingOracleContract } from '@staticflux/testkit';
import { describe, it } from 'vitest';
import { RAF_ONLY_PACING } from './pacing.js';
import { createOracleSubject, ORACLE_CASE_TIMEOUT_MS, ORACLE_GESTURES } from './testing/oracle-setup.js';

runSequencingOracleContract('one worker (colocated)', createOracleSubject() as never, { describe, it: (name, fn) => it(name, fn, ORACLE_CASE_TIMEOUT_MS) }, {
  gestures: ORACLE_GESTURES,
  configs: [
    { name: 'one worker (default), local pipes, shared input ring', topology: 'colocated', medium: 'local', inputMedium: 'shared' },
    { name: 'one worker, local pipes, message input ring', topology: 'colocated', medium: 'local', inputMedium: 'message' },
    { name: 'one worker, rAF-only drawing', topology: 'colocated', medium: 'local', inputMedium: 'shared', options: { pacing: RAF_ONLY_PACING } },
  ],
  faultConfigs: [{ name: 'one worker, every 25th delta lost', topology: 'colocated', medium: 'local', inputMedium: 'shared', dropDeltaEvery: 25 }],
});
