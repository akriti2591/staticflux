// Synthetic 720p test footage: a stylised person (head, hair strands, torso, arms) over a procedural "room".
// Everything is generated locally (no third-party media). The person is drawn on its own layer, so its
// alpha channel is the exact ground-truth matte (including anti-aliased hair strands).

export const W = 1280, H = 720;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function drawRoom(ctx, t, bgMotion) {
  const r = rng(7);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#c9b9a6'); g.addColorStop(1, '#8f7f70');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // window with daylight
  const wg = ctx.createLinearGradient(880, 60, 1220, 420);
  wg.addColorStop(0, '#f4f8ff'); wg.addColorStop(1, '#b8d4f0');
  ctx.fillStyle = wg; ctx.fillRect(880, 60, 340, 360);
  ctx.strokeStyle = '#efe8dc'; ctx.lineWidth = 14; ctx.strokeRect(880, 60, 340, 360);
  ctx.beginPath(); ctx.moveTo(1050, 60); ctx.lineTo(1050, 420); ctx.moveTo(880, 240); ctx.lineTo(1220, 240); ctx.stroke();
  // bookshelf
  ctx.fillStyle = '#5b3d2a'; ctx.fillRect(40, 120, 300, 520);
  for (let s = 0; s < 4; s++) {
    let x = 52; const y = 135 + s * 128;
    while (x < 325) { const bw = 12 + r() * 22, bh = 70 + r() * 45; ctx.fillStyle = `hsl(${r() * 360},${35 + r() * 30}%,${30 + r() * 30}%)`; ctx.fillRect(x, y + 115 - bh, bw, bh); x += bw + 2; }
    ctx.fillStyle = '#4a3020'; ctx.fillRect(40, y + 115, 300, 10);
  }
  // plant (leafy, high-frequency background edges)
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `hsl(${100 + r() * 40},45%,${22 + r() * 25}%)`;
    ctx.beginPath(); ctx.ellipse(1120 + (r() - 0.5) * 180, 520 + (r() - 0.5) * 160, 10 + r() * 22, 5 + r() * 9, r() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#7a4b33'; ctx.fillRect(1070, 600, 100, 120);
  // floor
  ctx.fillStyle = '#6d5a4a'; ctx.fillRect(0, 650, W, 70);
  // moving background content (a blurred passer-by + drifting bokeh) for the bg-motion sequence
  if (bgMotion) {
    ctx.save(); ctx.filter = 'blur(8px)';
    const px = ((t * 23) % (W + 300)) - 150;
    ctx.fillStyle = '#3b4a63'; ctx.beginPath(); ctx.ellipse(px, 420, 70, 200, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d8b49a'; ctx.beginPath(); ctx.arc(px, 200, 45, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `rgba(255,240,200,${0.25 + 0.2 * Math.sin(t * 0.3 + i)})`;
      ctx.beginPath(); ctx.arc((i * 137 + t * 9) % W, 80 + (i * 53) % 300, 18 + (i % 4) * 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

function drawPerson(ctx, cx, cy, sway) {
  const r = rng(42);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(sway * 0.03);
  // torso + shoulders (shirt)
  const sg = ctx.createLinearGradient(-230, 0, 230, 0);
  sg.addColorStop(0, '#1f3f66'); sg.addColorStop(0.5, '#2f5d91'); sg.addColorStop(1, '#1b3556');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.moveTo(-60, 40); ctx.bezierCurveTo(-170, 50, -230, 90, -245, 200); ctx.lineTo(-260, 420);
  ctx.lineTo(260, 420); ctx.lineTo(245, 200); ctx.bezierCurveTo(230, 90, 170, 50, 60, 40); ctx.closePath(); ctx.fill();
  // arms
  ctx.beginPath(); ctx.moveTo(-245, 200); ctx.quadraticCurveTo(-300 - sway * 10, 320, -280, 420); ctx.lineTo(-215, 420); ctx.quadraticCurveTo(-225, 300, -200, 230); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(245, 200); ctx.quadraticCurveTo(300 + sway * 10, 320, 280, 420); ctx.lineTo(215, 420); ctx.quadraticCurveTo(225, 300, 200, 230); ctx.closePath(); ctx.fill();
  // collar shadow + neck
  ctx.fillStyle = '#c99a7c'; ctx.beginPath(); ctx.moveTo(-40, -30); ctx.lineTo(40, -30); ctx.lineTo(55, 50); ctx.quadraticCurveTo(0, 85, -55, 50); ctx.closePath(); ctx.fill();
  // head
  const hg = ctx.createRadialGradient(-20, -130, 10, 0, -110, 110);
  hg.addColorStop(0, '#f0c8a8'); hg.addColorStop(1, '#c08a68');
  ctx.fillStyle = hg; ctx.beginPath(); ctx.ellipse(0, -115, 78, 98, 0, 0, Math.PI * 2); ctx.fill();
  // ears
  ctx.fillStyle = '#c89474';
  ctx.beginPath(); ctx.ellipse(-78, -110, 12, 22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(78, -110, 12, 22, 0, 0, Math.PI * 2); ctx.fill();
  // face features
  ctx.fillStyle = '#2b1d16';
  ctx.beginPath(); ctx.ellipse(-28, -120, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(28, -120, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#3a2418'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(-42, -140); ctx.lineTo(-14, -143); ctx.moveTo(14, -143); ctx.lineTo(42, -140); ctx.stroke();
  ctx.strokeStyle = '#9b5a4a'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, -75, 22, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
  ctx.strokeStyle = '#a8765a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -115); ctx.lineTo(-6, -92); ctx.lineTo(4, -90); ctx.stroke();
  // hair mass
  ctx.fillStyle = '#2a1a12';
  ctx.beginPath(); ctx.ellipse(0, -170, 90, 62, 0, Math.PI, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-70, -140, 26, 55, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(70, -140, 26, 55, -0.2, 0, Math.PI * 2); ctx.fill();
  // fine hair strands (sub-pixel detail -> soft alpha edge, the hard part of matting)
  for (let i = 0; i < 420; i++) {
    const a = Math.PI * (1.02 + r() * 0.96);
    const x0 = Math.cos(a) * 82, y0 = -165 + Math.sin(a) * 58;
    const len = 18 + r() * 42, bend = (r() - 0.5) * 30;
    ctx.strokeStyle = `rgba(${40 + r() * 30},${25 + r() * 20},${15 + r() * 10},${0.5 + r() * 0.5})`;
    ctx.lineWidth = 0.6 + r() * 1.2;
    ctx.beginPath(); ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0 + Math.cos(a) * len * 0.5 + bend, y0 + Math.sin(a) * len * 0.5, x0 + Math.cos(a) * len + bend * 0.5 + sway * 2, y0 + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
}

/** Sequence definitions. t = frame index. */
export const SEQUENCES = {
  static:   { personX: () => 600, bgMotion: false, noise: 6, desc: 'static subject + static bg; per-frame sensor noise only' },
  bgmotion: { personX: () => 600, bgMotion: true,  noise: 6, desc: 'static subject; moving blurred passer-by + bokeh behind' },
  moving:   { personX: (t) => 600 + 140 * Math.sin((2 * Math.PI * t) / 24), sway: (t) => Math.sin((2 * Math.PI * t) / 24), bgMotion: false, noise: 6, desc: 'subject sways ±140 px (up to ~37 px/frame)' },
};

/**
 * Render frame t of a sequence. Returns { bitmap (ImageBitmap, transferable), gt (Uint8Array alpha, W*H) }.
 */
export async function renderFrame(seqName, t) {
  const seq = SEQUENCES[seqName];
  const person = new OffscreenCanvas(W, H), pctx = person.getContext('2d', { willReadFrequently: true });
  drawPerson(pctx, seq.personX(t), 330, seq.sway ? seq.sway(t) : 0);
  const pd = pctx.getImageData(0, 0, W, H).data;
  const gt = new Uint8Array(W * H);
  for (let i = 0; i < gt.length; i++) gt[i] = pd[i * 4 + 3];
  const frame = new OffscreenCanvas(W, H), fctx = frame.getContext('2d', { willReadFrequently: true });
  drawRoom(fctx, t, seq.bgMotion);
  fctx.drawImage(person, 0, 0);
  // sensor noise, different every frame (deterministic per t)
  const img = fctx.getImageData(0, 0, W, H), d = img.data, r = rng(1000 + t), amp = seq.noise;
  for (let i = 0; i < d.length; i += 4) { const n = (r() + r() - 1) * amp; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  fctx.putImageData(img, 0, 0);
  return { bitmap: await createImageBitmap(frame), gt };
}
