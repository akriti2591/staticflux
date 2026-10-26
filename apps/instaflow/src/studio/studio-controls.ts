/**
 * Studio's controls per selection kind (B11b, IF-36.7–36.9): the one control model (`../spec/controls.ts`) filled in
 * for STUDIO-UX-SPEC §4.2.4 (the pill: ≤ 6 ranked controls, then `⋯`), TEXT-FONTS §4.1 and APPEARANCE §2.10 / §3.6 /
 * §4.10 (HUD ranks). The HUD pill (`hud.ts`) renders `hudControls(set)` and the More menu; the inspector renders the
 * same controls by section. Data only: the views live with the HUD and inspector, keyed by control id.
 *
 * Kinds come from the editor's selection summary (`../app/scene-summary.ts`); `CONTROL_SETS[kind]` is a lookup, never
 * a branch on the kind (rule 4).
 */
import type { AnyCapability } from '@staticflux/capabilities';
import { alignStartVerticalIcon } from '@staticflux/kit/icons/align-start-vertical';
import { alignHorizontalSpaceAroundIcon } from '@staticflux/kit/icons/align-horizontal-space-around';
import { boldIcon } from '@staticflux/kit/icons/bold';
import { booleanUnionIcon } from '@staticflux/kit/icons/boolean-union';
import { copyIcon } from '@staticflux/kit/icons/copy';
import { frameIcon } from '@staticflux/kit/icons/frame';
import { groupIcon } from '@staticflux/kit/icons/group';
import { lockOpenIcon } from '@staticflux/kit/icons/lock-open';
import { maskIcon } from '@staticflux/kit/icons/mask';
import { trash2Icon } from '@staticflux/kit/icons/trash-2';
import { ungroupIcon } from '@staticflux/kit/icons/ungroup';
import { layoutGridIcon } from '@staticflux/kit/icons/layout-grid';
import { splineIcon } from '@staticflux/kit/icons/spline';
import { type ControlDecl, type ControlSet, defineControls, type InspectorSection } from '../spec/controls.js';
import { elementCapabilities } from '../elements/capabilities.js';
import { repeatCapabilities } from '../repeat/capabilities.js';
import { DeleteCapability, DuplicateCapability, LockCapability } from '../app/studio-commands.js';
import type { SelectionKind } from '../app/scene-summary.js';

/** Inspector sections in their fixed order (STUDIO-UX-SPEC §5.1). */
export const SECTIONS = Object.freeze({
  page: { id: 'instaflow/section-page', label: 'Page', order: 0 },
  document: { id: 'instaflow/section-document', label: 'Document', order: 1 },
  transform: { id: 'instaflow/section-transform', label: 'Transform', order: 2 },
  text: { id: 'instaflow/section-text', label: 'Text', order: 3 },
  image: { id: 'instaflow/section-image', label: 'Image', order: 4 },
  frame: { id: 'instaflow/section-frame', label: 'Frame', order: 5 },
  repeat: { id: 'instaflow/section-repeat', label: 'Repeat', order: 6 },
  combine: { id: 'instaflow/section-combine', label: 'Combine', order: 7 },
  mask: { id: 'instaflow/section-mask', label: 'Mask', order: 8 },
  fill: { id: 'instaflow/section-fill', label: 'Fill', order: 10 },
  stroke: { id: 'instaflow/section-stroke', label: 'Stroke', order: 11 },
  corners: { id: 'instaflow/section-corners', label: 'Corners', order: 12 },
  effects: { id: 'instaflow/section-effects', label: 'Effects', order: 13 },
  layer: { id: 'instaflow/section-layer', label: 'Layer', order: 14 },
  arrange: { id: 'instaflow/section-arrange', label: 'Arrange', order: 20 },
} satisfies Record<string, InspectorSection>);

