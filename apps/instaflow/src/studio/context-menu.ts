/**
 * The context menu's items per target (B11b, STUDIO-UX-SPEC §8.2) as data: the empty canvas, a selection (every kind,
 * with its kind's items), the page label. Only applicable items are listed: a capability is offered only when the
 * selection's `actions` include it (the More menu and the command bar draw from the same list), Paste only when
 * something was copied, Paste style only after Copy style. Pure; `<if-studio>` renders the groups with `sf-menu` at the
 * pointer and runs the values (`cap:<id>[?key=value]`, `cmd:<name>[:<arg>]`).
 */
import type { SelectionSummary } from '../app/scene-summary.js';
import { STYLE_PARTS } from '../app/studio-commands.js';
import { TEXT_PRESETS, type TextPresetName } from '../text/typography.js';
import { FIT_LABELS, pageSizePresets } from './inspector-model.js';

export interface ContextEntry {
  readonly value: string;
  readonly label: string;
  readonly shortcut?: string;
  /** A submenu (one level, kit rule). */
  readonly children?: readonly ContextEntry[];
}

export type ContextGroup = readonly ContextEntry[];

export type ContextTarget = { readonly kind: 'canvas' } | { readonly kind: 'selection'; readonly summary: SelectionSummary } | { readonly kind: 'page' };

export interface ContextEnv {
  /** Something is on Studio's clipboard (memory or system). */
  readonly canPaste: boolean;
  /** Copy style ran (Paste style has something). */
  readonly styleCopied: boolean;
  /** The design has more than one page (Delete page). */
  readonly pages: number;
}

