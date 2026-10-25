/**
 * B6's contributions to the editor spec (D16). Nothing here builds a screen: the accessibility layer lives inside the
 * canvas surface Studio already lays out.
 *
 * - **Capability** `instaflow/describe-canvas` (read-only, exposed to agents): the selection or what is in view, in
 *   reading order, as text. Agents and people get the same words a screen reader hears.
 * - **HUD action** "Describe" (tone `more`, Canvas and Pages lenses) runs it by hand (D17); the result is spoken
 *   through the polite live region by the host.
 */
import { capabilityDeclarationUnit, capabilityImplementationUnit, defineCapability, implementCapability, s } from '@staticflux/capabilities';
import { AbortedError, err, type Result } from '@staticflux/core';
import { defineHudAction, hudActionContribution, type HudActionContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { DESCRIBE_TARGETS, type DescribeTarget } from './canvas-a11y.js';
import { NoCanvasError } from './errors.js';

export const describeCanvasCapability = defineCapability({
  id: 'instaflow/describe-canvas',
  title: 'Describe the canvas',
  description: 'Describe the selection, or every element in view in reading order, as a screen reader would say it.',
  input: s.object({ what: s.enum(DESCRIBE_TARGETS, { description: 'selection: the selected elements; visible: what is in view' }) }),
  output: s.object({ text: s.string({ description: 'The description' }), count: s.number({ integer: true, min: 0, description: 'Elements described' }) }),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

/** What the implementation needs: the open tab's accessibility layer. */
export interface A11yEnv {
  canvas(): { describe(what: DescribeTarget): Result<{ readonly text: string; readonly count: number }> } | undefined;
}

export function a11yCapabilityImplementations(env: A11yEnv) {
  return [
    implementCapability(describeCanvasCapability, (input, run) => {
      if (run.signal.aborted) return err(AbortedError());
      const canvas = env.canvas();
      return canvas === undefined ? err(NoCanvasError()) : canvas.describe(input.what);
    }),
  ];
}

export const describeHudAction: HudActionContribution = defineHudAction({
  id: describeCanvasCapability.id,
  label: 'Describe',
  description: 'Say what is selected, as a screen reader would.',
  tone: 'more',
  capability: describeCanvasCapability.id,
  lenses: [StudioIds.lens.canvas, StudioIds.lens.pages],
  scopes: ['selection', 'page'],
});

/** Every B6 contribution: the capability declaration and implementation, the HUD action. */
export function a11yContributionUnits(env: A11yEnv) {
  return [capabilityDeclarationUnit(describeCanvasCapability), ...a11yCapabilityImplementations(env).map((impl) => capabilityImplementationUnit(impl)), hudActionContribution(describeHudAction)];
}
