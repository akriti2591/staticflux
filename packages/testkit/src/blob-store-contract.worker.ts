/** Worker half of `blob-store-contract.browser.ts`: the contract with sync access handles available. */
import { describe, it, runRegistered } from '@staticflux/browser-test';
import { runOpfsBlobStoreContract } from './blob-store-contract.opfs.js';

runOpfsBlobStoreContract('OPFS worker (auto)', 'auto', { describe, it });
void runRegistered().then((result) => self.postMessage(result));
