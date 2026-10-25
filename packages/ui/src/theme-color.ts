/**
 * Color helpers for themes and color controls: parse `#rgb[a]`, `#rrggbb[aa]` and
 * `rgb()/rgba()` values, format hex, composite translucent colors, and compute WCAG 2.2
 * relative luminance and contrast ratios (SC 1.4.3 text ≥ 4.5:1, SC 1.4.11 UI ≥ 3:1).
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidColorError } from './errors.js';

/** sRGB color, channels 0–255, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

/** Parse a hex or `rgb()`/`rgba()` color. Other CSS colors (names, `oklch()`) are SF-UI-010. */
export function parseColor(value: string): Result<Rgba> {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex !== null) {
    let digits = (hex[1] as string).toLowerCase();
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const channel = (i: number): number => Number.parseInt(digits.slice(i, i + 2), 16);
    return ok({ r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? round(channel(6) / 255, 3) : 1 });
  }
  const rgb = RGB.exec(text);
  if (rgb !== null) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((c) => Number(c));
    const alphaText = rgb[4];
    const a = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
    const values = [r, g, b, a] as number[];
    if (values.every((n) => Number.isFinite(n)) && [r, g, b].every((c) => (c as number) <= 255) && a <= 1) {
      return ok({ r: r as number, g: g as number, b: b as number, a });
    }
  }
  return err(InvalidColorError({ message: `Not a supported color: "${value}".`, details: { value } }));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const hex2 = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** `#rrggbb` (or `#rrggbbaa` when not opaque). */
export function formatHex(color: Rgba): string {
  const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return color.a >= 1 ? base : `${base}${hex2(color.a * 255)}`;
}

/** Normalize user input to `#rrggbb[aa]` (accepts a missing `#` and 3/4-digit forms). */
export function normalizeHex(value: string): Result<string> {
  const text = value.trim();
  const withHash = text.startsWith('#') ? text : `#${text}`;
  if (!HEX.test(withHash)) return err(InvalidColorError({ message: `Not a hex color: "${value}".`, details: { value } }));
  const parsed = parseColor(withHash);
  return parsed.ok ? ok(formatHex(parsed.value)) : parsed;
}

/** Composite a translucent color over an opaque background (alpha blending in sRGB). */
export function compositeOver(color: Rgba, background: Rgba): Rgba {
  const a = color.a;
  return { r: color.r * a + background.r * (1 - a), g: color.g * a + background.g * (1 - a), b: color.b * a + background.b * (1 - a), a: 1 };
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(color: Rgba): number {
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * WCAG contrast ratio (1–21) of `foreground` on `background`. A translucent foreground is
 * composited over the background first; the background must be opaque (or is treated as such).
 */
export function contrastRatio(foreground: string | Rgba, background: string | Rgba): Result<number> {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : ok(foreground);
  if (!fg.ok) return fg;
  const bg = typeof background === 'string' ? parseColor(background) : ok(background);
  if (!bg.ok) return bg;
  const opaqueBg = { ...bg.value, a: 1 };
  const l1 = relativeLuminance(compositeOver(fg.value, opaqueBg));
  const l2 = relativeLuminance(opaqueBg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return ok(round((hi + 0.05) / (lo + 0.05), 2));
}
