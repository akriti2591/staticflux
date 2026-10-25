/**
 * Leader-failover torture (S6, scaled down for CI): 4 tabs in one browser
 * context share one OPFS workspace and commit continuously; the leader tab is
 * killed `SF_KILLS` times (default 10), alternating `page.close()` and a
 * renderer crash (CDP `Page.crash`), each at a random point 100–600 ms into its
 * leadership. A fresh verifier tab then recovers the store.
 *
 * Pass: every commit any tab saw acknowledged is recovered, no unlocked head
 * read ever saw a torn or regressed head, and every recovery read a whole head.
 *
 *   SF_KILLS=100 node tooling/browser-test/src/run.ts --only=leader-kill   # the full S6 run
 */
import type { Page, ScenarioContext } from '@staticflux/browser-test';

const ENTRY = '/packages/blob/src/browser-tests/leader-tab.page.ts';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Message {
  readonly type: string;
  readonly peer: string;
  readonly [key: string]: unknown;
}

export async function scenario(ctx: ScenarioContext): Promise<void> {
  const kills = Number(ctx.env['SF_KILLS'] ?? 10);
  const tabs = 4;
  const ws = `kill-${Date.now()}`;
  const context = await ctx.newContext();
  const acked = new Set<string>();
  const leaders: { peer: string; at: number; message: Message }[] = [];
  const pageOf = new Map<string, Page>();
  const probes = new Map<string, { reads: number; torn: number; regress: number }>();
  const errors: Message[] = [];
  let verify: Message | undefined;

  const debug = ctx.env['SF_DEBUG'] !== undefined;
  await context.exposeBinding('__report', ({ page }, message: Message) => {
    if (debug && message.type !== 'ack') ctx.log(JSON.stringify(message));
    if (message.type === 'hello') pageOf.set(message.peer, page);
    else if (message.type === 'ack') acked.add(String(message['id']));
    else if (message.type === 'leader') leaders.push({ peer: message.peer, at: Date.now(), message });
    else if (message.type === 'probe') probes.set(message.peer, { reads: Number(message['reads']), torn: Number(message['torn']), regress: Number(message['regress']) });
    else if (message.type === 'error') errors.push(message);
    else if (message.type === 'verify') verify = message;
  });

  const live = new Set<Page>();
  const open = async (query: Record<string, string> = {}): Promise<Page> => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push({ type: 'pageerror', peer: '?', message: e.message }));
    if (debug) page.on('console', (m) => ctx.log(`[console ${m.type()}] ${m.text()}`));
    await page.goto(ctx.pageUrl(ENTRY, { ws, rate: '10', compact: '50', ...query }));
    live.add(page);
    return page;
  };
  const waitLeader = async (after: number): Promise<{ peer: string; page: Page }> => {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      for (const entry of leaders.slice(after)) {
        const page = pageOf.get(entry.peer);
        if (page !== undefined && live.has(page)) return { peer: entry.peer, page };
      }
      await sleep(5);
    }
    throw new Error('no leader elected within 20 s');
  };

  for (let i = 0; i < tabs; i++) await open();
  let current = await waitLeader(0);
  const failover: number[] = [];
  for (let kill = 0; kill < kills; kill++) {
    await sleep(100 + Math.random() * 500);
    const before = leaders.length;
    const victim = current.page;
    live.delete(victim);
    const killedAt = Date.now();
    if (kill % 2 === 1) {
      // A renderer crash: the tab and its workers die without running any more code.
      const crashed = new Promise<void>((resolve) => victim.once('crash', () => resolve()));
      const cdp = await context.newCDPSession(victim);
      void cdp.send('Page.crash').catch(() => undefined);
      await Promise.race([crashed, sleep(5000)]);
      void victim.close().catch(() => undefined);
    } else {
      await victim.close();
    }
    void open();
    current = await waitLeader(before);
    failover.push(Date.now() - killedAt);
    while (live.size < tabs) await sleep(10);
  }

  // Drain: stop the generators, wait until no tab has unacknowledged commits.
  await sleep(300);
  for (const page of live) await page.evaluate(() => (window as unknown as { __stop(): void }).__stop()).catch(() => undefined);
  let drained = false;
  for (let attempt = 0; attempt < 100 && !drained; attempt++) {
    const pending = await Promise.all(
      [...live].map((p) => p.evaluate(() => (window as unknown as { __pending(): Promise<number> }).__pending()).catch(() => 0)),
    );
    drained = pending.every((n) => n === 0);
    if (!drained) await sleep(100);
  }
  await sleep(200);
  const final = new Set(acked);
  for (const page of [...live]) await page.close();
  live.clear();
  await open({ mode: 'verify' });
  for (let i = 0; i < 600 && verify === undefined; i++) await sleep(50);
  await context.close();

  const recovered = new Set((verify?.['ids'] as string[] | undefined) ?? []);
  const missing = [...final].filter((id) => !recovered.has(id));
  const probe = [...probes.values()].reduce((a, p) => ({ reads: a.reads + p.reads, torn: a.torn + p.torn, regress: a.regress + p.regress }), { reads: 0, torn: 0, regress: 0 });
  const sorted = [...failover].sort((a, b) => a - b);
  ctx.log(
    `kills=${kills} acked=${final.size} recovered=${recovered.size} missing=${missing.length} drained=${drained} ` +
      `headReads=${probe.reads} torn=${probe.torn} regressed=${probe.regress} leaders=${leaders.length} ` +
      `failover median=${sorted[Math.floor(sorted.length / 2)] ?? 0}ms max=${sorted.at(-1) ?? 0}ms errors=${errors.length}`,
  );
  if (verify === undefined) throw new Error('the verifier tab never reported');
  if (verify['error'] !== undefined) throw new Error(`verifier recovery failed: ${String(verify['error'])}`);
  if (!drained) throw new Error('commits were still pending after the drain');
  if (final.size < kills * 10) throw new Error(`too few acknowledged commits (${final.size}) for a meaningful run`);
  if (missing.length > 0) throw new Error(`${missing.length} acknowledged commits lost, e.g. ${missing.slice(0, 5).join(', ')}`);
  if (probe.torn > 0 || probe.regress > 0) throw new Error(`unlocked head reads saw ${probe.torn} torn and ${probe.regress} regressed heads`);
  const badRecoveries = leaders.filter((l) => l.message['tempsRemoved'] === undefined);
  if (badRecoveries.length > 0) throw new Error('a leader reported no recovery');
  const pageErrors = errors.filter((e) => e.type === 'pageerror');
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.map((e) => String(e['message'])).join('; ')}`);
}
