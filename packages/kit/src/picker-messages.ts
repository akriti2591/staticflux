/**
 * Strings of the colour popover, the font picker and the alignment popover (`kit-pickers` catalog). Kit strings stay
 * American like the rest of the kit; Instaflow translates (`colour`, `centre`) through `defineTranslations`.
 */
import { defineMessages } from '@staticflux/i18n';

export const pickerMessages = /* @__PURE__ */ defineMessages('kit-pickers', {
  hex: 'Hex',
  opacity: 'Opacity',
  eyedropper: 'Pick a color from the screen',
  documentColors: 'Document colors',
  brandColors: 'Brand',
  paletteColors: 'Palette',
  recentColors: 'Recent',
  customColor: 'Custom',
  detachToken: 'Detach from token',
  replaceWith: 'Replace with {hex}',
  hue: 'Hue',
  saturation: 'Saturation and brightness',
  searchFonts: 'Search fonts',
  fontsRecent: 'Recent',
  fontsInDesign: 'In this design',
  fontsAll: 'All',
  noFonts: 'No fonts match',
  notDownloaded: 'Not downloaded yet',
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',
  alignTop: 'Align top',
  alignMiddle: 'Align middle',
  alignBottom: 'Align bottom',
  distributeHorizontal: 'Distribute horizontally',
  distributeVertical: 'Distribute vertically',
  tidyUp: 'Tidy up',
  distribute: 'Distribute',
  align: 'Align',
  alignTo: 'Align to',
  alignToSelection: 'Selection',
  alignToPage: 'Page',
});
