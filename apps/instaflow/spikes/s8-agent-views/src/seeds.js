// Realistic seed documents. Geometry is stored with full-precision floats (as a real editor produces after drags and
// snapping), time in ticks, colors as brand tokens where a designer would use them. NodeIds are readable here;
// agents only ever see session handles.
import { secToTicks, prng } from './units.js';

const tok = (t) => ({ token: t });
const g = (x, y, w, h) => ({ 'spatial.x': x, 'spatial.y': y, 'spatial.w': w, 'spatial.h': h });
const txt = (id, name, role, box, text, s = {}) => ({ id, kind: 'text', props: { name, role, ...box, 'text.size': s.size ?? 32, 'text.weight': s.weight, 'text.font': s.font, 'style.fill': s.fill ?? tok('ink'), 'text.align': s.align, 'text.lineHeight': s.lineHeight, ...(s.props ?? {}) }, text });
const img = (id, name, role, box, src, extra = {}) => ({ id, kind: 'image', props: { name, role, ...box, 'source.asset': src, ...extra } });

const BRAND = { primary: '#E4572E', accent: '#17BEBB', ink: '#1D1A2F', cream: '#FFF4E0', light: '#F7F7F2', dark: '#121826', muted: '#7A7F8C', display: 'Fraunces', body: 'Inter' };

export function flyerSeed() {
  return {
    title: 'Midsummer Night Market', kind: 'flyer', tokens: BRAND,
    assets: { as_bg_lanterns: { kind: 'image' }, as_hero_stalls: { kind: 'image' }, as_logo_city: { kind: 'image' }, as_logo_brew: { kind: 'image' }, as_logo_radio: { kind: 'image' }, as_logo_market: { kind: 'image' } },
    pages: [{
      id: 'fl-page', kind: 'page', props: { name: 'Night market flyer', 'spatial.w': 1080, 'spatial.h': 1350, 'style.fill': tok('cream') },
      children: [
        img('fl-bg', 'background', 'background', g(0, 0, 1080, 1350), 'as_bg_lanterns', { 'lock.scope': 'position', 'spatial.opacity': 0.35 }),
        img('fl-logo', 'market logo', 'logo', g(60.25, 48.5, 180, 72), 'as_logo_market'),
        txt('fl-headline', 'headline', 'headline', g(80.4, 196.73, 920, 150), 'MIDSUMMER NIGHT MARKET', { size: 140, weight: 800, font: tok('display'), fill: tok('primary'), align: 'center', lineHeight: 1.05 }),
        txt('fl-subhead', 'subhead', 'subhead', g(80, 370.2, 920, 56), 'Street food · Live music · Makers', { size: 44, align: 'center', fill: tok('ink') }),
        txt('fl-date', 'date', 'date', g(80, 438.6, 920, 44), 'Sat 14 Nov · 6–11 pm', { size: 36, weight: 600, align: 'center', fill: tok('primary') }),
        img('fl-hero', 'hero photo', 'hero', g(80, 520.33, 600, 450), 'as_hero_stalls', { 'style.radius': 24 }),
        txt('fl-b1', 'bullet 1', 'bullet', g(720.5, 540.1, 300, 40), '40+ food stalls', { size: 30 }),
        txt('fl-b2', 'bullet 2', 'bullet', g(721.2, 611.77, 300, 40), '3 live stages', { size: 30 }),
        txt('fl-b3', 'bullet 3', 'bullet', g(719.8, 668.4, 300, 40), 'Free kids zone', { size: 30 }),
        { id: 'fl-cta', kind: 'group', props: { name: 'ticket button', role: 'cta', ...g(720.6, 780.25, 300, 90) }, children: [
          { id: 'fl-cta-bg', kind: 'rect', props: { name: 'button shape', ...g(0, 0, 300, 90), 'style.fill': tok('primary'), 'style.radius': 45 } },
          txt('fl-cta-label', 'button label', 'cta', g(0, 22, 300, 46), 'Get tickets', { size: 36, weight: 700, fill: '#FFFFFF', align: 'center' }),
        ] },
        txt('fl-lorem', 'placeholder copy', 'body', g(80, 1000.5, 600, 40), 'Lorem ipsum dolor sit amet', { size: 24, fill: tok('muted') }),
        txt('fl-legal', 'legal line', 'legal', g(80, 1098, 920, 24), '© 2026 City Events. Terms apply.', { size: 18, fill: tok('muted'), props: { 'policy.from': 'template' } }),
        { id: 'fl-footer', kind: 'frame', props: { name: 'sponsor bar', ...g(0, 1150, 1080, 200), 'style.fill': tok('ink'), 'frame.clip': true }, children: [
          img('fl-sp1', 'sponsor logo 1', 'logo', g(120.4, 50.2, 200, 100), 'as_logo_city'),
          img('fl-sp2', 'sponsor logo 2', 'logo', g(440.1, 62.85, 200, 100), 'as_logo_brew'),
          img('fl-sp3', 'sponsor logo 3', 'logo', g(760.7, 43.6, 200, 100), 'as_logo_radio'),
        ] },
      ],
    }],
  };
}

