/**
 * Test-only fixtures for the Studio integration (never imported by app code): an in-memory workspace, a new Studio
 * document opened over the real authoring Wasm (geometry and text, loaded from `engine/dist` in Node; suites skip
 * when it is not built), and Studio's fonts from `test/fonts`.
 */
import { createScope, type Scope } from '@staticflux/core';
import type { Actor } from '@staticflux/stage';
import { authoringBuilt as geometryBuilt, loadGeometry } from '../../elements/testing/fixtures.js';
import { authoringBuilt as textBuilt, loadAuthoringInNode, testFont } from '../../text/test-helpers.js';
import { createStudioDocument, openStudioDocument, openStudioWorkspace, type StudioDocument, type StudioWorkspace } from '../document.js';
import { createStudioFonts } from '../fonts.js';
import type { StudioFonts } from '../text-layer.js';

export const authoringBuilt = geometryBuilt && textBuilt;
export const person: Actor = { kind: 'human', id: 'g-ada', displayName: 'Ada', via: 'direct' };

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

export interface StudioFixture {
  readonly workspace: StudioWorkspace;
  readonly document: StudioDocument;
  readonly fonts: StudioFonts;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}

let assets = 0;

/** A new Studio document with `pages` pages (1080 × 1350) and Noto Sans as the default face. */
export async function createStudioFixture(options: { readonly pages?: number } = {}): Promise<StudioFixture> {
  const scope = createScope('studio-test');
  const signal = scope.signal;
  const workspace = unwrap(await openStudioWorkspace({ signal }));
  const doc = unwrap(await createStudioDocument(workspace, { asset: `as_test${(assets += 1)}`, title: 'Flyer', pages: options.pages ?? 1, signal }));
  const geometry = await loadGeometry();
  const document = unwrap(await openStudioDocument({ workspace, doc, geometry, signal, scope }));
  const fonts = unwrap(createStudioFonts({ wasm: await loadAuthoringInNode('base'), fonts: [testFont('NotoSans-Latin.wght.ttf'), testFont('NotoSansArabic.wght.ttf')] }));
  return { workspace, document, fonts, scope, signal };
}
