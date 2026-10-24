// Temporal matte stabilisation (CPU reference; M1 port = WGSL compute shader).
//   1. guided filter (He et al. 2010) with the frame luma as guide → edges snap to colour edges.
//   2. motion-gated EMA: per-pixel blend weight k = ema + (1-ema) * clamp(max(|ΔRGB|max_box / motion, |Δα| / jump), 0, 1)
//      → static pixels average over time (kills flicker), moving pixels follow the new matte (no ghosting).
//      The colour gate alone ghosts where fg/bg have similar colour (skin vs beige wall), hence the α-jump term.
// State kept between frames: previous luma and previous EMA alpha.

/** O(N) separable box mean with clamped borders. src/dst Float32Array(w*h); tmp scratch. */
export function boxMean(src, dst, tmp, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * inv;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = s * inv;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}

/** Guided filter: refine p (alpha) using guide I. Returns new Float32Array clamped to [0,1]. */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, F = () => new Float32Array(n);
  const tmp = F(), mI = F(), mP = F(), cII = F(), cIP = F(), II = F(), IP = F();
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; IP[i] = I[i] * p[i]; }
  boxMean(I, mI, tmp, w, h, r); boxMean(p, mP, tmp, w, h, r);
  boxMean(II, cII, tmp, w, h, r); boxMean(IP, cIP, tmp, w, h, r);
  const a = II, b = IP; // reuse buffers
  for (let i = 0; i < n; i++) {
    const varI = cII[i] - mI[i] * mI[i], cov = cIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps); b[i] = mP[i] - a[i] * mI[i];
  }
  boxMean(a, mI, tmp, w, h, r); boxMean(b, mP, tmp, w, h, r);
  const q = F();
  for (let i = 0; i < n; i++) { const v = mI[i] * I[i] + mP[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
}

export function lumaOf(rgba, n) {
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
  return Y;
}

/**
 * Order: guided filter first (edge refinement against the colour frame), THEN motion-gated EMA, so the
 * per-frame sensor noise that the guide re-injects into edges is also averaged out. State = previous output.
 * step(raw, rgba, {ema=0.3, motion=0.04, jump=0.5, motionR=2, gfR=6, gfEps=1e-3, guided=true})
 *   -> { out (GF+EMA), emaOnly (EMA on the raw matte, no GF) }
 */
export function createSmoother(w, h) {
  const n = w * h;
  let prevRgb = null, prevY = null, prevOut = null, prevEma = null;
  const d = new Float32Array(n), gate = new Float32Array(n), tmp = new Float32Array(n);
  const blend = (cur, prev, ema, jump) => {
    if (!prev || ema >= 1) return cur.slice();
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let g = gate[i]; const a = Math.abs(cur[i] - prev[i]) / jump; if (a > g) g = a;
      const k = ema + (1 - ema) * (g > 1 ? 1 : g); o[i] = k * cur[i] + (1 - k) * prev[i];
    }
    return o;
  };
  return {
    reset() { prevRgb = null; prevY = null; prevOut = null; prevEma = null; },
    step(raw, rgba, o) {
      const ema = o.ema ?? 0.3, motion = o.motion ?? 0.04;
      const Y = lumaOf(rgba, n);
      if (prevRgb) {
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const r = Math.abs(rgba[j] - prevRgb[j]), g = Math.abs(rgba[j + 1] - prevRgb[j + 1]), b = Math.abs(rgba[j + 2] - prevRgb[j + 2]);
          d[i] = (r > g ? (r > b ? r : b) : g > b ? g : b) / 255;
        }
        boxMean(d, gate, tmp, w, h, o.motionR ?? 2);
        for (let i = 0; i < n; i++) gate[i] /= motion;
      }
      const refined = o.guided === false ? raw : guidedFilter(Y, raw, w, h, o.gfR ?? 6, o.gfEps ?? 1e-3);
      const jump = o.jump ?? 0.5;
      const out = blend(refined, prevOut, ema, jump), emaOnly = blend(raw, prevEma, ema, jump);
      prevRgb = rgba.slice(); prevY = Y; prevOut = out; prevEma = emaOnly;
      return { out, emaOnly };
    },
  };
}