export function deckSeed() {
  const W = 1920, H = 1080;
  const logo = (s, x = 1700.3, y = 60.1) => img(`dk-${s}-logo`, `logo slide ${s}`, 'logo', g(x, y, 160, 60), 'as_logo_flux');
  const page = (s, name, children) => ({ id: `dk-s${s}`, kind: 'page', props: { name, 'spatial.w': W, 'spatial.h': H, 'style.fill': tok('light') }, children });
  const title = (s, text, size, y = 120) => txt(`dk-${s}-title`, `title slide ${s}`, 'title', g(160, y, 1600, size * 1.3), text, { size, weight: 700, font: tok('display') });
  return {
    title: 'Q3 product update', kind: 'deck', tokens: BRAND,
    assets: { as_logo_flux: { kind: 'image' }, as_shot_a: { kind: 'image' }, as_shot_b: { kind: 'image' }, as_chart: { kind: 'image' }, as_ana: { kind: 'image' }, as_ben: { kind: 'image' }, as_chen: { kind: 'image' } },
    pages: [
      page(1, 'Cover', [
        txt('dk-1-title', 'title slide 1', 'title', g(160, 380.4, 1600, 160), 'Q3 Product Update', { size: 120, weight: 800, font: tok('display'), fill: tok('primary') }),
        txt('dk-1-sub', 'subtitle slide 1', 'subhead', g(171.6, 597.3, 1200, 64), 'Flux team · October 2026', { size: 48 }),
        logo(1),
      ]),
      page(2, 'Agenda', [
        title(2, 'Agenda', 72),
        { id: 'dk-2-list', kind: 'group', props: { name: 'agenda list', ...g(160, 300, 1200, 320) }, children: [
          txt('dk-2-b1', 'agenda item Highlights', 'bullet', g(0, 0, 1200, 56), 'Highlights', { size: 44 }),
          txt('dk-2-b2', 'agenda item Metrics', 'bullet', g(0, 80, 1200, 56), 'Metrics', { size: 44 }),
          txt('dk-2-b3', 'agenda item Pricing', 'bullet', g(0, 160, 1200, 56), 'Pricing', { size: 44 }),
          txt('dk-2-b4', 'agenda item Next steps', 'bullet', g(0, 240, 1200, 56), 'Next steps', { size: 44 }),
        ] },
        logo(2),
      ]),
      page(3, 'New editor', [
        title(3, 'New editor', 64),
        img('dk-3-shot-a', 'screenshot A', 'photo', g(160, 320.2, 760, 480), 'as_shot_a', { 'style.radius': 16 }),
        img('dk-3-shot-b', 'screenshot B', 'photo', g(1000, 352.9, 760, 480), 'as_shot_b', { 'style.radius': 16 }),
        logo(3, 1690.5, 978.2),
      ]),
      page(4, 'Q3 metrics', [
        title(4, 'Q3 metrics', 72),
        txt('dk-4-body', 'metrics body', 'body', g(160, 300, 700, 200), 'Revenue up 32% in Q3. Weekly active teams doubled.', { size: 40, lineHeight: 1.4 }),
        img('dk-4-chart', 'revenue chart', 'chart', g(1000.4, 300.6, 700, 500), 'as_chart'),
        txt('dk-4-notes', 'todo note', 'notes', g(160, 900, 700, 48), 'TODO: add churn numbers', { size: 32, fill: tok('primary') }),
        logo(4),
      ]),
      page(5, 'Team', [
        title(5, 'Team', 80),
        img('dk-5-p1', 'photo Ana', 'photo', g(200.2, 340, 400, 400), 'as_ana', { 'style.radius': 200 }),
        img('dk-5-p2', 'photo Ben', 'photo', g(690.7, 340, 400, 400), 'as_ben', { 'style.radius': 200 }),
        img('dk-5-p3', 'photo Chen', 'photo', g(1320.1, 340, 400, 400), 'as_chen', { 'style.radius': 200 }),
        logo(5),
      ]),
    ],
  };
}