export const contextMessages = Object.freeze({
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteInPlace: 'Paste in place',
  duplicate: 'Duplicate',
  delete: 'Delete',
  copyStyle: 'Copy style',
  pasteStyle: 'Paste style',
  pasteStyleOnly: 'Paste style only',
  styleParts: { fill: 'Fill', stroke: 'Stroke', effects: 'Effects', corners: 'Corners', layer: 'Opacity and blend' } as Readonly<Record<string, string>>,
  bringToFront: 'Bring to front',
  bringForward: 'Bring forward',
  sendBackward: 'Send backward',
  sendToBack: 'Send to back',
  group: 'Group',
  ungroup: 'Ungroup',
  frameSelection: 'Frame selection',
  lock: 'Lock',
  unlock: 'Unlock',
  hide: 'Hide',
  show: 'Show',
  rename: 'Rename',
  selectSame: 'Select same',
  same: { fill: 'Fill', stroke: 'Stroke', effects: 'Effects', font: 'Font', kind: 'Kind' } as Readonly<Record<string, string>>,
  copyLink: 'Copy link to selection',
  useAsMask: 'Use as mask',
  outlineStroke: 'Outline stroke',
  flatten: 'Flatten',
  makeRepeat: 'Make repeat',
  repeats: { radial: 'Radial', grid: 'Grid', mirror: 'Mirror' } as Readonly<Record<string, string>>,
  editText: 'Edit text',
  textStyle: 'Text style',
  fitToBox: 'Fit to box',
  copyAsText: 'Copy as text',
  replaceImage: 'Replace image…',
  fit: 'Fit',
  tidyUp: 'Tidy up',
  align: 'Align',
  aligns: { left: 'Left', 'center-x': 'Horizontal centres', right: 'Right', top: 'Top', 'center-y': 'Vertical centres', bottom: 'Bottom' } as Readonly<Record<string, string>>,
  distribute: 'Distribute',
  distributes: { 'distribute-h-spacing': 'Horizontal spacing', 'distribute-v-spacing': 'Vertical spacing', 'distribute-h-centers': 'Horizontal centres', 'distribute-v-centers': 'Vertical centres' } as Readonly<
    Record<string, string>
  >,
  combine: 'Combine',
  operations: { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' } as Readonly<Record<string, string>>,
  expand: 'Expand repeat',
  release: 'Release',
  selectAll: 'Select all',
  zoomFit: 'Zoom to fit',
  zoom100: 'Zoom to 100 %',
  addPage: 'Add page',
  renamePage: 'Rename page',
  duplicatePage: 'Duplicate page',
  deletePage: 'Delete page',
  setSize: 'Set size',
  background: 'Background…',
  copyPageLink: 'Copy link to page',
  placeImage: 'Place image…',
});

const m = contextMessages;
const entry = (value: string, label: string, shortcut?: string, children?: readonly ContextEntry[]): ContextEntry => ({ value, label, ...(shortcut === undefined ? {} : { shortcut }), ...(children === undefined ? {} : { children }) });

/** The groups for a target (empty groups are dropped). */
export function contextMenuGroups(target: ContextTarget, env: ContextEnv): readonly ContextGroup[] {
  const groups = target.kind === 'canvas' ? canvasGroups(env) : target.kind === 'page' ? pageGroups(env) : selectionGroups(target.summary, env);
  return groups.filter((g) => g.length > 0);
}

function canvasGroups(env: ContextEnv): ContextGroup[] {
  return [
    env.canPaste ? [entry('cmd:paste', m.paste, 'Mod+V'), entry('cmd:paste-in-place', m.pasteInPlace, 'Mod+Shift+V')] : [],
    [entry('cmd:select-all', m.selectAll, 'Mod+A')],
    [entry('cmd:zoom-fit', m.zoomFit, 'Shift+1'), entry('cmd:zoom-100', m.zoom100, 'Shift+0')],
    [entry('cmd:add-page', m.addPage), entry('cmd:place-image', m.placeImage)],
  ];
}

function pageGroups(env: ContextEnv): ContextGroup[] {
  return [
    [
      entry('cmd:page-rename', m.renamePage),
      entry('cmd:page-duplicate', m.duplicatePage),
      ...(env.pages > 1 ? [entry('cmd:page-delete', m.deletePage)] : []),
      entry(
        'cmd:page-size',
        m.setSize,
        undefined,
        pageSizePresets().map((p) => entry(`cmd:page-size:${p.width}x${p.height}`, p.label)),
      ),
      entry('cmd:page-background', m.background),
    ],
    [entry('cmd:copy-link-page', m.copyPageLink)],
  ];
}

function selectionGroups(s: SelectionSummary, env: ContextEnv): ContextGroup[] {
  const has = (id: string): boolean => s.actions.includes(id);
  const cap = (id: string, label: string, shortcut?: string): ContextEntry[] => (has(id) ? [entry(`cap:${id}`, label, shortcut)] : []);
  const single = s.nodes.length === 1;
  const many = s.nodes.length > 1;
  const edit: ContextEntry[] = [
    entry('cmd:cut', m.cut, 'Mod+X'),
    entry('cmd:copy', m.copy, 'Mod+C'),
    ...(env.canPaste ? [entry('cmd:paste', m.paste, 'Mod+V')] : []),
    ...cap('instaflow/duplicate', m.duplicate, 'Mod+D'),
    ...cap('instaflow/delete', m.delete, 'Delete'),
  ];
  const style: ContextEntry[] = [
    ...cap('instaflow/copy-style', m.copyStyle, 'Mod+Alt+C'),
    ...(env.styleCopied && has('instaflow/paste-style')
      ? [
          entry('cap:instaflow/paste-style', m.pasteStyle, 'Mod+Alt+V'),
          entry(
            'cmd:paste-style-only',
            m.pasteStyleOnly,
            undefined,
            STYLE_PARTS.map((part) => entry(`cap:instaflow/paste-style?only=${part}`, m.styleParts[part] ?? part)),
          ),
        ]
      : []),
  ];
  const order: ContextEntry[] = [
    ...cap('instaflow/bring-to-front', m.bringToFront, 'Mod+Alt+]'),
    ...cap('instaflow/bring-forward', m.bringForward, 'Mod+]'),
    ...cap('instaflow/send-backward', m.sendBackward, 'Mod+['),
    ...cap('instaflow/send-to-back', m.sendToBack, 'Mod+Alt+['),
  ];
  const structure: ContextEntry[] = [
    ...(s.kind === 'group' || s.kind === 'frame' ? cap('instaflow/ungroup', m.ungroup, 'Mod+Shift+G') : cap('instaflow/group', m.group, 'Mod+G')),
    ...cap('instaflow/frame-selection', m.frameSelection, 'Mod+Alt+G'),
    ...(has('instaflow/lock') ? [entry(s.locked ? 'cap:instaflow/lock?locked=false' : 'cap:instaflow/lock?locked=true', s.locked ? m.unlock : m.lock, 'Mod+Shift+L')] : []),
    ...(has('instaflow/hide') ? [entry(s.hidden ? 'cap:instaflow/hide?hidden=false' : 'cap:instaflow/hide?hidden=true', s.hidden ? m.show : m.hide, 'Mod+Shift+H')] : []),
    ...(single ? [entry('cmd:rename', m.rename, 'Mod+Shift+R')] : []),
  ];
  const sameBy = s.common === 'text' ? ['fill', 'font', 'kind'] : ['fill', 'stroke', 'effects', 'kind'];
  const more: ContextEntry[] = [
    ...(has('instaflow/select-same') ? [entry('cmd:select-same', m.selectSame, undefined, sameBy.map((by) => entry(`cap:instaflow/select-same?by=${by}`, m.same[by] ?? by)))] : []),
    entry('cmd:copy-link-selection', m.copyLink),
  ];
  const repeatMenu = (['radial', 'grid', 'mirror'] as const).filter((k) => has(`instaflow/repeat-${k}`)).map((k) => entry(`cap:instaflow/repeat-${k}`, m.repeats[k] ?? k));
  const KIND: Readonly<Record<string, () => ContextEntry[]>> = {
    shape: () => [
      ...cap('instaflow/mask-clip', m.useAsMask, 'Ctrl+Alt+M'),
      ...cap('instaflow/outline-stroke', m.outlineStroke, 'Mod+Shift+O'),
      ...cap('instaflow/flatten', m.flatten, 'Mod+E'),
      ...(repeatMenu.length > 0 ? [entry('cmd:make-repeat', m.makeRepeat, undefined, repeatMenu)] : []),
    ],
    text: () => [
      entry('cmd:edit-text', m.editText, 'Enter'),
      entry(
        'cmd:text-style',
        m.textStyle,
        undefined,
        (Object.keys(TEXT_PRESETS) as TextPresetName[]).map((name) => entry(`cmd:text-style:${name}`, name)),
      ),
      entry('cmd:fit-to-box', m.fitToBox),
      entry('cmd:copy-as-text', m.copyAsText),
    ],
    image: () => [
      entry('cmd:replace-image', m.replaceImage),
      entry(
        'cmd:fit',
        m.fit,
        undefined,
        (Object.keys(FIT_LABELS) as (keyof typeof FIT_LABELS)[]).map((f) => entry(`cmd:fit:${f}`, FIT_LABELS[f])),
      ),
      ...cap('instaflow/mask-clip', m.useAsMask, 'Ctrl+Alt+M'),
    ],
    group: () => [...cap('instaflow/tidy-up', m.tidyUp, 'Ctrl+Alt+Shift+T')],
    frame: () => [...cap('instaflow/tidy-up', m.tidyUp, 'Ctrl+Alt+Shift+T')],
    repeat: () => [...cap('instaflow/repeat-expand', m.expand), ...cap('instaflow/repeat-release', m.release), ...cap('instaflow/flatten', m.flatten, 'Mod+E')],
    boolean: () => [...cap('instaflow/boolean-release', m.release), ...cap('instaflow/flatten', m.flatten, 'Mod+E')],
    mask: () => (s.mask === undefined ? [] : [entry(`cap:instaflow/mask-release?node=${s.mask.node}`, m.release)]),
    multi: () => multiItems(),
    mixed: () => multiItems(),
  };
  function multiItems(): ContextEntry[] {
    const aligns = Object.entries(m.aligns).filter(([edge]) => has(`instaflow/align-${edge}`)).map(([edge, label]) => entry(`cap:instaflow/align-${edge}`, label));
    const distributes = Object.entries(m.distributes).filter(([id]) => has(`instaflow/${id}`)).map(([id, label]) => entry(`cap:instaflow/${id}`, label));
    const ops = Object.entries(m.operations).filter(([op]) => has(`instaflow/boolean-${op}`)).map(([op, label]) => entry(`cap:instaflow/boolean-${op}`, label));
    return [
      ...(aligns.length > 0 && many ? [entry('cmd:align', m.align, undefined, aligns)] : []),
      ...(distributes.length > 0 ? [entry('cmd:distribute', m.distribute, undefined, distributes)] : []),
      ...(ops.length > 0 ? [entry('cmd:combine', m.combine, undefined, ops)] : []),
      ...(repeatMenu.length > 0 ? [entry('cmd:make-repeat', m.makeRepeat, undefined, repeatMenu)] : []),
      ...cap('instaflow/mask-clip', m.useAsMask, 'Ctrl+Alt+M'),
    ];
  }
  if (s.kind === 'locked') {
    return [[entry('cmd:copy', m.copy, 'Mod+C')], [entry('cap:instaflow/lock?locked=false', m.unlock, 'Mod+Shift+L')]];
  }
  return [edit, style, order, structure, more, KIND[s.kind]?.() ?? []];
}

/** Split a menu value into its runner and arguments (`cap:id?key=value` → capability id and input). Pure. */
export function parseContextValue(value: string): { readonly kind: 'cap'; readonly id: string; readonly input: Readonly<Record<string, unknown>> } | { readonly kind: 'cmd'; readonly name: string; readonly arg?: string } | undefined {
  if (value.startsWith('cap:')) {
    const [id, query] = value.slice(4).split('?') as [string, string | undefined];
    const input: Record<string, unknown> = {};
    for (const pair of (query ?? '').split('&').filter((x) => x !== '')) {
      const [k, v] = pair.split('=') as [string, string];
      input[k] = v === 'true' ? true : v === 'false' ? false : v;
    }
    return { kind: 'cap', id, input };
  }
  if (value.startsWith('cmd:')) {
    const rest = value.slice(4);
    const at = rest.indexOf(':');
    return at < 0 ? { kind: 'cmd', name: rest } : { kind: 'cmd', name: rest.slice(0, at), arg: rest.slice(at + 1) };
  }
  return undefined;
}
