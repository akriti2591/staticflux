/**
 * Mount helper for feature UIs: renders the feature's root template inside an
 * `<sf-scope level="feature">` bound to the feature injector (so components
 * self-inject feature units), frozen while the feature is hidden (R5.2, R12.16),
 * into the outlet the router/panel passed as `context.target`.
 */
import { watch } from '@staticflux/core';
import type { FeatureUiContext } from '@staticflux/runtime';
import { type UiEnvironment, UiEnvironmentToken, defineUiElements } from '@staticflux/ui';
import { html, nothing, render, type TemplateResult } from 'lit';

export async function mountFeatureRoot(context: FeatureUiContext, template: () => TemplateResult): Promise<void> {
  defineUiElements();
  const outlet = context.target instanceof HTMLElement ? context.target : document.createElement('div');
  const environment = await context.injector.get(UiEnvironmentToken);
  const env: UiEnvironment | undefined = environment.ok ? environment.value : undefined;
  const host = outlet.ownerDocument.createElement('section');
  host.dataset['sfFeature'] = context.id;
  host.className = 'feature-root';
  outlet.append(host);
  const paint = (hidden: boolean): void => {
    render(
      html`<sf-scope level="feature" name=${context.id} .injector=${context.injector} .environment=${env} ?frozen=${hidden}>${template()}</sf-scope>`,
      host,
    );
    host.hidden = hidden;
  };
  paint(context.hidden);
  const stop = watch(
    () => context.hidden,
    (hidden) => paint(hidden),
  );
  context.uiScope.defer(() => {
    stop();
    render(nothing, host);
    host.remove();
  });
}