export const BPM = 104; export const BEAT0 = 0.12;
export function beatTicks(durS) { const out = []; for (let k = 0; BEAT0 + k * 60 / BPM <= durS; k++) out.push(secToTicks(BEAT0 + k * 60 / BPM)); return out; }

export function reelSeed() {
  const T = secToTicks;
  const clip = (id, name, src, start, dur, inn) => ({ id, kind: 'video', props: { name, role: 'broll', 'source.asset': src, 'temporal.start': T(start), 'temporal.duration': T(dur), 'source.in': T(inn), 'source.out': T(inn + dur), ...g(0, 0, 1080, 1920) } });
  const cap = (id, name, start, dur, text) => ({ id, kind: 'text', props: { name, role: 'caption', 'temporal.start': T(start), 'temporal.duration': T(dur), ...g(90, 1500, 900, 160), 'text.size': 64, 'text.weight': 800, 'style.fill': '#FFFFFF', 'text.align': 'center' }, text });
  return {
    title: 'Night market reel', kind: 'reel', tokens: BRAND,
    assets: {
      as_city: { kind: 'video', dur: T(12) }, as_food: { kind: 'video', dur: T(9) }, as_stage: { kind: 'video', dur: T(8) },
      as_crowd: { kind: 'video', dur: T(7) }, as_night: { kind: 'video', dur: T(6) },
      as_track: { kind: 'audio', dur: T(32), beats: beatTicks(32) }, as_logo_market: { kind: 'image' },
    },
    pages: [{
      id: 'rl-page', kind: 'page', props: { name: 'Reel', 'spatial.w': 1080, 'spatial.h': 1920, 'temporal.duration': T(20), 'style.fill': '#000000' },
      children: [
        { id: 'rl-main', kind: 'track', props: { name: 'Main', 'track.kind': 'video' }, children: [
          clip('rl-c1', 'clip 1 city skyline', 'as_city', 0, 4.2, 3),
          clip('rl-c2', 'clip 2 food stalls', 'as_food', 4.2, 5.1, 1),
          clip('rl-c3', 'clip 3 live stage', 'as_stage', 9.3, 4.4, 0),
          clip('rl-c4', 'clip 4 crowd', 'as_crowd', 13.7, 3, 2),
          clip('rl-c5', 'clip 5 night lights', 'as_night', 16.7, 3.3, 0.5),
        ] },
        { id: 'rl-caps', kind: 'track', props: { name: 'Captions', 'track.kind': 'text' }, children: [
          cap('rl-t1', 'caption 1', 0.3, 2.2, 'Midsummer Night Market'),
          cap('rl-t2', 'caption 2', 4.4, 1.6, 'Teh best street food in town'),
          cap('rl-t3', 'caption 3', 9.5, 0.7, 'Live music all night'),
          cap('rl-t4', 'caption 4', 13.9, 0.6, 'Bring your crew'),
          cap('rl-t5', 'caption 5', 17, 1.6, 'Sat 14 Nov · Riverside'),
        ] },
        { id: 'rl-music', kind: 'track', props: { name: 'Music', 'track.kind': 'audio' }, children: [
          { id: 'rl-song', kind: 'audio', props: { name: 'song', role: 'music', 'source.asset': 'as_track', 'temporal.start': 0, 'temporal.duration': T(20), 'source.in': T(4), 'source.out': T(24), 'audio.volume': 0.8 } },
        ] },
        img('rl-logo', 'watermark', 'logo', g(860.5, 80.2, 160, 64), 'as_logo_market', { 'spatial.opacity': 0.8 }),
      ],
    }],
    flows: [flowSeed()],
  };
}

