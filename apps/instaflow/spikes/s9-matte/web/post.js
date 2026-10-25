// Shared post-processing: model-res output -> frame-res alpha in [0,1].

/** Bilinear upsample (+ optional sigmoid or min-max normalisation) of a model-res plane to dw x dh Float32. */
export function upsample(src, sw, sh, dw, dh, sigmoid, minmax) {
  let lo = 0, hi = 1;
  if (minmax) { lo = Infinity; hi = -Infinity; for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; } }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  const a = new Float32Array(sw * sh);
  for (let i = 0; i < a.length; i++) { const v = src[i]; a[i] = sigmoid ? 1 / (1 + Math.exp(-v)) : (v - lo) * k; }
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(sh - 1, fy | 0), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(sw - 1, fx | 0), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const top = a[y0 * sw + x0] * (1 - wx) + a[y0 * sw + x1] * wx;
      const bot = a[y1 * sw + x0] * (1 - wx) + a[y1 * sw + x1] * wx;
      out[y * dw + x] = top * (1 - wy) + bot * wy;
    }
  }
  return out;
}

export function toU8(f) { const u = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.round(f[i] * 255); u[i] = v < 0 ? 0 : v > 255 ? 255 : v; } return u; }
