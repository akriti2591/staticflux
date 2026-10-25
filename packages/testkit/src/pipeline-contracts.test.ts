import { describe, it } from 'vitest';
import { runBlobSideChannelContract } from './blob-side-channel-contract.js';
import { runClockCellContract } from './clock-cell-contract.js';
import { runDeltaStreamContract } from './delta-stream-contract.js';
import { runHandleChannelContract } from './handle-channel-contract.js';
import { memoryWindowedDriver, runWindowedReplicaContract } from './windowed-replica-contract.js';
import { brokeredPeerSetup, colocatedPeerSetup, runPeerChannelContract } from './peer-channel-contract.js';
import { availableLinkTransports, availablePipeMedia } from './pipe-contract-support.js';
import { runRecordRingContract } from './record-ring-contract.js';
import { runSeqlockCellContract } from './seqlock-cell-contract.js';

const runner = { describe, it };

for (const medium of availablePipeMedia()) {
  runSeqlockCellContract(medium, runner);
  runClockCellContract(medium, runner);
  runRecordRingContract(medium, runner);
  runDeltaStreamContract(medium, runner);
}

for (const transport of availableLinkTransports()) {
  runBlobSideChannelContract(transport, runner);
  runHandleChannelContract(transport, runner); // fakes: by-reference transports only (see the suite header)
  runWindowedReplicaContract(transport, memoryWindowedDriver, runner);
}

runPeerChannelContract(colocatedPeerSetup, runner);
for (const transport of availableLinkTransports()) {
  runPeerChannelContract(brokeredPeerSetup(transport), runner);
}
