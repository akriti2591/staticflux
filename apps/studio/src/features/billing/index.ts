/**
 * Feature `billing/upsell` (chunk `feature:billing`, cheap, speculative warmup on
 * hover of an upgrade CTA): the routable upgrade dialog content (`/d/upgrade`) and
 * the low-credit banner. Upgrading rotates the BFF session (new plan claim), which
 * refreshes the app epoch — gate facts and cached data follow automatically.
 */
import { box, ok, watch } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { DataClientToken } from '@staticflux/data';
import { MeterRegistryToken } from '@staticflux/gate';
import { ownerOf, type SurfaceHandle, SurfaceManagerToken } from '@staticflux/messaging';
import { defineButton } from '@staticflux/kit/button';
import { defineFeatureModule } from '@staticflux/runtime';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { CreditsMeter } from '../../app/contracts.js';
import { UpgradePlanEndpoint } from '../../app/endpoints.js';
import { CreditBanner } from '../../app/surfaces.js';

/** Upgrade action injected into the dialog element (set on activate). */
const upgradeAction = box<(() => Promise<boolean>) | undefined>(undefined);

/**
 * Dialog body rendered by the routable surface inside the kit dialog frame (which owns the
 * heading "Upgrade to Pro" and the close button); a plain Lit element (no own deps).
 */
class BillingUpgradeDialog extends LitElement {
  static override properties = { dismiss: { attribute: false }, busy: { state: true } };
  static override styles = css`
    :host { display: grid; gap: ${t.space.lg.css}; }
    ul { margin: 0; padding-inline-start: ${t.space.lg.css}; }
    .actions { display: flex; justify-content: flex-end; gap: ${t.space.sm.css}; }
  `;
  declare dismiss: ((completed: boolean) => void) | undefined;
  declare busy: boolean;
  constructor() {
    super();
    this.dismiss = undefined;
    this.busy = false;
  }
  protected override willUpdate(_changed: PropertyValues): void {}
  override render() {
    return html`
      <ul><li>Summaries with the on-device model</li><li>Unlimited images (no credits)</li></ul>
      <div class="actions">
        <sf-button @click=${() => this.dismiss?.(false)}>Not now</sf-button>
        <sf-button variant="primary" ?disabled=${this.busy} @click=${() => void this.upgrade()}>Upgrade</sf-button>
      </div>
    `;
  }
  private async upgrade(): Promise<void> {
    this.busy = true;
    const done = (await upgradeAction.get()?.()) ?? false;
    this.busy = false;
    this.dismiss?.(done);
  }
}

export default defineFeatureModule({
  async activate(context) {
    defineButton();
    if (customElements.get('billing-upgrade-dialog') === undefined) customElements.define('billing-upgrade-dialog', BillingUpgradeDialog);
    const [client, session, meters, surfaces] = await Promise.all([
      context.injector.get(DataClientToken),
      context.injector.get(SessionToken),
      context.injector.get(MeterRegistryToken),
      context.injector.get(SurfaceManagerToken),
    ]);
    if (!client.ok) return client;
    if (!session.ok) return session;
    upgradeAction.set(async () => {
      const upgraded = await client.value.call(UpgradePlanEndpoint, { plan: 'pro' }, { signal: context.signal });
      if (!upgraded.ok) return false;
      await session.value.refresh(context.signal); // token rotation → new claims → epoch refresh
      return true;
    });
    context.scope.defer(() => upgradeAction.set(undefined));
    const meter = meters.ok ? meters.value.get(CreditsMeter) : undefined;
    if (meter?.ok === true && surfaces.ok) {
      let banner: SurfaceHandle | undefined;
      watch(
        () => meter.value.status,
        (status) => {
          if (status === 'low' || status === 'exhausted') {
            banner ??= surfaces.value.request(CreditBanner, { owner: ownerOf(context.injector), props: { credits: meter.value.available ?? 0 } });
          } else {
            banner?.dismiss('programmatic');
            banner = undefined;
          }
        },
        { scope: context.scope, fireImmediately: true },
      );
    }
    return ok();
  },
});