/** Control ids (typed values; the HUD's and inspector's view tables are keyed by them). */
export const CONTROL = Object.freeze({
  fill: 'instaflow/control-fill',
  stroke: 'instaflow/control-stroke',
  radius: 'instaflow/control-radius',
  points: 'instaflow/control-points',
  strokeWidth: 'instaflow/control-stroke-width',
  font: 'instaflow/control-font',
  size: 'instaflow/control-size',
  textColor: 'instaflow/control-text-color',
  bold: 'instaflow/control-bold',
  align: 'instaflow/control-align',
  distribute: 'instaflow/control-distribute',
  fit: 'instaflow/control-fit',
  clip: 'instaflow/control-clip',
  combine: 'instaflow/control-combine',
  useAsMask: 'instaflow/control-use-as-mask',
  operation: 'instaflow/control-operation',
  maskMode: 'instaflow/control-mask-mode',
  maskInvert: 'instaflow/control-mask-invert',
  chip: 'instaflow/control-chip',
  repeatCount: 'instaflow/control-repeat-count',
  duplicate: 'instaflow/control-duplicate',
  delete: 'instaflow/control-delete',
  group: 'instaflow/control-group',
  ungroup: 'instaflow/control-ungroup',
  unlock: 'instaflow/control-unlock',
  repeatExpand: 'instaflow/control-repeat-expand',
  repeatRelease: 'instaflow/control-repeat-release',
  booleanRelease: 'instaflow/control-boolean-release',
  flatten: 'instaflow/control-flatten',
  maskRelease: 'instaflow/control-mask-release',
} as const);
export type ControlId = (typeof CONTROL)[keyof typeof CONTROL];

const CAPABILITIES: ReadonlyMap<string, AnyCapability> = new Map([...elementCapabilities, ...repeatCapabilities, DeleteCapability, DuplicateCapability, LockCapability].map((c) => [c.id as string, c as AnyCapability]));
/** A declared capability by id (the control sets name only capabilities that exist; a typo throws at load). */
function cap(id: string): AnyCapability {
  const found = CAPABILITIES.get(id);
  if (found === undefined) throw new Error(`Unknown capability ${id}`);
  return found;
}

type Decl = Omit<ControlDecl, 'order' | 'tier'> & Partial<Pick<ControlDecl, 'order' | 'tier'>>;
const c = (decl: Decl): ControlDecl => ({ order: 0, tier: 'essential', ...decl });

const fill = c({ id: CONTROL.fill, kind: 'swatch', label: 'Fill', section: SECTIONS.fill });
const stroke = c({ id: CONTROL.stroke, kind: 'swatch', label: 'Stroke', section: SECTIONS.stroke });
const radius = c({ id: CONTROL.radius, kind: 'number', label: 'Radius', section: SECTIONS.corners });
const points = c({ id: CONTROL.points, kind: 'number', label: 'Points', section: SECTIONS.corners, order: 1 });
const strokeWidth = c({ id: CONTROL.strokeWidth, kind: 'number', label: 'Stroke width', section: SECTIONS.stroke, order: 1 });
const font = c({ id: CONTROL.font, kind: 'font', label: 'Font', section: SECTIONS.text });
const size = c({ id: CONTROL.size, kind: 'number', label: 'Size', shortcut: 'Mod+Shift+.', section: SECTIONS.text, order: 1 });
const textColor = c({ id: CONTROL.textColor, kind: 'swatch', label: 'Text colour', section: SECTIONS.text, order: 2 });
const bold = c({ id: CONTROL.bold, kind: 'toggle', label: 'Bold', icon: boldIcon, shortcut: 'Mod+B', section: SECTIONS.text, order: 3 });
const align = c({ id: CONTROL.align, kind: 'align', label: 'Align', icon: alignStartVerticalIcon, section: SECTIONS.arrange });
const distribute = c({ id: CONTROL.distribute, kind: 'menu', label: 'Distribute', icon: alignHorizontalSpaceAroundIcon, section: SECTIONS.arrange, order: 1 });
const fit = c({ id: CONTROL.fit, kind: 'menu', label: 'Fit', section: SECTIONS.image });
const clip = c({ id: CONTROL.clip, kind: 'toggle', label: 'Clip content', icon: frameIcon, section: SECTIONS.frame });
const combine = c({ id: CONTROL.combine, kind: 'menu', label: 'Combine', icon: booleanUnionIcon, section: SECTIONS.arrange, order: 2 });
const useAsMask = c({ id: CONTROL.useAsMask, kind: 'menu', label: 'Use as mask', icon: maskIcon, section: SECTIONS.arrange, order: 3 });
const operation = c({ id: CONTROL.operation, kind: 'menu', label: 'Operation', icon: booleanUnionIcon, section: SECTIONS.combine });
const maskMode = c({ id: CONTROL.maskMode, kind: 'menu', label: 'Mask mode', icon: maskIcon, section: SECTIONS.mask });
const maskInvert = c({ id: CONTROL.maskInvert, kind: 'toggle', label: 'Invert', section: SECTIONS.mask, order: 1, capability: cap('instaflow/mask-invert') });
const chip = c({ id: CONTROL.chip, kind: 'chip', label: 'Kind', section: SECTIONS.arrange });
const repeatCount = c({ id: CONTROL.repeatCount, kind: 'number', label: 'Count', section: SECTIONS.repeat });
const action = (id: ControlId, label: string, capability: string, extra: Partial<Decl> = {}): ControlDecl =>
  c({ id, kind: 'action', label, capability: cap(capability), section: SECTIONS.arrange, order: 10, ...extra });
