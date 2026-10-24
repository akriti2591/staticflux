// 30-task slice of the IF-6.16 format eval: 10 flyer, 10 deck, 10 reel edits. Each task has:
//   prompt   – the instruction the model sees
//   scope    – what the agent view covers
//   human    – a concurrent human edit injected AFTER the view was read and BEFORE the agent's edit lands
//              (IF-6.16: "each with a concurrent human edit injected"); two tasks hit the same field on purpose
//   gold     – scripted edit (view-level ops, may use relational ops), used by the mock model only
//   check    – machine-checkable success predicate over the FINAL canonical state (Latest), view-independent
import { Stage } from '../src/stage.js';
import { TICKS_PER_SECOND } from '../src/units.js';
import { overflows } from '../src/lints.js';

export function stateOf(replica) {
  const st = new Stage(replica);
  const n = (nid) => st.node(nid);
  const abs = (nid) => {
    const r = n(nid); if (!r) return null;
    let x = r.props['spatial.x'] ?? 0, y = r.props['spatial.y'] ?? 0;
    for (let p = n(r.parent); p && p.kind !== 'page'; p = n(p.parent)) { x += p.props['spatial.x'] ?? 0; y += p.props['spatial.y'] ?? 0; }
    return { x, y, w: r.props['spatial.w'], h: r.props['spatial.h'] };
  };
  const s = (nid, path) => (n(nid)?.props[path] ?? NaN) / TICKS_PER_SECOND;
  const end = (nid) => s(nid, 'temporal.start') + s(nid, 'temporal.duration');
  const kids = (nid) => (n(nid)?.children ?? []).map(n);
  const all = () => { const out = []; for (const pid of replica.parts.keys()) for (const r of st.part(pid).nodes.values()) out.push(r); return out; };
  return { n, abs, s, end, kids, all };
}
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const nearT = (a, b) => Math.abs(a - b) <= 0.0015;            // time: 1.5 ms (the view prints 3 decimals)
const tokenIs = (v, t) => v && typeof v === 'object' && v.token === t;
const why = (cond, msg) => (cond ? true : msg);
const all = (...cs) => cs.find((c) => c !== true) ?? true;

const FLYER = 'page:fl-page';
const sp = ['fl-sp1', 'fl-sp2', 'fl-sp3'];
const BASE = { // seed geometry the predicates compare against (absolute page px)
  sp: { 'fl-sp1': { x: 120.4, y: 1200.2 }, 'fl-sp2': { x: 470.1, y: 1212.85 }, 'fl-sp3': { x: 760.7, y: 1193.6 } },
};

