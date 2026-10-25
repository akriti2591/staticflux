/**
 * The colour popover's fixed default palette for Clean Pop (STUDIO-UX-SPEC §4.2.5 `Palette` row): 24 colours, 6 × 4,
 * read row by row — neutrals (ink to white), then the warm Clean Pop brights (tangerine, sunflower, raspberry …), then
 * cool brights, then soft tints that sit behind text. Data only; the popover renders it as swatches named by hex.
 */
export const CLEAN_POP_COLOR_PALETTE: readonly string[] = Object.freeze([
  // Neutrals: ink → white
  '#16151A',
  '#56606C',
  '#7D8897',
  '#C3CCD7',
  '#F1F4F7',
  '#FFFFFF',
  // Warm brights
  '#CF3D17',
  '#FF5C39',
  '#F59E0B',
  '#FFC93C',
  '#D6265F',
  '#8B5CF6',
  // Cool brights
  '#2563EB',
  '#0EA5E9',
  '#14B8A6',
  '#16A34A',
  '#65A30D',
  '#1E3A8A',
  // Soft tints
  '#FFE9E2',
  '#FFF4E0',
  '#FDE8EF',
  '#EDE9FE',
  '#E0F2FE',
  '#DCFCE7',
]);
