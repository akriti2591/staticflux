// The codec declaration (stand-in for SF-Δ34 `defineViewCodec` over `defineComponent` schemas).
// ONE table drives: projection (all views), parsing, validation of `set` ops, unrounding, and the generated prompt
// vocabulary. Nothing else in the spike names a property path.

/** Attribute types. `px` = page-relative integer geometry in the view; `s` = seconds (canonical ticks). */
export const ATTRS = {
  name:        { path: 'name',              type: 'str' },
  role:        { path: 'role',              type: 'enum', values: ['headline', 'subhead', 'body', 'cta', 'logo', 'hero', 'price', 'legal', 'caption', 'background', 'badge', 'date', 'bullet', 'title', 'photo', 'chart', 'notes', 'music', 'broll', 'reaction'] },
  x:           { path: 'spatial.x',         type: 'px', geom: true },
  y:           { path: 'spatial.y',         type: 'px', geom: true },
  w:           { path: 'spatial.w',         type: 'px' },
  h:           { path: 'spatial.h',         type: 'px' },
  rotate:      { path: 'spatial.rotation',  type: 'num', def: 0 },
  opacity:     { path: 'spatial.opacity',   type: 'num', def: 1, min: 0, max: 1 },
  fill:        { path: 'style.fill',        type: 'color' },
  stroke:      { path: 'style.stroke',      type: 'color' },
  strokeWidth: { path: 'style.strokeWidth', type: 'num', def: 0, min: 0 },
  radius:      { path: 'style.radius',      type: 'px', def: 0 },
  clip:        { path: 'frame.clip',        type: 'bool', def: false },
  font:        { path: 'text.font',         type: 'color' /* token or literal */ },
  size:        { path: 'text.size',         type: 'num', min: 1, max: 2000 },
  weight:      { path: 'text.weight',       type: 'num', def: 400, min: 100, max: 900 },
  align:       { path: 'text.align',        type: 'enum', values: ['start', 'center', 'end'], def: 'start' },
  lineHeight:  { path: 'text.lineHeight',   type: 'num', def: 1.2, min: 0.5, max: 4 },
  src:         { path: 'source.asset',      type: 'str' },
  fit:         { path: 'image.fit',         type: 'enum', values: ['cover', 'contain'], def: 'cover' },
  start:       { path: 'temporal.start',    type: 's', min: 0 },
  dur:         { path: 'temporal.duration', type: 's', min: 0 },
  in:          { path: 'source.in',         type: 's', min: 0 },
  out:         { path: 'source.out',        type: 's', min: 0 },
  volume:      { path: 'audio.volume',      type: 'num', def: 1, min: 0, max: 4 },
  fadeIn:      { path: 'audio.fadeIn',      type: 's', def: 0, min: 0 },
  fadeOut:     { path: 'audio.fadeOut',     type: 's', def: 0, min: 0 },
  track:       { path: 'track.kind',        type: 'enum', values: ['video', 'overlay', 'text', 'audio'] },
  muted:       { path: 'track.muted',       type: 'bool', def: false },
  cap:         { path: 'step.capability',   type: 'str' },
  params:      { path: 'step.params',       type: 'json', def: {} },
  // annotations: shown, never writable by agents (composition/policy, DOCUMENT-FORMAT §3.3)
  locked:      { path: 'lock.scope',        type: 'enum', values: ['position', 'content', 'all'], readonly: true },
  from:        { path: 'policy.from',       type: 'enum', values: ['template', 'brand'], readonly: true },
};
export const PATH_TO_ATTR = Object.fromEntries(Object.entries(ATTRS).map(([a, d]) => [d.path, a]));
export const TEXT_PATH = 'text.content';

