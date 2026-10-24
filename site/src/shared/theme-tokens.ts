/**
 * The site's design tokens — ONE source for both sides:
 * - build time: rendered into critical inline CSS (so the first paint, and no-JS readers, get the theme);
 * - run time: turned into `@staticflux/shell` themes (`defineTheme`) for the ThemeController,
 *   which re-applies the `--sf-*` variables and sets `data-theme` on <html>.
 *
 * `tokens` follows shell's `DesignTokens` (CSS var `--sf-<kebab-name>`); `extras` are
 * site-only variables (`--site-*`) keyed by the theme id in CSS. Pure data, no imports.
 */

export interface SiteTheme {
  readonly id: 'site/light' | 'site/dark' | 'site/high-contrast';
  readonly scheme: 'light' | 'dark';
  readonly contrast: 'normal' | 'more';
  readonly tokens: {
    readonly colorBg: string;
    readonly colorFg: string;
    readonly colorSurface: string;
    readonly colorMuted: string;
    readonly colorBorder: string;
    readonly colorAccent: string;
    readonly colorAccentFg: string;
    readonly colorFocus: string;
    readonly colorDanger: string;
    readonly colorBackdrop: string;
    readonly colorSkeleton: string;
    readonly fontBody: string;
    readonly fontMono: string;
    readonly radius: string;
    readonly radiusSmall: string;
    readonly space1: string;
    readonly space2: string;
    readonly space3: string;
    readonly space4: string;
    readonly shadowOverlay: string;
    readonly motionDuration: string;
  };
  readonly extras: Readonly<Record<string, string>>;
}

const shared = {
  fontBody: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontMono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  radius: '14px',
  radiusSmall: '8px',
  space1: '4px',
  space2: '8px',
  space3: '16px',
  space4: '24px',
  motionDuration: '180ms',
} as const;

/** Code blocks are dark in every theme ("ink on paper" in light, a deeper well in dark). */
const syntax = {
  'code-fg': '#e7e3da',
  'code-muted': '#8f93a3',
  'tk-kw': '#ff9f73',
  'tk-str': '#b9e08f',
  'tk-com': '#878ca0',
  'tk-num': '#f4c97a',
  'tk-type': '#7fd6cf',
  'tk-fn': '#9ec1ff',
  'tk-pun': '#aeb2bf',
  'tk-lit': '#ff94a8',
  'tk-prop': '#7fd6cf',
  'tk-tag': '#ffab85',
  'tk-dec': '#d9a8ff',
} as const;

export const lightSiteTheme: SiteTheme = {
  id: 'site/light',
  scheme: 'light',
  contrast: 'normal',
  tokens: {
    ...shared,
    colorBg: '#f5f1ea',
    colorFg: '#17181c',
    colorSurface: '#fffdf9',
    colorMuted: '#575a64',
    colorBorder: '#ddd5c7',
    colorAccent: '#b93d0a',
    colorAccentFg: '#ffffff',
    colorFocus: '#1d4ed8',
    colorDanger: '#b42318',
    colorBackdrop: 'rgba(23, 24, 28, 0.45)',
    colorSkeleton: 'rgba(23, 24, 28, 0.08)',
    shadowOverlay: '0 18px 50px -20px rgba(41, 30, 15, 0.35)',
  },
  extras: {
    ...syntax,
    'font-display': '"Fraunces", "Iowan Old Style", Georgia, serif',
    flux: '#e8572a',
    'flux-2': '#0f766e',
    'flux-3': '#d6a419',
    'bg-2': '#ede7dc',
    'surface-2': '#f9f5ee',
    'border-strong': '#c9bfae',
    'code-bg': '#17191e',
    'code-border': '#17191e',
    'accent-soft': 'rgba(185, 61, 10, 0.09)',
    'teal-soft': 'rgba(15, 118, 110, 0.10)',
    'grid-line': 'rgba(23, 24, 28, 0.06)',
    'before-tint': 'rgba(87, 90, 100, 0.10)',
    'after-tint': 'rgba(185, 61, 10, 0.10)',
    glow: 'rgba(232, 87, 42, 0.18)',
    'card-shadow': '0 1px 0 rgba(255,255,255,0.7) inset, 0 12px 30px -18px rgba(41, 30, 15, 0.28)',
  },
};

