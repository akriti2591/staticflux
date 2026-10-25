/**
 * Example mini editor: a **pixel touch-up** of one image (EDITOR-AS-PRIMITIVE.md "Mini editors in Chat").
 * The same engine as Studio with a narrow spec: the Pixel lens on a selection, three tools, the Adjust
 * panel, one ✦ action, Focus density. In M2 a chat turn attaches it; "Open in Studio" carries the
 * selection over (`studioSpecFor(pixel)` with the same scope).
 */
import { editDocumentCapability } from '../capabilities.js';
import { defineEditorSpec, type EditorSpec } from '../schema.js';
import { StudioIds } from '../studio-contributions.js';

export const PIXEL_TOUCHUP_SPEC_ID = 'instaflow/pixel-touchup';

/** A pixel touch-up of `nodes` (the image layer or selection). */
export function pixelTouchUpSpec(nodes: readonly string[]): EditorSpec {
  return defineEditorSpec({
    id: PIXEL_TOUCHUP_SPEC_ID,
    label: 'Pixel touch-up',
    lens: StudioIds.lens.pixel,
    scope: { kind: 'selection', nodes },
    tools: [StudioIds.tool.brush, StudioIds.tool.heal, StudioIds.tool.crop],
    panels: [{ panel: StudioIds.panel.adjust, dock: 'inspector' }],
    hud: [StudioIds.hud.removeBackground],
    capabilities: [editDocumentCapability.id],
    density: 'focus',
  });
}