const GEOM = ['x', 'y', 'w', 'h', 'rotate', 'opacity'];
const COMMON = ['name', 'role', 'locked', 'from'];
/** Node kinds (DOCUMENT-FORMAT §3.1) → view element + attributes. Order of attrs = print order. */
export const KINDS = {
  page:    { tag: 'page',    container: true, attrs: [...COMMON, 'w', 'h', 'fill', 'dur'] },
  frame:   { tag: 'frame',   container: true, attrs: [...COMMON, ...GEOM, 'fill', 'radius', 'clip'] },
  group:   { tag: 'group',   container: true, attrs: [...COMMON, ...GEOM] },
  rect:    { tag: 'rect',    attrs: [...COMMON, ...GEOM, 'fill', 'stroke', 'strokeWidth', 'radius'] },
  ellipse: { tag: 'ellipse', attrs: [...COMMON, ...GEOM, 'fill', 'stroke', 'strokeWidth'] },
  text:    { tag: 'text',    text: true, attrs: [...COMMON, ...GEOM, 'font', 'size', 'weight', 'fill', 'align', 'lineHeight', 'start', 'dur'] },
  image:   { tag: 'image',   attrs: [...COMMON, ...GEOM, 'src', 'fit'] },
  track:   { tag: 'track',   container: true, attrs: [...COMMON, 'track', 'muted'] },
  video:   { tag: 'video',   attrs: [...COMMON, ...GEOM, 'src', 'start', 'dur', 'in', 'out', 'volume', 'fadeIn', 'fadeOut'] },
  audio:   { tag: 'audio',   attrs: [...COMMON, 'src', 'start', 'dur', 'in', 'out', 'volume', 'fadeIn', 'fadeOut'] },
  flow:    { tag: 'flow',    container: true, attrs: [...COMMON] },
  step:    { tag: 'step',    attrs: [...COMMON, 'cap', 'params'] },
  edge:    { tag: 'edge',    attrs: [] },
};
export const TAG_TO_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, d]) => [d.tag, k]));
/** Which kinds a container accepts (§3.1 table, trimmed to the spike). */
export const CHILDREN = {
  page: ['frame', 'group', 'rect', 'ellipse', 'text', 'image', 'track', 'video'],
  frame: ['frame', 'group', 'rect', 'ellipse', 'text', 'image', 'video'],
  group: ['frame', 'group', 'rect', 'ellipse', 'text', 'image', 'video'],
  track: ['video', 'audio', 'text'],
  flow: ['step', 'edge'],
};
export const MEDIA_KINDS = new Set(['video', 'audio']);
export const TIMED_KINDS = new Set(['video', 'audio', 'text']);

/** Capability registry stand-in for the graph view (ports are typed). */
export const CAPABILITIES = {
  'media/transcribe':   { in: { media: 'media' }, out: { words: 'transcript' } },
  'captions/generate':  { in: { words: 'transcript' }, out: { captions: 'captions' } },
  'captions/style':     { in: { captions: 'captions' }, out: { captions: 'captions' } },
  'text/translate':     { in: { captions: 'captions' }, out: { captions: 'captions' } },
  'timeline/attach':    { in: { captions: 'captions', video: 'media' }, out: { video: 'media' } },
  'export/mp4':         { in: { video: 'media' }, out: { file: 'file' } },
  'audio/remove-silence': { in: { media: 'media' }, out: { media: 'media' } },
};

/** Generated vocabulary reference (IF-6.4): from the tables above, never hand-maintained. */
export function vocabulary(kinds = Object.keys(KINDS)) {
  const lines = [];
  for (const k of kinds) {
    const d = KINDS[k];
    const attrs = d.attrs.map((a) => {
      const A = ATTRS[a];
      const t = A.type === 'enum' ? A.values.join('|') : A.type === 'px' ? 'px int' : A.type === 's' ? 'seconds' : A.type === 'color' ? '#hex|@token' : A.type;
      return `${a}(${t}${A.def !== undefined ? `, default ${JSON.stringify(A.def)}` : ''}${A.readonly ? ', read-only' : ''})`;
    });
    lines.push(`- <${d.tag}>${d.container ? ' (container)' : ''}${d.text ? ' (text content = element body)' : ''}: ${attrs.join(', ')}`);
  }
  return lines.join('\n');
}
