import { checkShortcuts } from '@staticflux/a11y';
import { err, ok, type Result, sfError, type SfError } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { TOOL_KEYMAP } from '../tools/keyboard.js';
import { createMirrorHub, type MirrorCall } from '../workers/mirror.js';
import { AppearanceMirror, LatestMirror, MilestonesMirror, RepeatMirror, StoryMirror, TypographyMirror } from '../workers/mirrors.js';
import { canvasShortcutDefs, DeleteShortcut, UndoShortcut } from './canvas-shortcuts.js';
import { STUDIO_KEY_COMMANDS } from './studio-commands.js';
import { appearanceSource, latestFromMirror, milestonesFromMirror, repeatSource, storyFromMirror, structureFromMirror, typographyFromMirror } from './panel-mirrors.js';

const nope = sfError({ code: 'IF-TEST-002' as never, kind: 'validation', message: 'Refused.' });

/** A hub whose worker answers every call from `answer` and records it. */
function hubOf(answer: (call: MirrorCall) => Result<unknown> = () => ok(undefined)) {
  const calls: MirrorCall[] = [];
  const hub = createMirrorHub(async (call) => {
    calls.push(call);
    return answer(call);
  });
  return { hub, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('panel models over mirrors (B9)', () => {
  it('appearance and repeat sources read the posted model and forward edits; failures are reported', async () => {
    const { hub, calls } = hubOf((c) => (c.action === 'apply' && (c.args[0] as { op: string }).op === 'bad' ? err(nope) : ok(undefined)));
    const problems: SfError[] = [];
    const appearance = appearanceSource(hub.view(AppearanceMirror), (e) => problems.push(e));
    expect(appearance.model()).toBeUndefined();
    const heard: number[] = [];
    appearance.subscribe(() => heard.push(1));
    hub.apply({ id: AppearanceMirror.id, values: { model: { node: 'a', opacity: 1 } } });
    expect(appearance.model()?.node).toBe('a');
    expect(heard).toEqual([1]);
    appearance.apply({ op: 'set', path: 'spatial.opacity', value: 0.5 });
    appearance.apply({ op: 'bad' } as never);
    await tick();
    expect(calls.map((c) => [c.id, c.action])).toEqual([[AppearanceMirror.id, 'apply'], [AppearanceMirror.id, 'apply']]);
    expect(problems.map((p) => p.code)).toEqual(['IF-TEST-002']);
    const repeat = repeatSource(hub.view(RepeatMirror), () => undefined);
    hub.apply({ id: RepeatMirror.id, values: { model: { node: 'r', instances: 6 } } });
    expect(repeat.model()?.instances).toBe(6);
    repeat.apply({ op: 'release' });
    await tick();
    expect(calls.at(-1)).toMatchObject({ id: RepeatMirror.id, action: 'apply', args: [{ op: 'release' }] });
  });

  it('typography answers setters optimistically and forwards them in order', async () => {
    const { hub, calls } = hubOf((c) => (c.action === 'fitToBox' ? err(nope) : ok(undefined)));
    const problems: string[] = [];
    const t = typographyFromMirror(hub.view(TypographyMirror), (e) => problems.push(e.code));
    expect([t.summary(), t.fontChoices(), t.colorChoices()]).toEqual([undefined, [], []]);
    hub.apply({ id: TypographyMirror.id, values: { summary: { size: 48 }, fonts: [{ label: 'Noto', value: { font: 'sha256:1' } }], colors: [] } });
    expect(t.summary()?.size).toBe(48);
    expect(t.fontChoices()[0]?.label).toBe('Noto');
    for (const r of [t.setFont({ font: 'sha256:1' }), t.setSize(12), t.setWeight(700), t.toggle('bold'), t.setColor('#000'), t.setLetterSpacing(1), t.setLink(null), t.setAlign('center'), t.setLineHeight(1.2), t.fitToBox()]) expect(r.ok).toBe(true);
    await tick();
    expect(calls.map((c) => c.action)).toEqual(['setFont', 'setSize', 'setWeight', 'toggle', 'setColor', 'setLetterSpacing', 'setLink', 'setAlign', 'setLineHeight', 'fitToBox']);
    expect(problems).toEqual(['IF-TEST-002']);
    let changes = 0;
    t.onChange(() => (changes += 1));
    hub.apply({ id: TypographyMirror.id, values: { summary: undefined, fonts: [], colors: [] } });
    expect(changes).toBe(1);
  });

  it('milestones, Latest and the story forward to the editor; the structure feed reads the posted structure', async () => {
    const { hub, calls } = hubOf((c) => (c.action === 'create' ? ok({ id: 'ms_1', name: c.args[0] }) : ok(undefined)));
    const m = milestonesFromMirror(hub.view(MilestonesMirror));
    expect([m.milestones(), m.busy()]).toEqual([[], 'idle']);
    expect(await m.create('Draft')).toEqual({ ok: true, value: { id: 'ms_1', name: 'Draft' } });
    await m.create('With note', 'note');
    await m.pin('ms_1', true);
    await m.rename('ms_1', 'Renamed');
    expect((await m.open('ms_1')).ok).toBe(true);
    expect((await m.compare('ms_1', 'latest')).ok).toBe(true);
    expect((await m.newDocument('ms_1')).ok).toBe(true);
    await m.refresh();
    expect(calls.map((c) => [c.action, c.args.length])).toEqual([['create', 1], ['create', 2], ['pin', 2], ['rename', 2], ['open', 1], ['compare', 2], ['newDocument', 1], ['refresh', 0]]);
    const latest = latestFromMirror(hub.view(LatestMirror));
    expect(latest.state().status).toBe('saved');
    const states: string[] = [];
    latest.onChange((s) => states.push(s.status));
    hub.apply({ id: LatestMirror.id, values: { state: { status: 'saving', stalled: false, since: 1 } } });
    expect(states).toEqual(['saving']);
    expect((await latest.flush(new AbortController().signal)).ok).toBe(true);
    latest.dispose();
    const feed = structureFromMirror(hub.view(StoryMirror));
    expect(feed.read().ok).toBe(false); // not posted yet: still opening
    let observed = 0;
    feed.observe(() => (observed += 1));
    hub.apply({ id: StoryMirror.id, values: { structure: { ok: true, value: { composition: 'c', format: { width: 1, height: 1 }, pages: [], loose: [] } } } });
    expect(feed.read()).toMatchObject({ ok: true, value: { composition: 'c' } });
    expect(observed).toBe(1);
    expect(storyFromMirror(hub.view(StoryMirror), () => undefined).movePage('p2', 0).ok).toBe(true);
    await tick();
    expect(calls.at(-1)).toMatchObject({ id: StoryMirror.id, action: 'movePage', args: ['p2', 0] });
  });
});

describe('canvas shortcuts (B9: registered on main, run in the editor)', () => {
  it('are B3’s keymap plus Undo, Redo, Delete and Duplicate, without conflicts', () => {
    const defs = canvasShortcutDefs();
    expect(defs.length).toBe(TOOL_KEYMAP.length + STUDIO_KEY_COMMANDS.length); // B11b: plus the structure keys
    expect(defs).toEqual(expect.arrayContaining([UndoShortcut, DeleteShortcut]));
    expect(checkShortcuts(defs).filter((i) => i.severity === 'error')).toEqual([]);
  });
});