export const darkSiteTheme: SiteTheme = {
  id: 'site/dark',
  scheme: 'dark',
  contrast: 'normal',
  tokens: {
    ...shared,
    colorBg: '#0d0f12',
    colorFg: '#ece8e1',
    colorSurface: '#15181d',
    colorMuted: '#a4a6b0',
    colorBorder: '#2a2e36',
    colorAccent: '#ff8a5b',
    colorAccentFg: '#1a0c05',
    colorFocus: '#8ab4ff',
    colorDanger: '#ff7b72',
    colorBackdrop: 'rgba(0, 0, 0, 0.6)',
    colorSkeleton: 'rgba(236, 232, 225, 0.08)',
    shadowOverlay: '0 18px 50px -20px rgba(0, 0, 0, 0.7)',
  },
  extras: {
    ...syntax,
    'font-display': '"Fraunces", "Iowan Old Style", Georgia, serif',
    flux: '#ff7a45',
    'flux-2': '#2dd4bf',
    'flux-3': '#f5c451',
    'bg-2': '#111419',
    'surface-2': '#1a1e24',
    'border-strong': '#3a3f49',
    'code-bg': '#0a0c0f',
    'code-border': '#262a31',
    'accent-soft': 'rgba(255, 138, 91, 0.12)',
    'teal-soft': 'rgba(45, 212, 191, 0.10)',
    'grid-line': 'rgba(236, 232, 225, 0.05)',
    'before-tint': 'rgba(164, 166, 176, 0.10)',
    'after-tint': 'rgba(255, 138, 91, 0.12)',
    glow: 'rgba(255, 122, 69, 0.22)',
    'card-shadow': '0 1px 0 rgba(255,255,255,0.04) inset, 0 16px 40px -24px rgba(0, 0, 0, 0.8)',
  },
};

export const highContrastSiteTheme: SiteTheme = {
  id: 'site/high-contrast',
  scheme: 'dark',
  contrast: 'more',
  tokens: {
    ...shared,
    colorBg: '#000000',
    colorFg: '#ffffff',
    colorSurface: '#000000',
    colorMuted: '#ffffff',
    colorBorder: '#ffffff',
    colorAccent: '#ffd400',
    colorAccentFg: '#000000',
    colorFocus: '#00e5ff',
    colorDanger: '#ff8080',
    colorBackdrop: 'rgba(0, 0, 0, 0.85)',
    colorSkeleton: 'rgba(255, 255, 255, 0.25)',
    shadowOverlay: '0 0 0 2px #ffffff',
    motionDuration: '0ms',
  },
  extras: {
    ...syntax,
    'code-fg': '#ffffff',
    'tk-com': '#c8c8c8',
    'font-display': '"Fraunces", Georgia, serif',
    flux: '#ffd400',
    'flux-2': '#00e5ff',
    'flux-3': '#ffffff',
    'bg-2': '#000000',
    'surface-2': '#000000',
    'border-strong': '#ffffff',
    'code-bg': '#000000',
    'code-border': '#ffffff',
    'accent-soft': 'transparent',
    'teal-soft': 'transparent',
    'grid-line': 'transparent',
    'before-tint': 'transparent',
    'after-tint': 'transparent',
    glow: 'transparent',
    'card-shadow': 'none',
  },
};

export const SITE_THEMES = [lightSiteTheme, darkSiteTheme, highContrastSiteTheme] as const;

/** Same mapping as shell's `tokenVar`: `colorBg` → `--sf-color-bg`, `space1` → `--sf-space-1`. */
export function sfVar(name: string): string {
  return `--sf-${name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`;
}

function declarations(theme: SiteTheme): string {
  const tokens = Object.entries(theme.tokens).map(([k, v]) => `${sfVar(k)}:${v}`);
  const extras = Object.entries(theme.extras).map(([k, v]) => `--site-${k}:${v}`);
  return `color-scheme:${theme.scheme};${[...tokens, ...extras].join(';')}`;
}

/** Critical theme CSS: system preference before JS, explicit `data-theme` after the pre-paint script / ThemeController. */
export function themeCss(): string {
  const [light, dark, hc] = SITE_THEMES;
  return [
    `:root{${declarations(light)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme]){${declarations(dark)}}}`,
    `@media (prefers-contrast: more),(forced-colors: active){:root:not([data-theme]){${declarations(hc)}}}`,
    `:root[data-theme="site/light"]{${declarations(light)}}`,
    `:root[data-theme="site/dark"]{${declarations(dark)}}`,
    `:root[data-theme="site/high-contrast"]{${declarations(hc)}}`,
  ].join('\n');
}
