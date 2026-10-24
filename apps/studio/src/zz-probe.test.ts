import { appendFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { dependencyEdges } from '@staticflux/core';
import { studioUnits } from './app/compose.js';
import { createHeadlessEnvironment } from './app/headless.js';
import { createStudioTelemetry } from './app/telemetry.js';
const OUT = '/tmp/claude-0/-home-user-staticflux/7bbaee97-dc65-5323-8cb6-25a315c47a74/scratchpad/deps.txt';
it('probe', () => {
  writeFileSync(OUT, '');
  const regs = studioUnits(createHeadlessEnvironment({ url: '/' }), createStudioTelemetry({})).map((r: any) => ('unit' in r && r.kind === 'binding' ? r.unit : r));
  for (const u of regs) {
    const edges = dependencyEdges(u).map((e) => `${e.kind[0]}:${e.token.id}`);
    appendFileSync(OUT, `${u.id} -> ${u.provides.id}${u.critical ? ' CRIT' : ''} | ${edges.join(' ')}\n`);
  }
});
