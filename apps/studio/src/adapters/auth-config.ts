/**
 * Adapter: @staticflux/auth (+ platform facts) → @staticflux/config evaluation context.
 * Non-pre-auth-safe flags skip identity-bound layers until `authenticated` (R8.5).
 */
import { unit } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { derivedContext, EvaluationContextToken } from '@staticflux/config';
import { AppProfileToken } from '@staticflux/platform';

export const sessionEvaluationContextUnit = unit({
  id: 'studio/evaluation-context-unit',
  provides: EvaluationContextToken,
  scope: 'app',
  deps: { required: { session: SessionToken, profile: AppProfileToken } },
  create: ({ session, profile }) =>
    derivedContext(() => ({
      authenticated: session.isAuthenticated,
      context: {
        targetingKey: session.principal?.id ?? session.guestId,
        hostMode: profile.current.hostMode,
        formFactor: profile.current.formFactor,
      },
    })),
  description: 'Evaluation context from the session principal and the app profile.',
});
