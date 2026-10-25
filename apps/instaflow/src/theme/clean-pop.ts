/**
 * **Clean Pop**, the Instaflow theme (approved design: `docs/instaflow/design/README.md`,
 * recipes in `Components.dc.html`). It fills the StaticFlux theme contract through
 * `extendTheme(defaultTheme, …)`, so every kit component picks it up:
 *
 * - cool **mist** neutrals (page `#F1F4F7`, tint `#E7ECF2`, hairline `#DCE3EA`, control edge `#7D8897`, ink `#16151A`);
 * - **deep tangerine** `#CF3D17` primary (white text 4.85:1) and focus ring;
 * - **raspberry** agent actions `#D6265F` (white text 4.88:1), soft `#FDE8EF` with `#B3174C` ink;
 * - **pill** controls (`radius.control`), 18 px cards (`radius.lg`), 12 px fields and previews (`radius.md`);
 * - Bricolage Grotesque (display), Geist (UI, body), Geist Mono (values, codes, tokens);
 * - buttons 42 / 34 / 28 px high (`size.controlLg | control | controlSm`, standard density), padded
 *   20 / 14 / 12 px (`size.controlPad*`), 15 / 13.5 / 12.5 px text (`type.control*`);
 * - switchers: a borderless tint track with a white selected pill (kit segmented).
 *
 * Lens colours and shapes are not theme tokens: see `./lenses.ts`.
 *
 * TODO(DS2 · Clean Pop dark): the dark scheme is deferred. Until then the dark variant
 * repeats the light palette, so a dark system preference still shows Clean Pop (never the
 * neutral default's dark look); the theme contract checks it like any other variant.
 */
import { defaultTheme } from '@staticflux/ui/default-theme';
import { extendTheme, type PartialThemeValues, themeContribution, type ThemeDef } from '@staticflux/ui/theme';

/** The Clean Pop colours by their design names (README "Colour"). */
export const cleanPopPalette = Object.freeze({
  page: '#F1F4F7',
  /** The editor stage behind artboards (dotted canvas); not a surface for controls (the control edge is 2.95:1 on it). */
  stage: '#E4E9EF',
  tint: '#E7ECF2',
  hairline: '#DCE3EA',
  controlEdge: '#7D8897',
  sliderTrack: '#C3CCD7',
  muted: '#56606C',
  ink: '#16151A',
  white: '#FFFFFF',
  primary: '#CF3D17',
  primaryHover: '#B8350F',
  primaryActive: '#A32E0C',
  agent: '#D6265F',
  agentHover: '#BC1F52',
  agentSoft: '#FDE8EF',
  agentInk: '#B3174C',
  /** Saved / success dot (non-text, 3.24:1 on white); text uses `successText`. */
  success: '#00A372',
  successSubtle: '#E0F5EC',
  successText: '#00704F',
});

const p = cleanPopPalette;

const colors = {
  neutral1: '#F7F9FB',
  neutral2: p.page,
  neutral3: p.tint,
  neutral4: p.stage,
  neutral5: p.hairline,
  neutral6: '#D0D8E1',
  neutral7: p.sliderTrack,
  neutral8: p.controlEdge,
  neutral9: '#6A7584',
  neutral10: '#5F6977',
  neutral11: p.muted,
  neutral12: p.ink,
  canvas: p.page,
  surface1: p.white,
  surface2: p.white,
  surface3: p.white,
  surfaceSunken: p.white,
  surfaceHover: p.page,
  surfaceActive: p.tint,
  surfaceSelected: '#FFEDE6',
  text: p.ink,
  textMuted: p.muted,
  textSubtle: p.controlEdge,
  textDisabled: '#A3ACB8',
  textOnAccent: p.white,
  border: p.hairline,
  borderStrong: p.controlEdge,
  controlEdge: p.controlEdge,
  accent: p.primary,
  accentHover: p.primaryHover,
  accentActive: p.primaryActive,
  accentSubtle: '#FFEDE6',
  accentText: p.primaryHover,
  agent: p.agent,
  agentHover: p.agentHover,
  onAgent: p.white,
  agentSoft: p.agentSoft,
  agentInk: p.agentInk,
  success: p.success,
  successSubtle: p.successSubtle,
  successText: p.successText,
  focusRing: p.primary,
  backdrop: 'rgba(22, 21, 26, 0.32)',
  skeleton: 'rgba(22, 21, 26, 0.07)',
} as const;

