import { err, ok, toSfError, token, unit } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { defineSubsystem, FrameSchedulerToken, runtimeUnits } from '@staticflux/runtime';
import { defineRoute, guard, redirect } from '@staticflux/router';
import { describe, expect, it } from 'vitest';
import { bootTestApp, createFakeSession, createFakeTime, provideValue } from './index.js';

const ConfigToken = token('it/config').type<{ readonly name: string }>();
const configUnit = unit({ id: 'it/config-unit', provides: ConfigToken, scope: 'app', critical: true, create: () => ({ name: 'real' }) });

const home = defineRoute({ id: 'it/home', path: '/' });
const doc = defineRoute({ id: 'it/doc', path: 'doc/:id' });
const login = defineRoute({ id: 'it/login', path: 'login' });
const secret = defineRoute({
  id: 'it/secret',
  path: 'secret',
  guards: { authorize: [guard(() => redirect({ to: login }))] },
});

describe('bootTestApp', () => {
  it('boots with recording telemetry and the boot span tree', async () => {
    const t = await bootTestApp({ units: [configUnit] });
    expect(t.app.supervisor.state).toBe('running');
    expect((await t.get(ConfigToken)).name).toBe('real');
    t.expectChildSpan('app.boot', 'boot.core');
    t.expectChildSpan('app.boot', 'boot.critical');
    t.expectChildSpan('boot.critical', { name: 'di.resolve', attrs: { unit: 'it/config-unit' } }, { deep: true });
    t.expectNoViolations();
    expect(t.router).toBeUndefined();
    expect(t.session).toBeUndefined();
    await t.shutdown();
    expect(t.app.supervisor.state).toBe('terminated');
  });

  it('overrides win over app units', async () => {
    const t = await bootTestApp({ units: [configUnit], overrides: [provideValue(ConfigToken, { name: 'fake' })] });
    expect((await t.get(ConfigToken)).name).toBe('fake');
    await t.shutdown();
  });

  it('boot failures throw SF-TEST-001 with the boot error as cause', async () => {
    const failing = unit({ id: 'it/failing', provides: ConfigToken, scope: 'app', critical: true, create: () => ({ name: 'x' }), init: () => err(toSfError(new Error('nope'))) });
    await expect(bootTestApp({ units: [failing] })).rejects.toMatchObject({ code: 'SF-TEST-001' });
  });

  it('get() throws SF-TEST-002 for missing providers', async () => {
    const t = await bootTestApp();
    await expect(t.get(ConfigToken)).rejects.toMatchObject({ code: 'SF-TEST-002' });
    await t.shutdown();
  });

  it('routes add a router on a memory history and run the first navigation', async () => {
    const t = await bootTestApp({ routes: [home, doc, login, secret], initialUrl: '/doc/42' });
    expect(t.router?.current?.route).toBe(doc);
    expect(t.router?.current?.params).toEqual({ id: '42' });
    await t.router?.navigate({ to: home });
    expect(t.history?.entries.map((e) => e.url)).toEqual(['/doc/42', '/']);
    await t.router?.navigate({ to: secret });
    expect(t.router?.current?.route).toBe(login);
    expect(t.spans({ subsystem: /^router\// }).length).toBeGreaterThan(0);
    await t.shutdown();
  });

  it('a session spec creates a fake session bound into the app', async () => {
    const t = await bootTestApp({ session: { initial: { user: 'ada', roles: ['editor'] } } });
    const store = await t.get(SessionToken);
    expect(store).toBe(t.session?.store);
    expect(store.principal).toMatchObject({ id: 'ada', roles: ['editor'] });
    await t.session?.logout();
    expect(store.state).toBe('guest');
    await t.shutdown();
  });

  it('accepts an existing fake session', async () => {
    const session = createFakeSession();
    const t = await bootTestApp({ session });
    expect(t.session).toBe(session);
    expect(await t.get(SessionToken)).toBe(session.store);
    await t.shutdown();
  });

  it('fake time drives the frame scheduler, supervisor sleeps and the session clock', async () => {
    const time = createFakeTime({ start: 0 });
    let starts = 0;
    const flaky = defineSubsystem({
      id: 'it/flaky',
      critical: false,
      restart: { baseDelayMs: 1_000, maxDelayMs: 1_000, jitter: 'none', maxRestarts: 3, windowMs: 60_000 },
      start: () => {
        starts += 1;
        return starts === 1 ? err(toSfError(new Error('first start fails'))) : ok();
      },
    });
    const t = await bootTestApp({ units: [...runtimeUnits], subsystems: [flaky], time, session: { initial: 'ada', expiresInMs: 10_000, refresh: false } });
    expect(t.time).toBe(time);
    expect(starts).toBe(1);
    // Restart back-off only elapses when the test moves time.
    await time.advance(1_000);
    await t.app.supervisor.settled();
    expect(starts).toBe(2);

    const scheduler = await t.get(FrameSchedulerToken);
    const log: string[] = [];
    scheduler.schedule(() => void log.push('frame'));
    expect(log).toEqual([]);
    await time.flush();
    expect(log).toEqual(['frame']);

    expect(t.session?.snapshot.state).toBe('authenticated');
    await time.advance(10_000);
    expect(t.session?.snapshot.state).toBe('expired');
    await t.shutdown();
  });
});
