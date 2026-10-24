import { it } from 'vitest';
import { WorkspaceManagerToken } from '@staticflux/shell';
import { bootHeadless, settle, waitFor } from './test/harness.js';
import { signedInServer } from './test/fixtures.js';

it('debug', async () => {
  const h = await bootHeadless({ url: '/', server: signedInServer('grace'), render: true });
  await waitFor(() => h.session.isAuthenticated);
  await settle(20);
  const shell = h.root!.querySelector('sf-shell')!;
  console.log('before', shell.shadowRoot!.innerHTML.includes('studio-inspector'), shell.shadowRoot!.innerHTML.includes('ai-suggestions'));
  const ws = await h.get(WorkspaceManagerToken);
  console.log(await ws.switchTo('studio/expert'));
  await settle(20);
  console.log('after', ws.current.id, shell.shadowRoot!.innerHTML.includes('studio-inspector'));
  await h.dispose();
});