const duplicate = action(CONTROL.duplicate, 'Duplicate', DuplicateCapability.id, { icon: copyIcon, shortcut: 'Mod+D', group: 'Edit' });
const del = action(CONTROL.delete, 'Delete', DeleteCapability.id, { icon: trash2Icon, shortcut: 'Backspace', group: 'Edit' });
const group = action(CONTROL.group, 'Group', 'instaflow/group', { icon: groupIcon, shortcut: 'Mod+G', group: 'Arrange' });
const ungroup = action(CONTROL.ungroup, 'Ungroup', 'instaflow/ungroup', { icon: ungroupIcon, shortcut: 'Mod+Shift+G', group: 'Arrange' });
const unlock = action(CONTROL.unlock, 'Unlock', LockCapability.id, { icon: lockOpenIcon, shortcut: 'Mod+Shift+L', group: 'Edit' });
const expand = action(CONTROL.repeatExpand, 'Expand', 'instaflow/repeat-expand', { icon: layoutGridIcon, section: SECTIONS.repeat, group: 'Repeat' });
const releaseRepeat = action(CONTROL.repeatRelease, 'Release', 'instaflow/repeat-release', { section: SECTIONS.repeat, group: 'Repeat' });
const releaseBoolean = action(CONTROL.booleanRelease, 'Release', 'instaflow/boolean-release', { section: SECTIONS.combine, group: 'Combine' });
const flatten = action(CONTROL.flatten, 'Flatten', 'instaflow/flatten', { icon: splineIcon, shortcut: 'Mod+E', section: SECTIONS.combine, group: 'Combine' });
const releaseMask = action(CONTROL.maskRelease, 'Release', 'instaflow/mask-release', { section: SECTIONS.mask, group: 'Combine' });

const ranked = (control: ControlDecl, hudRank: 1 | 2 | 3 | 4 | 5 | 6): ControlDecl => ({ ...control, hudRank });

const define = (selection: SelectionKind, controls: readonly ControlDecl[]): ControlSet => {
  const set = defineControls(selection, controls);
  if (!set.ok) throw new Error(set.error.message);
  return set.value;
};

/**
 * The control set of every selection kind (STUDIO-UX-SPEC §4.2.4). Pill items whose value does not apply to the
 * element in front of it (Radius on an ellipse, Points on a rectangle) are not rendered by their view; the ranks stay.
 */
