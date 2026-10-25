/** Test-only fixtures: Studio's registries (optionally with gated contributions) and a gate with editor policies. */
import { createGate, createManualFactSource, defineFact, definePolicy, definePolicySet, fact, type Gate } from '@staticflux/gate';
import { gateResource } from '@staticflux/ui';
import { editDocumentCapability, proposeSpecCapability } from '../capabilities.js';
import { createEditorRegistries, type EditorRegistries } from '../registries.js';
import { StudioIds, studioHudActions, studioLenses, studioPanels, studioTools } from '../studio-contributions.js';

export const BrandGate = gateResource('ui-slot', StudioIds.panel.brand);
export const AskGate = gateResource('ui-slot', StudioIds.hud.ask);

/** Studio's registries. `gated`: the Brand panel and the Ask action carry gate resources (as a Pro plan would). */
export function studioRegistries(options: { readonly gated?: boolean } = {}): EditorRegistries {
  const gated = options.gated === true;
  const result = createEditorRegistries({
    lenses: studioLenses,
    tools: studioTools,
    panels: studioPanels.map((p) => (gated && p.id === StudioIds.panel.brand ? { ...p, gate: BrandGate } : p)),
    hud: studioHudActions.map((h) => (gated && h.id === StudioIds.hud.ask ? { ...h, gate: AskGate } : h)),
    capabilities: [proposeSpecCapability, editDocumentCapability],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

export const PlanFact = defineFact('test/plan').type<string>();

/**
 * Policies: Brand needs plan `pro` (deny reason `upgrade`) for people and agents; agents may use Ask (unless `delegateAsk: false`),
 * propose specs and edit the document (explicit delegation, R6.17); everything else is ungated for people.
 */
export function editorGate(plan = 'free', options: { readonly delegateAsk?: boolean } = {}): { readonly gate: Gate; setPlan(next: string): void } {
  const facts = createManualFactSource('test/editor-facts', [PlanFact]);
  facts.set(PlanFact, plan);
  const gate = createGate({
    sources: [facts],
    policySets: [
      definePolicySet('test/editor-policies', [
        definePolicy({ id: 'test/brand-pro', resource: BrandGate, when: fact(PlanFact).eq('pro'), deny: { reason: 'upgrade' } }),
        definePolicy({ id: 'test/brand-agent', subjects: ['agent'], resource: BrandGate, when: fact(PlanFact).eq('pro') }),
        ...(options.delegateAsk === false ? [] : [definePolicy({ id: 'test/ask-agent', subjects: ['agent'], resource: AskGate })]),
        definePolicy({ id: 'test/propose-agent', subjects: ['agent'], resource: gateResource('capability', proposeSpecCapability.id) }),
        definePolicy({ id: 'test/edit-agent', subjects: ['agent'], resource: gateResource('capability', editDocumentCapability.id) }),
      ]),
    ],
  });
  return { gate, setPlan: (next) => facts.set(PlanFact, next) };
}
