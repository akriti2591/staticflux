// @vitest-environment node
/** IF-7.3 / D15 — the S2 oracle on the split topology (two workers) over shared and message pipes, and lost deltas. */
import { runSequencingOracleContract } from '@staticflux/testkit';
import { describe, it } from 'vitest';
import { createOracleSubject, ORACLE_CASE_TIMEOUT_MS, ORACLE_GESTURES } from './testing/oracle-setup.js';

runSequencingOracleContract('two workers (split)', createOracleSubject() as never, { describe, it: (name, fn) => it(name, fn, ORACLE_CASE_TIMEOUT_MS) }, {
  gestures: ORACLE_GESTURES,
  configs: [
    { name: 'two workers, shared pipes', topology: 'split', medium: 'shared', inputMedium: 'shared' },
    { name: 'two workers, message pipes', topology: 'split', medium: 'message', inputMedium: 'message' },
  ],
  faultConfigs: [{ name: 'two workers (message), every 25th delta lost', topology: 'split', medium: 'message', inputMedium: 'message', dropDeltaEvery: 25 }],
});