export function flowSeed() {
  const step = (id, name, cap, params) => ({ id, kind: 'step', props: { name, 'step.capability': cap, ...(params ? { 'step.params': params } : {}) } });
  const edge = (id, from, to) => ({ id, kind: 'edge', props: { 'edge.from': from, 'edge.to': to } });
  return {
    id: 'fw-captions', kind: 'flow', props: { name: 'Auto captions' },
    children: [
      step('fw-s1', 'transcribe', 'media/transcribe', { language: 'en' }),
      step('fw-s2', 'make captions', 'captions/generate', { maxChars: 32 }),
      step('fw-s3', 'style', 'captions/style', { preset: 'bold-pop' }),
      step('fw-s4', 'attach', 'timeline/attach'),
      step('fw-s5', 'export', 'export/mp4', { size: '1080x1920' }),
      edge('fw-e1', 'fw-s1.words', 'fw-s2.words'),
      edge('fw-e2', 'fw-s2.captions', 'fw-s3.captions'),
      edge('fw-e3', 'fw-s3.captions', 'fw-s4.captions'),
      edge('fw-e4', 'fw-s4.video', 'fw-s5.video'),
    ],
  };
}

/** A 200-element page (20 cards × 9 nodes + 20 loose labels) with realistic float geometry, for the budget. */
export function bigPageSeed(seed = 7, cards = 20) {
  const r = prng(seed); const f = (a, b) => a + r() * (b - a);
  const children = [];
  for (let i = 0; i < cards; i++) {
    const cx = 40 + (i % 5) * 380 + f(-0.5, 0.5), cy = 40 + Math.floor(i / 5) * 520 + f(-0.5, 0.5);
    children.push({ id: `bp-card${i}`, kind: 'frame', props: { name: `card ${i}`, ...g(cx, cy, 360, 500), 'style.fill': tok('light'), 'style.radius': 16, 'frame.clip': true }, children: [
      { id: `bp-card${i}-bg`, kind: 'rect', props: { name: 'card bg', ...g(0, 0, 360, 500), 'style.fill': '#FFFFFF', 'style.stroke': tok('muted'), 'style.strokeWidth': 1 } },
      img(`bp-card${i}-img`, 'card image', 'photo', g(f(8, 12), f(8, 12), 340, 220), 'as_img' + (i % 7), { 'image.fit': 'cover' }),
      txt(`bp-card${i}-title`, 'card title', 'headline', g(16, f(240, 244), 328, 48), `Product ${i} — limited edition`, { size: 28, weight: 700 }),
      txt(`bp-card${i}-body`, 'card body', 'body', g(16, f(296, 300), 328, 96), 'Hand-made, small batch. Ships in 3 days. Free returns within 30 days.', { size: 18, lineHeight: 1.4, fill: tok('muted') }),
      { id: `bp-card${i}-dot`, kind: 'ellipse', props: { name: 'status dot', ...g(f(316, 320), 16, 24, 24), 'style.fill': tok('accent') } },
      { id: `bp-card${i}-btn`, kind: 'group', props: { name: 'buy button', role: 'cta', ...g(16, f(420, 424), 160, 56) }, children: [
        { id: `bp-card${i}-btn-bg`, kind: 'rect', props: { name: 'button shape', ...g(0, 0, 160, 56), 'style.fill': tok('primary'), 'style.radius': 28 } },
        txt(`bp-card${i}-btn-t`, 'button label', 'cta', g(0, 12, 160, 32), `$${(19 + i * 3).toFixed(2)}`, { size: 24, weight: 700, fill: '#FFFFFF', align: 'center' }),
      ] },
    ] });
  }
  for (let i = 0; i < 200 - cards * 9; i++) children.push(txt(`bp-label${i}`, 'label', 'body', g(f(0, 1900), f(2100, 2400), 200, 30), `Label ${i}`, { size: 20 }));
  return { title: 'Big page', kind: 'catalog', tokens: BRAND, assets: {}, pages: [{ id: 'bp-page', kind: 'page', props: { name: 'Catalog', 'spatial.w': 1960, 'spatial.h': 2500, 'style.fill': tok('cream') }, children }] };
}

export const SEEDS = { flyer: flyerSeed, deck: deckSeed, reel: reelSeed, big: bigPageSeed };