export const TASKS = [
  // ------------------------------------------------------------------------------------------ flyer
  { id: 'F01', doc: 'flyer', scope: FLYER, prompt: 'Align the three sponsor logos so their top edges line up with sponsor logo 1. Do not move them sideways.',
    human: (h) => h.set('fl-sp2', 'spatial.w', 210),
    gold: (H) => [{ op: 'align', ids: [H('sponsor logo 1'), H('sponsor logo 2'), H('sponsor logo 3')], edge: 'top', to: H('sponsor logo 1') }],
    check: (S) => all(...sp.map((id) => why(near(S.abs(id).y, 1200.2), `${id} top=${S.abs(id).y}`)), ...sp.map((id) => why(near(S.abs(id).x, BASE.sp[id].x), `${id} moved sideways`))) },
  { id: 'F02', doc: 'flyer', scope: FLYER, prompt: 'Make the headline fit inside its box. Keep the box position and size and the wording as they are.',
    human: (h) => h.set('fl-headline', 'style.fill', '#C0392B'),
    gold: (H) => [{ op: 'set', id: H('headline'), attrs: { size: 71 } }],
    check: (S) => { const r = S.n('fl-headline'), p = r.props, a = S.abs('fl-headline');
      return all(why(!overflows(r.text, { size: p['text.size'], weight: p['text.weight'], w: p['spatial.w'], h: p['spatial.h'], lineHeight: p['text.lineHeight'] }), `still overflows at size ${p['text.size']}`),
        why(p['text.size'] >= 50, 'shrunk too far'), why(r.text === 'MIDSUMMER NIGHT MARKET', 'text changed'),
        why(near(a.x, 80.4) && near(a.y, 196.73) && near(a.w, 920) && near(a.h, 150), 'box changed')); } },
  { id: 'F03', doc: 'flyer', scope: FLYER, prompt: 'Stack the three bullets vertically under bullet 1 with a 24 px gap between them, left-aligned with bullet 1. Bullet 1 stays where it is.',
    human: (h) => h.insertText('fl-b3', -1, ' (under 12s)'),
    gold: (H) => [{ op: 'stack', ids: [H('bullet 1'), H('bullet 2'), H('bullet 3')], direction: 'vertical', gap: 24, align: 'start' }],
    check: (S) => { const [a, b, c] = ['fl-b1', 'fl-b2', 'fl-b3'].map(S.abs);
      return all(why(near(a.y, 540.1) && near(a.x, 720.5), 'bullet 1 moved'), why(near(b.y, a.y + a.h + 24, 1) && near(c.y, b.y + b.h + 24, 1), `gaps ${b.y - a.y - a.h}, ${c.y - b.y - b.h}`), why(near(b.x, a.x, 1) && near(c.x, a.x, 1), 'not left-aligned')); } },
  { id: 'F04', doc: 'flyer', scope: FLYER, prompt: 'Place the ticket button 40 px below the hero photo, centered horizontally on the photo.',
    human: (h) => h.insertText('fl-cta-label', -1, ' now'),
    gold: (H) => [{ op: 'place', id: H('ticket button'), relativeTo: H('hero photo'), side: 'below', gap: 40, align: 'center' }],
    check: (S) => { const c = S.abs('fl-cta'), hp = S.abs('fl-hero'); return all(why(near(c.y, hp.y + hp.h + 40, 1), `y=${c.y}`), why(near(c.x + c.w / 2, hp.x + hp.w / 2, 1), `center ${c.x + c.w / 2} vs ${hp.x + hp.w / 2}`)); } },
  { id: 'F05', doc: 'flyer', scope: FLYER, prompt: 'The market moved to Sunday 15 November. Update the date line; keep the time.',
    human: (h) => h.set('fl-date', 'spatial.y', 450),
    gold: (H) => [{ op: 'text', id: H('date'), find: 'Sat 14 Nov', replace: 'Sun 15 Nov' }],
    check: (S) => { const t = S.n('fl-date').text; return why(/^Sun(day)?,? 15 Nov(ember)?\s*·\s*6–11 pm$/.test(t), `text="${t}"`); } },
  { id: 'F06', doc: 'flyer', scope: FLYER, prompt: 'Make the subhead use the brand accent color.',
    human: (h) => h.insertText('fl-subhead', -1, ' · DJs'),
    gold: (H) => [{ op: 'set', id: H('subhead'), attrs: { fill: '@accent' } }],
    check: (S) => why(tokenIs(S.n('fl-subhead').props['style.fill'], 'accent'), 'fill is not @accent') },
  { id: 'F07', doc: 'flyer', scope: FLYER, prompt: 'Remove the placeholder lorem-ipsum text. Leave everything else.',
    human: (h) => h.set('fl-hero', 'spatial.y', 530.33),
    gold: (H) => [{ op: 'delete', id: H('placeholder copy') }],
    check: (S) => all(why(!S.n('fl-lorem'), 'placeholder still there'), why(S.all().length === 18, `node count ${S.all().length}`)) },
  { id: 'F08', doc: 'flyer', scope: FLYER, prompt: 'Add a round "Free entry" badge: a 160×160 circle filled with the brand accent color in the top-right corner of the page, 40 px from the top and right edges, with the text "Free entry" centered on it in white.',
    human: (h) => h.set('fl-logo', 'spatial.x', 70),
    gold: (H) => [
      { op: 'insert', tempId: 'new:badge', parent: H('Night market flyer'), el: { kind: 'ellipse', name: 'free entry badge', role: 'badge', x: 880, y: 40, w: 160, h: 160, fill: '@accent' } },
      { op: 'insert', tempId: 'new:badgeText', parent: H('Night market flyer'), after: 'new:badge', el: { kind: 'text', name: 'badge text', role: 'badge', x: 880, y: 100, w: 160, h: 40, size: 28, weight: 700, fill: '#FFFFFF', align: 'center', text: 'Free entry' } }],
    check: (S) => {
      const nodes = S.all();
      const circle = nodes.find((r) => r.kind === 'ellipse' && near(S.abs(r.id).x, 880, 1) && near(S.abs(r.id).y, 40, 1) && near(r.props['spatial.w'], 160, 1) && near(r.props['spatial.h'], 160, 1));
      if (!circle) return 'no 160×160 circle at (880,40)';
      if (!tokenIs(circle.props['style.fill'], 'accent')) return 'circle is not @accent';
      const t = nodes.find((r) => r.kind === 'text' && /free entry/i.test(r.text ?? ''));
      if (!t) return 'no "Free entry" text';
      const a = S.abs(t.id); const cx = a.x + (a.w ?? 0) / 2, cy = a.y + (a.h ?? 0) / 2;
      const order = (id) => { const chain = []; for (let r = S.n(id); r; r = S.n(r.parent)) chain.unshift(r.id); return chain; };
      const inFront = (() => { const ca = order(circle.id), ta = order(t.id); let i = 0; while (ca[i] === ta[i]) i++; const par = S.n(ca[i - 1]); return par.children.indexOf(ta[i]) > par.children.indexOf(ca[i]); })();
      return all(why(near(cx, 960, 12) && near(cy, 120, 12), `text center (${cx},${cy})`), why(inFront, 'text is behind the circle'), why(String(t.props['style.fill']).toUpperCase() === '#FFFFFF', 'text not white'));
    } },
  { id: 'F09', doc: 'flyer', scope: FLYER, prompt: 'Bring the headline in front of everything else on the page.',
    human: (h) => h.set('fl-headline', 'text.weight', 900),
    gold: (H) => [{ op: 'reorder', id: H('headline'), to: 'front' }],
    check: (S) => why(S.n('fl-page').children.at(-1) === 'fl-headline', 'headline is not front-most') },
  { id: 'F10', doc: 'flyer', scope: FLYER, prompt: 'Space the three sponsor logos evenly so the gaps between them are equal. Keep sponsor logo 1 and sponsor logo 3 where they are, and do not change their heights.',
    human: (h) => h.set('fl-sp1', 'spatial.opacity', 0.9),
    gold: (H) => [{ op: 'distribute', ids: [H('sponsor logo 1'), H('sponsor logo 2'), H('sponsor logo 3')], axis: 'x' }],
    check: (S) => { const [a, b, c] = sp.map(S.abs); return all(why(near(a.x, 120.4) && near(c.x, 760.7), 'end logos moved'), why(near(b.x - a.x - a.w, c.x - b.x - b.w, 1), `gaps ${b.x - a.x - a.w} / ${c.x - b.x - b.w}`), why(near(b.y, 1212.85), 'logo 2 moved vertically')); } },

  // ------------------------------------------------------------------------------------------ deck
  { id: 'D01', doc: 'deck', scope: 'doc', prompt: 'Make the titles on slides 2–5 all the same font size as the Agenda title. Leave the cover title alone.',
    human: (h) => h.insertText('dk-3-title', -1, ' (beta)'),
    gold: (H) => [3, 5].map((s) => ({ op: 'set', id: H(`title slide ${s}`), attrs: { size: 72 } })),
    check: (S) => all(...[2, 3, 4, 5].map((s) => why(S.n(`dk-${s}-title`).props['text.size'] === 72, `slide ${s} title size ${S.n(`dk-${s}-title`).props['text.size']}`)), why(S.n('dk-1-title').props['text.size'] === 120, 'cover title changed')) },
  { id: 'D02', doc: 'deck', scope: 'page:dk-s3', prompt: 'Align the two screenshots by their top edges, using screenshot A as the reference.',
    human: (h) => h.set('dk-3-shot-b', 'style.radius', 24),
    gold: (H) => [{ op: 'align', ids: [H('screenshot A'), H('screenshot B')], edge: 'top', to: H('screenshot A') }],
    check: (S) => all(why(near(S.abs('dk-3-shot-b').y, S.abs('dk-3-shot-a').y), 'tops differ'), why(near(S.abs('dk-3-shot-a').y, 320.2), 'A moved'), why(near(S.abs('dk-3-shot-b').x, 1000), 'B moved sideways')) },
  { id: 'D03', doc: 'deck', scope: 'doc', prompt: 'Move the logo on every slide to the bottom-right corner, 40 px from the right edge and 40 px from the bottom edge.',
    // same-field conflict on purpose: the human drags slide 2's logo meanwhile; the agent op for it must be flagged, not applied
    human: (h) => { h.set('dk-2-logo', 'spatial.x', 100); h.set('dk-2-logo', 'spatial.y', 100); },
    expectStale: ['dk-2-logo'],
    gold: (H) => [1, 2, 3, 4, 5].map((s) => ({ op: 'place', id: H(`logo slide ${s}`), relativeTo: 'page', side: 'inside', corner: 'bottom-right', gap: 40 })),
    check: (S, ctx) => all(...[1, 3, 4, 5].map((s) => why(near(S.abs(`dk-${s}-logo`).x, 1720, 1) && near(S.abs(`dk-${s}-logo`).y, 980, 1), `slide ${s} logo at ${S.abs(`dk-${s}-logo`).x},${S.abs(`dk-${s}-logo`).y}`)),
      why(S.abs('dk-2-logo').x === 100 && S.abs('dk-2-logo').y === 100, 'human move on slide 2 was overwritten'),
      why(ctx.staleNodes.includes('dk-2-logo'), 'conflict on slide 2 logo not flagged')) },
  { id: 'D04', doc: 'deck', scope: 'doc', prompt: 'We are presenting next quarter: replace "Q3" with "Q4" everywhere in the deck.',
    human: (h) => h.insertText('dk-4-body', -1, ' (draft)'),
    gold: (H) => [['title slide 1'], ['title slide 4'], ['metrics body']].map(([n]) => ({ op: 'text', id: H(n), find: 'Q3', replace: 'Q4' })),
    check: (S) => { const texts = S.all().filter((r) => r.kind === 'text').map((r) => r.text); return all(why(!texts.some((t) => t.includes('Q3')), 'Q3 still present'), why(S.n('dk-1-title').text === 'Q4 Product Update' && S.n('dk-4-title').text === 'Q4 metrics' && S.n('dk-4-body').text.includes('in Q4'), 'Q4 missing')); } },
  { id: 'D05', doc: 'deck', scope: 'page:dk-s4', prompt: 'Delete the TODO note.',
    human: (h) => h.set('dk-4-chart', 'spatial.x', 1010),
    gold: (H) => [{ op: 'delete', id: H('todo note') }],
    check: (S) => all(why(!S.n('dk-4-notes'), 'note still there'), why(S.n('dk-4-body') && S.n('dk-4-chart') && S.n('dk-4-title'), 'deleted too much')) },
  { id: 'D06', doc: 'deck', scope: 'page:dk-s2', prompt: 'Put "Pricing" first in the agenda list. Keep the items in the same place on the slide, evenly spaced 80 px apart (top to top), and keep the others in their current order.',
    human: (h) => h.insertText('dk-2-b4', -1, ' & Q&A'),
    gold: (H) => [{ op: 'set', id: H('agenda item Pricing'), attrs: { y: 300 } }, { op: 'set', id: H('agenda item Highlights'), attrs: { y: 380 } }, { op: 'set', id: H('agenda item Metrics'), attrs: { y: 460 } }],
    check: (S) => { const items = ['dk-2-b1', 'dk-2-b2', 'dk-2-b3', 'dk-2-b4'].map((id) => ({ id, y: S.abs(id).y })).sort((a, b) => a.y - b.y);
      return all(why(items.map((i) => i.id).join() === 'dk-2-b3,dk-2-b1,dk-2-b2,dk-2-b4', `order ${items.map((i) => i.id)}`), why(items.every((it, k) => near(it.y, 300 + 80 * k, 1)), `ys ${items.map((i) => i.y)}`)); } },
  { id: 'D07', doc: 'deck', scope: 'page:dk-s5', prompt: 'Spread the three team photos so the gaps between them are equal. Keep Ana and Chen where they are.',
    human: (h) => h.set('dk-5-p2', 'style.radius', 40),
    gold: (H) => [{ op: 'distribute', ids: [H('photo Ana'), H('photo Ben'), H('photo Chen')], axis: 'x' }],
    check: (S) => { const [a, b, c] = ['dk-5-p1', 'dk-5-p2', 'dk-5-p3'].map(S.abs); return all(why(near(a.x, 200.2) && near(c.x, 1320.1), 'Ana or Chen moved'), why(near(b.x - a.x - a.w, c.x - b.x - b.w, 1), `gaps ${b.x - a.x - a.w}/${c.x - b.x - b.w}`)); } },
  { id: 'D08', doc: 'deck', scope: 'page:dk-s1', prompt: 'Put the subtitle 40 px below the title, left-aligned with the title.',
    human: (h) => h.insertText('dk-1-sub', -1, ' · Berlin'),
    gold: (H) => [{ op: 'place', id: H('subtitle slide 1'), relativeTo: H('title slide 1'), side: 'below', gap: 40, align: 'start' }],
    check: (S) => { const t = S.abs('dk-1-title'), s = S.abs('dk-1-sub'); return all(why(near(s.y, t.y + t.h + 40, 1), `y=${s.y}`), why(near(s.x, t.x, 1), `x=${s.x}`)); } },
  { id: 'D09', doc: 'deck', scope: 'page:dk-s4', prompt: 'Make the chart fill the right half of the slide (the right half starts at x = 960), leaving an 80 px margin on every side of the chart within that half.',
    human: (h) => h.set('dk-4-chart', 'image.fit', 'contain'),
    gold: (H) => [{ op: 'set', id: H('revenue chart'), attrs: { x: 1040, y: 80, w: 800, h: 920 } }],
    check: (S) => { const c = S.abs('dk-4-chart'); return why(near(c.x, 1040, 1) && near(c.y, 80, 1) && near(c.w, 800, 1) && near(c.h, 920, 1), `chart ${c.x},${c.y} ${c.w}×${c.h}`); } },
  { id: 'D10', doc: 'deck', scope: 'doc', prompt: 'Switch the deck to dark mode: every slide background uses the dark brand color and every slide title uses the light brand color.',
    human: (h) => h.insertText('dk-5-title', -1, ' & partners'),
    gold: (H, v) => [...v.model.pages.map((p) => ({ op: 'set', id: p.id, attrs: { fill: '@dark' } })), ...[1, 2, 3, 4, 5].map((s) => ({ op: 'set', id: H(`title slide ${s}`), attrs: { fill: '@light' } }))],
    check: (S) => all(...[1, 2, 3, 4, 5].map((s) => why(tokenIs(S.n(`dk-s${s}`).props['style.fill'], 'dark'), `slide ${s} background`)), ...[1, 2, 3, 4, 5].map((s) => why(tokenIs(S.n(`dk-${s}-title`).props['style.fill'], 'light'), `slide ${s} title color`))) },

  // ------------------------------------------------------------------------------------------ reel (timeline view)
  { id: 'R01', doc: 'reel', scope: 'page:rl-page', prompt: 'Shorten clip 2 so it ends exactly on the last beat of the song before its current end, and ripple the later clips on the main track so no gap appears.',
    human: (h) => h.insertText('rl-t1', -1, '!'),
    gold: (H) => [{ op: 'trim', id: H('clip 2 food stalls'), end: 8.812, ripple: true }],
    check: (S, ctx) => { const e2 = S.end('rl-c2'); const beat = ctx.beatsTimeline.filter((b) => b < 9.3 - 0.0015).at(-1);
      return all(why(nearT(e2, beat), `clip 2 ends at ${e2.toFixed(3)}, beat ${beat.toFixed(3)}`), why(nearT(S.s('rl-c3', 'temporal.start'), e2), 'gap/overlap after clip 2'),
        why(nearT(S.s('rl-c4', 'temporal.start'), 13.7 - (9.3 - e2)) && nearT(S.s('rl-c5', 'temporal.start'), 16.7 - (9.3 - e2)), 'later clips not rippled'),
        why(['rl-c3', 'rl-c4', 'rl-c5'].every((c, i) => nearT(S.s(c, 'temporal.duration'), [4.4, 3, 3.3][i])), 'later clip lengths changed'), why(nearT(S.s('rl-t2', 'temporal.start'), 4.4), 'captions moved')); } },
  { id: 'R02', doc: 'reel', scope: 'page:rl-page', prompt: 'Move caption 3 so it starts exactly when clip 3 starts, keeping its length.',
    human: (h) => h.insertText('rl-t3', -1, '!'),
    gold: (H) => [{ op: 'place', id: H('caption 3'), start: 9.3 }],
    check: (S) => all(why(nearT(S.s('rl-t3', 'temporal.start'), S.s('rl-c3', 'temporal.start')), `starts ${S.s('rl-t3', 'temporal.start')}`), why(nearT(S.s('rl-t3', 'temporal.duration'), 0.7), 'length changed')) },
  { id: 'R03', doc: 'reel', scope: 'page:rl-page', prompt: 'Delete clip 4 and close the gap it leaves on the main track.',
    human: (h) => h.set('rl-c3', 'audio.volume', 0.5),
    gold: (H) => [{ op: 'delete', id: H('clip 4 crowd'), ripple: true }],
    check: (S) => all(why(!S.n('rl-c4'), 'clip 4 still there'), why(nearT(S.s('rl-c5', 'temporal.start'), 13.7), `clip 5 starts ${S.s('rl-c5', 'temporal.start')}`), why(nearT(S.s('rl-c5', 'temporal.duration'), 3.3), 'clip 5 length changed'), why(nearT(S.s('rl-c3', 'temporal.start'), 9.3), 'earlier clips moved')) },
  { id: 'R04', doc: 'reel', scope: 'page:rl-page', prompt: 'Make every caption at least 1.2 s long without moving its start and without overlapping the next caption.',
    // same-field conflict on purpose: the human lengthens caption 3 to 1.5 s meanwhile → the agent op on caption 3 is flagged; 1.5 s still satisfies the task
    human: (h) => h.setSec('rl-t3', 'temporal.duration', 1.5), expectStale: ['rl-t3'],
    gold: (H) => [{ op: 'set', id: H('caption 3'), attrs: { dur: 1.2 } }, { op: 'set', id: H('caption 4'), attrs: { dur: 1.2 } }],
    check: (S, ctx) => { const caps = ['rl-t1', 'rl-t2', 'rl-t3', 'rl-t4', 'rl-t5'];
      const starts = [0.3, 4.4, 9.5, 13.9, 17];
      return all(...caps.map((c) => why(S.s(c, 'temporal.duration') >= 1.2 - 0.0015, `${c} dur ${S.s(c, 'temporal.duration')}`)), ...caps.map((c, i) => why(nearT(S.s(c, 'temporal.start'), starts[i]), `${c} moved`)),
        ...caps.slice(1).map((c, i) => why(S.end(caps[i]) <= S.s(c, 'temporal.start') + 0.0015, `${caps[i]} overlaps ${c}`)), why(nearT(S.s('rl-t3', 'temporal.duration'), 1.5), 'human edit on caption 3 overwritten'), why(ctx.staleNodes.includes('rl-t3'), 'conflict not flagged')); } },
  { id: 'R05', doc: 'reel', scope: 'page:rl-page', prompt: 'Fix the typo in caption 2.',
    human: (h) => h.setSec('rl-t2', 'temporal.start', 4.5),
    gold: (H) => [{ op: 'text', id: H('caption 2'), find: 'Teh', replace: 'The' }],
    check: (S) => why(S.n('rl-t2').text === 'The best street food in town', `text="${S.n('rl-t2').text}"`) },
  { id: 'R06', doc: 'reel', scope: 'page:rl-page', prompt: 'Split clip 1 at 2.0 s on the timeline.',
    human: (h) => h.set('rl-c1', 'audio.volume', 0.6),
    gold: (H) => [{ op: 'split', id: H('clip 1 city skyline'), at: 2 }],
    check: (S) => { const vids = S.kids('rl-main').filter((r) => r.props['source.asset'] === 'as_city').sort((a, b) => a.props['temporal.start'] - b.props['temporal.start']);
      if (vids.length !== 2) return `${vids.length} pieces of clip 1`;
      const [a, b] = vids.map((r) => r.id);
      return all(why(nearT(S.s(a, 'temporal.start'), 0) && nearT(S.end(a), 2) && nearT(S.s(b, 'temporal.start'), 2) && nearT(S.end(b), 4.2), 'wrong timeline ranges'),
        why(nearT(S.s(a, 'source.in'), 3) && nearT(S.s(a, 'source.out'), 5) && nearT(S.s(b, 'source.in'), 5) && nearT(S.s(b, 'source.out'), 7.2), 'wrong source ranges')); } },
  { id: 'R07', doc: 'reel', scope: 'page:rl-page', prompt: 'Fade the music out over the last 2 seconds.',
    human: (h) => h.set('rl-song', 'audio.volume', 0.7),
    gold: (H) => [{ op: 'set', id: H('song'), attrs: { fadeOut: 2 } }],
    check: (S) => why(nearT(S.s('rl-song', 'audio.fadeOut'), 2), `fadeOut ${S.s('rl-song', 'audio.fadeOut')}`) },
  { id: 'R08', doc: 'reel', scope: 'page:rl-page', prompt: 'Swap clips 2 and 3: clip 3 plays right after clip 1, then clip 2, with no gaps. Clips 4 and 5 stay where they are.',
    human: (h) => h.set('rl-c2', 'audio.volume', 0.9),
    gold: (H) => [{ op: 'place', id: H('clip 3 live stage'), start: 4.2 }, { op: 'place', id: H('clip 2 food stalls'), start: 8.6 }],
    check: (S) => all(why(nearT(S.s('rl-c3', 'temporal.start'), 4.2), `clip 3 at ${S.s('rl-c3', 'temporal.start')}`), why(nearT(S.s('rl-c2', 'temporal.start'), 8.6), `clip 2 at ${S.s('rl-c2', 'temporal.start')}`),
      why(nearT(S.s('rl-c2', 'temporal.duration'), 5.1) && nearT(S.s('rl-c3', 'temporal.duration'), 4.4), 'lengths changed'), why(nearT(S.s('rl-c4', 'temporal.start'), 13.7), 'clip 4 moved')) },
  { id: 'R09', doc: 'reel', scope: 'page:rl-page', prompt: 'Add a caption "Link in bio" that starts 0.2 s after the last caption ends and runs until the end of the reel.',
    human: (h) => h.insertText('rl-t5', -1, ' 2026'),
    gold: (H, v) => [{ op: 'insert', tempId: 'new:link', parent: v.model.tracks[1].id, el: { kind: 'text', name: 'caption 6', role: 'caption', start: 18.8, dur: 1.2, text: 'Link in bio' } }],
    check: (S) => { const c = S.kids('rl-caps').find((r) => /link in bio/i.test(r.text ?? ''));
      return c ? all(why(nearT(S.s(c.id, 'temporal.start'), 18.8), `starts ${S.s(c.id, 'temporal.start')}`), why(nearT(S.end(c.id), 20), `ends ${S.end(c.id)}`)) : 'no "Link in bio" caption on the captions track'; } },
  { id: 'R10', doc: 'reel', scope: 'page:rl-page', prompt: 'Cut the reel down to 15 s: nothing (clips, captions, music) may extend past 15 s, the main track must still run without gaps from 0 to 15 s, and the reel itself must be 15 s long.',
    human: (h) => h.insertText('rl-t2', -1, '!'),
    gold: (H, v) => [{ op: 'trim', id: H('clip 4 crowd'), end: 15 }, { op: 'delete', id: H('clip 5 night lights') }, { op: 'delete', id: H('caption 5') }, { op: 'trim', id: H('song'), end: 15 }, { op: 'set', id: v.model.page.id, attrs: { dur: 15 } }],
    check: (S) => { const items = [...S.kids('rl-main'), ...S.kids('rl-caps'), ...S.kids('rl-music')];
      const main = S.kids('rl-main').sort((a, b) => a.props['temporal.start'] - b.props['temporal.start']);
      const contiguous = main.every((r, i) => (i === 0 ? nearT(S.s(r.id, 'temporal.start'), 0) : nearT(S.s(r.id, 'temporal.start'), S.end(main[i - 1].id))));
      return all(why(nearT(S.s('rl-page', 'temporal.duration'), 15), 'reel is not 15 s'), why(items.every((r) => S.end(r.id) <= 15.0015), 'something extends past 15 s'), why(contiguous && nearT(S.end(main.at(-1).id), 15), 'main track has gaps or ends early')); } },
];
