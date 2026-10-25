/**
 * Home's dev entry (C0): `pnpm --filter @instaflow/app dev`, then open http://localhost:5174/ (Home). The light boot:
 * no document engine, no GPU, no worker (D17; held by `src/home/home-imports.test.ts`). It reads the Home index of the
 * local workspace (IndexedDB) and links into Studio (`/s/:asset`, `/new`). `window.__home` exposes the model and its
 * capabilities for the smoke check, devtools and agents.
 */
import { createScope } from '@staticflux/core';
import { type BootedHome, bootHome } from '../../src/home/boot.js';

const status = document.getElementById('boot') as HTMLElement;
const scope = createScope('instaflow/home-dev');

void bootHome({ container: document.getElementById('home') as HTMLElement, scope }).then((booted) => {
  if (!booted.ok) {
    status.textContent = `Home could not start: ${booted.error.code} ${booted.error.message}`;
    status.setAttribute('role', 'alert');
    return;
  }
  status.remove();
  (window as unknown as { __home: BootedHome }).__home = booted.value;
});