const shadows = {
  level1: '0 1px 2px rgba(22, 21, 26, 0.14)',
  level2: '0 6px 18px rgba(22, 21, 26, 0.10)',
  level3: '0 16px 40px rgba(22, 21, 26, 0.18)',
} as const;

/** `prefers-contrast: more`: darker ink, edges and accent text; the ring stays tangerine. */
const moreContrast: PartialThemeValues = {
  color: {
    text: '#000000',
    textMuted: '#2E343C',
    textSubtle: '#4E5865',
    border: '#5F6977',
    borderStrong: '#3D4450',
    controlEdge: '#3D4450',
    focusRing: '#A32E0C',
    accentText: '#8F280A',
    agentInk: '#8E1039',
  },
};

export const cleanPopTheme: ThemeDef = /* @__PURE__ */ extendTheme(defaultTheme, {
  id: 'instaflow/clean-pop',
  label: 'Clean Pop',
  values: {
    color: colors,
    font: {
      family: '"Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      familyMono: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace',
      familyDisplay: '"Bricolage Grotesque", "Geist", system-ui, sans-serif',
      weightRegular: '400',
      weightMedium: '600',
      weightSemibold: '600',
      weightDisplay: '800',
    },
    type: { controlSm: '12.5px', control: '13.5px', controlLg: '15px', sizeXs: '11px', sizeSm: '12.5px', sizeMd: '13.5px', sizeLg: '15px', sizeXl: '22px', size2xl: '40px', lineTight: '1.2', lineNormal: '1.45' },
    // Rows 30 / Focus 32 / Pro 26 and UI text 14 / 13.5 / 12 px per mode (DENSITY-DISCLOSURE §6).
    size: { controlSm: '28px', control: '34px', controlLg: '42px', controlPadSm: '12px', controlPad: '14px', controlPadLg: '20px', row: '30px', toolbar: '48px', icon: '16px', railWidth: '48px' },
    radius: { sm: '8px', md: '12px', lg: '18px', full: '9999px', control: '9999px' },
    shadow: shadows,
  },
  // TODO(DS2 · Clean Pop dark): replace with the Clean Pop dark palette.
  dark: { color: { ...defaultTheme.values.color, ...colors }, shadow: shadows },
  contrast: { light: moreContrast, dark: moreContrast },
  density: {
    focus: {
      type: { sizeMd: '14px' },
      space: { xs: '4px', sm: '8px', md: '16px', lg: '20px', xl: '24px', xxl: '32px' },
      size: { controlSm: '32px', control: '38px', controlLg: '46px', controlPadSm: '14px', controlPad: '16px', controlPadLg: '22px', row: '32px', toolbar: '52px', icon: '18px', railWidth: '52px' },
    },
    pro: {
      type: { sizeMd: '12px', sizeSm: '12px' },
      // §6 asks 6 / 10 px gaps in Pro; the theme contract keeps spacing on the 4 px grid, so 4 / 8.
      space: { xs: '4px', sm: '4px', md: '8px', lg: '12px', xl: '16px', xxl: '24px' },
      size: { controlSm: '24px', control: '28px', controlLg: '34px', controlPadSm: '10px', controlPad: '12px', controlPadLg: '16px', row: '26px', toolbar: '40px', icon: '16px', railWidth: '40px' },
    },
  },
});

/** DI: contribute Clean Pop above the default theme (order 0 > −100), so it is the active theme. */
export const cleanPopThemeContribution = /* @__PURE__ */ themeContribution(cleanPopTheme, { order: 0 });
