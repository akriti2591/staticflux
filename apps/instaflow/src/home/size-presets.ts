/**
 * The New design dialog's `Presets ▾` menu (HOME-FILES §1.3), as data: social, print and screen sizes in px. Print
 * sizes are at 96 px per inch, the canvas unit (A4 = 210 × 297 mm = 794 × 1123 px).
 */
import type { DesignSize } from './index-record.js';

export interface SizePreset {
  readonly id: string;
  readonly label: string;
  readonly size: DesignSize;
}

export interface SizePresetGroup {
  readonly label: string;
  readonly presets: readonly SizePreset[];
}

const mm = (v: number): number => Math.round((v * 96) / 25.4);
const inch = (v: number): number => Math.round(v * 96);
const p = (id: string, label: string, width: number, height: number): SizePreset => Object.freeze({ id, label, size: Object.freeze({ width, height }) });

export const SIZE_PRESET_GROUPS: readonly SizePresetGroup[] = Object.freeze([
  {
    label: 'Social',
    presets: [
      p('instagram-post', 'Instagram post', 1080, 1350),
      p('instagram-square', 'Instagram square', 1080, 1080),
      p('instagram-story', 'Instagram story', 1080, 1920),
      p('reel-cover', 'Reel cover', 1080, 1920),
      p('facebook-post', 'Facebook post', 1200, 630),
      p('linkedin-post', 'LinkedIn post', 1200, 627),
      p('x-post', 'X post', 1600, 900),
      p('youtube-thumbnail', 'YouTube thumbnail', 1280, 720),
      p('pinterest-pin', 'Pinterest pin', 1000, 1500),
    ],
  },
  {
    label: 'Print',
    presets: [
      p('a3', 'A3', mm(297), mm(420)),
      p('a4', 'A4', mm(210), mm(297)),
      p('a5', 'A5', mm(148), mm(210)),
      p('a6', 'A6', mm(105), mm(148)),
      p('letter', 'Letter', inch(8.5), inch(11)),
      p('legal', 'Legal', inch(8.5), inch(14)),
      p('tabloid', 'Tabloid', inch(11), inch(17)),
      p('business-card', 'Business card', inch(3.5), inch(2)),
    ],
  },
  {
    label: 'Screen',
    presets: [
      p('hd', 'HD', 1920, 1080),
      p('4k', '4K', 3840, 2160),
      p('iphone', 'iPhone', 1179, 2556),
      p('ipad', 'iPad', 1640, 2360),
      p('desktop', 'Desktop', 1440, 1024),
    ],
  },
]);

/** A preset by id (the menu's value). */
export function sizePreset(id: string): SizePreset | undefined {
  for (const group of SIZE_PRESET_GROUPS) for (const preset of group.presets) if (preset.id === id) return preset;
  return undefined;
}