export const CONTROL_SETS: Readonly<Record<SelectionKind, ControlSet>> = Object.freeze({
  none: define('none', []),
  shape: define('shape', [ranked(fill, 1), ranked(stroke, 2), ranked(radius, 3), points, strokeWidth, ranked(duplicate, 4), ranked(del, 5)]),
  text: define('text', [ranked(font, 1), ranked(size, 2), ranked(textColor, 3), ranked(bold, 4), ranked(align, 5), ranked(del, 6), duplicate]),
  image: define('image', [ranked(fit, 2), ranked(duplicate, 5), ranked(del, 6)]),
  frame: define('frame', [ranked(fill, 1), ranked(clip, 2), stroke, ranked(duplicate, 4), ranked(del, 5)]),
  group: define('group', [ranked(ungroup, 1), ranked(align, 2), ranked(duplicate, 3), ranked(del, 4)]),
  multi: define('multi', [ranked(fill, 1), ranked(stroke, 2), ranked(align, 3), ranked(distribute, 4), ranked(group, 5), ranked(del, 6), combine, useAsMask, duplicate]),
  mixed: define('mixed', [ranked(fill, 1), ranked(align, 2), ranked(distribute, 3), ranked(group, 4), ranked(del, 5), combine, useAsMask, duplicate]),
  locked: define('locked', [ranked(chip, 1), ranked(unlock, 2)]),
  repeat: define('repeat', [ranked(chip, 1), ranked(repeatCount, 2), ranked(expand, 4), ranked(releaseRepeat, 5), duplicate, del]),
  boolean: define('boolean', [ranked(operation, 1), ranked(fill, 2), ranked(releaseBoolean, 3), ranked(flatten, 4), ranked(del, 5), duplicate]),
  mask: define('mask', [ranked(maskMode, 1), ranked(maskInvert, 2), ranked(releaseMask, 3), ranked(duplicate, 4), ranked(del, 5)]),
});

/** The More menu's groups per capability (STUDIO §4.2.3); capabilities not listed go to `Arrange`. */
export const MORE_GROUP_OF: Readonly<Record<string, ControlDecl['group']>> = Object.freeze({
  'instaflow/delete': 'Edit',
  'instaflow/duplicate': 'Edit',
  'instaflow/lock': 'Edit',
  'instaflow/hide': 'Edit',
  'instaflow/rotate-90-cw': 'Transform',
  'instaflow/rotate-90-ccw': 'Transform',
  'instaflow/flip-horizontal': 'Transform',
  'instaflow/flip-vertical': 'Transform',
  'instaflow/boolean-union': 'Combine',
  'instaflow/boolean-subtract': 'Combine',
  'instaflow/boolean-intersect': 'Combine',
  'instaflow/boolean-exclude': 'Combine',
  'instaflow/boolean-release': 'Combine',
  'instaflow/flatten': 'Combine',
  'instaflow/outline-stroke': 'Combine',
  'instaflow/mask-clip': 'Combine',
  'instaflow/mask-alpha': 'Combine',
  'instaflow/mask-luminance': 'Combine',
  'instaflow/mask-invert': 'Combine',
  'instaflow/mask-release': 'Combine',
  'instaflow/apply-token': 'Style',
  'instaflow/repeat-radial': 'Repeat',
  'instaflow/repeat-grid': 'Repeat',
  'instaflow/repeat-mirror': 'Repeat',
  'instaflow/repeat-expand': 'Repeat',
  'instaflow/repeat-release': 'Repeat',
  'instaflow/describe-canvas': 'Describe',
});

/**
 * Capabilities never listed in the More menu: they need input the menu cannot give (a name, a token, crop values, a
 * page) or have their own control (the edit row of the inspector).
 */
export const MORE_EXCLUDED: ReadonlySet<string> = new Set(['instaflow/rename', 'instaflow/apply-token', 'instaflow/image-crop', 'instaflow/show-all', 'instaflow/repeat-edit']);
