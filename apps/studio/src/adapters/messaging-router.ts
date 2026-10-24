/**
 * Adapter: @staticflux/messaging routable-dialog bridge → @staticflux/router
 * `DialogSurfacePort` (R7.16–R7.21). The router owns the URL (`…/d/<key>`) and the
 * light dialog pipeline; messaging owns rendering, focus and arbitration. User
 * dismissals come back as `request.dismiss()` so the router does back/replace (R7.18).
 */
import { err, ok, toSfError, unit } from '@staticflux/core';
import { RoutableDialogBridgeToken } from '@staticflux/messaging';
import { type DialogSurfacePort, DialogSurfacePortToken, type DialogOpenRequest } from '@staticflux/router';

export const routableDialogPortUnit = unit({
  id: 'studio/routable-dialog-port-unit',
  provides: DialogSurfacePortToken,
  scope: 'app',
  deps: { required: { bridge: RoutableDialogBridgeToken } },
  create: ({ bridge }, ctx): DialogSurfacePort => {
    let current: DialogOpenRequest | undefined;
    ctx.scope.defer(
      bridge.onDismissIntent((intent) => {
        if (current !== undefined && current.dialog.key === intent.key) current.dismiss();
      }),
    );
    return {
      async open(request, navigationSignal) {
        // The surface lives as long as the dialog scope; the navigation signal only bounds the load.
        const signal = request.scope.signal;
        if (navigationSignal.aborted) return err(toSfError(navigationSignal.reason));
        const source = request.navigation.trigger === 'initial' || request.navigation.external ? 'deep-link' : 'in-app';
        const params: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.match.params as Readonly<Record<string, string>>)) params[key] = value;
        const opened = await bridge.openDialog(request.dialog.key, params, { source, owner: { scope: request.scope, level: 'route' }, signal });
        if (!opened.ok) return err(opened.error);
        current = request;
        request.scope.defer(() => {
          if (current === request) current = undefined;
        });
        return ok({
          close: () => {
            if (current === request) current = undefined;
            bridge.closeDialog(request.dialog.key, 'navigation');
          },
        });
      },
    };
  },
  description: 'Router dialog surface port over the messaging routable-dialog bridge.',
});
