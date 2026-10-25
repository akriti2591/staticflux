// @vitest-environment node
/** The main-rAF tick experiment on the split topology (and on the default one): the switch must not change correctness. */
import { runSequencingOracleContract } from '@staticflux/testkit';
import { describe, it } from 'vitest';
import { MAIN_TICK_PACING } from './pacing.js';
import { createOracleSubject, ORACLE_CASE_TIMEOUT_MS, ORACLE_GESTURES } from './testing/oracle-setup.js';

runSequencingOracleContract('main-rAF tick', createOracleSubject() as never, { describe, it: (name, fn) => it(name, fn, ORACLE_CASE_TIMEOUT_MS) }, {
  gestures: ORACLE_GESTURES,
  configs: [
    { name: 'two workers, shared pipes, main-rAF tick', topology: 'split', medium: 'shared', inputMedium: 'shared', options: { pacing: MAIN_TICK_PACING } },
    { name: 'one worker, main-rAF tick', topology: 'colocated', medium: 'local', inputMedium: 'shared', options: { pacing: MAIN_TICK_PACING } },
  ],
  faultConfigs: [],
});
