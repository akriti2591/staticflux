/**
 * Inline surfaces and coach-mark targets inside feature content.
 *
 * - `<sf-surface-outlet outlet="studio/editor-alerts">` renders the showing
 *   `inline-alert` surfaces declared with that `outlet`.
 * - `coachTarget(target)` marks an element as a coach-mark target; it registers the
 *   element with the surface manager resolved from the host component's injector and
 *   unregisters when the element leaves the DOM.
 */
import type { Injector } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { html, nothing, type TemplateResult } from 'lit';
import { AsyncDirective, directive, type ElementPart, type PartInfo, PartType } from 'lit/async-directive.js';
import { repeat } from 'lit/directives/repeat.js';
import { renderContext } from './manager.js';
import type { CoachTarget, SurfaceId } from './surface.js';
import { SurfaceManagerToken } from './tokens.js';

const outletSpec = component({
  tag: 'sf-surface-outlet',
  deps: { render: { surfaces: SurfaceManagerToken } },
  placeholder: () => nothing,
});

export class SfSurfaceOutletElement extends SfElement<typeof outletSpec> {
  static override readonly spec = outletSpec;
  static override properties = { outlet: { type: String } };
  declare outlet: SurfaceId | '';

  constructor() {
    super();
    this.outlet = '';
  }

  override render(): TemplateResult {
    const alerts = this.deps.surfaces.showing('inline-alert').filter((h) => h.def.outlet === this.outlet);
    return html`${repeat(
      alerts,
      (h) => h.instanceId,
      (h) =>
        html`<div role=${h.def.priority === 'urgent' || h.def.priority === 'high' ? 'alert' : 'status'} data-surface=${h.def.id}>
          ${h.def.render(renderContext(h))}
        </div>`,
    )}`;
  }
}

export function defineSurfaceOutlet(registry: CustomElementRegistry = customElements): void {
  if (registry.get(outletSpec.tag) === undefined) defineComponent(SfSurfaceOutletElement, registry);
}

class CoachTargetDirective extends AsyncDirective {
  private unregister: (() => void) | undefined;
  private target: CoachTarget | undefined;
  private element: Element | undefined;
  private generation = 0;

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ELEMENT) throw new Error('coachTarget() must be used in element position: <button ${coachTarget(t)}>');
  }

  render(_target: CoachTarget): typeof nothing {
    return nothing;
  }

  override update(part: ElementPart, [target]: [CoachTarget]): typeof nothing {
    if (target !== this.target || part.element !== this.element) {
      this.target = target;
      this.element = part.element;
      this.attach(part.options?.host);
    }
    return nothing;
  }

  private attach(host: unknown): void {
    this.detach();
    const generation = ++this.generation;
    const injector = (host as { injector?: Injector } | undefined)?.injector;
    const target = this.target;
    const element = this.element;
    if (injector === undefined || target === undefined || element === undefined) return;
    void injector.get(SurfaceManagerToken).then((manager) => {
      if (!manager.ok || generation !== this.generation || !this.isConnected) return;
      this.unregister = manager.value.targets.register(target, element);
    });
    this.host = host;
  }

  private host: unknown;

  private detach(): void {
    this.generation += 1;
    this.unregister?.();
    this.unregister = undefined;
  }

  protected override disconnected(): void {
    this.detach();
  }

  protected override reconnected(): void {
    this.attach(this.host);
  }
}

/** Element directive: `<button ${coachTarget(AiButtonTarget)}>` */
export const coachTarget = directive(CoachTargetDirective);
