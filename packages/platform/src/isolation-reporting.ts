/**
 * Dev-mode COEP/COOP violation reporting (R11.16b, R17.22). Feature-detects
 * `ReportingObserver` (Chromium; absent in Safari/Firefox → `supported: false`) and
 * turns each `coep` / `coop` report into ONE conformance `violation` telemetry event
 * (the @staticflux/perf conformance contract: `attrs: { code, fix, severity, message, details }`),
 * with request attribution (blocked URL, destination) and, when an `attribute` port is
 * given, element attribution.
 */
import type { Attrs, Scope, Telemetry } from '@staticflux/core';
import { type PlatformEnv, readGlobal } from './env.js';
import { CoepViolationError, CoopViolationError } from './errors.js';

export const VIOLATION_EVENT_NAME = 'violation' as const;
export const ISOLATION_SUBSYSTEM = 'platform/isolation' as const;

export interface ReportLike {
  readonly type: string;
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>> | null;
}

export interface ReportingObserverLike {
  observe(): void;
  disconnect(): void;
}

export type ReportingObserverConstructor = new (
  callback: (reports: readonly ReportLike[]) => void,
  options: { readonly types?: readonly string[]; readonly buffered?: boolean },
) => ReportingObserverLike;

export interface IsolationViolation {
  readonly code: 'SF-PLAT-007' | 'SF-PLAT-008';
  readonly fix: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly details: Readonly<Record<string, unknown>>;
}

export interface IsolationReportingOptions {
  readonly env: PlatformEnv;
  readonly telemetry: Telemetry;
  readonly scope: Scope;
  /** Only runs in dev (default true; pass `false` in production builds). */
  readonly dev?: boolean;
  /** Element attribution (e.g. a `[src="…"]` query in the app); omitted when unknown. */
  readonly attribute?: (blockedUrl: string) => string | undefined;
  readonly onViolation?: (violation: IsolationViolation) => void;
}

export interface IsolationReporting {
  readonly supported: boolean;
  readonly count: number;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function fixFor(destination: string | undefined, blockedUrl: string | undefined): string {
  switch (destination) {
    case 'iframe':
    case 'frame':
      return `Embed ${blockedUrl ?? 'the frame'} with \`policy.iframeAttrs(url)\` (adds \`credentialless\` where supported), or have it served with COEP + CORP.`;
    case 'worker':
    case 'sharedworker':
    case 'serviceworker':
      return 'Worker scripts must be same-origin (or CORS) and served with a matching Cross-Origin-Embedder-Policy.';
    default:
      return CoepViolationError.fix;
  }
}

/** Map one report to a violation (undefined for unrelated report types). */
export function violationFromReport(report: ReportLike, attribute?: (url: string) => string | undefined): IsolationViolation | undefined {
  const body = report.body ?? {};
  const disposition = str(body['disposition']);
  const severity = disposition === 'reporting' ? 'warning' : 'error';
  if (report.type === 'coep') {
    const blockedUrl = str(body['blockedURL']) ?? str(body['blockedUrl']);
    const destination = str(body['destination']);
    const element = blockedUrl === undefined ? undefined : attribute?.(blockedUrl);
    return {
      code: CoepViolationError.code as 'SF-PLAT-007',
      fix: fixFor(destination, blockedUrl),
      message: `COEP ${severity === 'warning' ? 'would block' : 'blocked'} ${destination ?? 'a resource'}${blockedUrl === undefined ? '' : ` ${blockedUrl}`}.`,
      severity,
      details: {
        page: report.url,
        kind: str(body['type']) ?? 'corp',
        ...(blockedUrl === undefined ? {} : { blockedUrl }),
        ...(destination === undefined ? {} : { destination }),
        ...(disposition === undefined ? {} : { disposition }),
        ...(element === undefined ? {} : { element }),
      },
    };
  }
  if (report.type === 'coop') {
    const kind = str(body['type']);
    return {
      code: CoopViolationError.code as 'SF-PLAT-008',
      fix: CoopViolationError.fix,
      message: `COOP ${severity === 'warning' ? 'would sever' : 'severed'} an opener relationship (${kind ?? 'unknown'}).`,
      severity,
      details: {
        page: report.url,
        ...(kind === undefined ? {} : { kind }),
        ...(disposition === undefined ? {} : { disposition }),
        ...(str(body['effectivePolicy']) === undefined ? {} : { effectivePolicy: str(body['effectivePolicy']) as string }),
      },
    };
  }
  return undefined;
}

/** Emit a violation in the conformance event format. */
export function reportIsolationViolation(telemetry: Telemetry, violation: IsolationViolation): void {
  const attrs: Attrs = {
    code: violation.code,
    fix: violation.fix,
    severity: violation.severity,
    message: violation.message,
    details: JSON.stringify(violation.details),
  };
  telemetry.event(VIOLATION_EVENT_NAME, { subsystem: ISOLATION_SUBSYSTEM, level: 'critical', attrs });
}

export function startIsolationReporting(options: IsolationReportingOptions): IsolationReporting {
  let count = 0;
  const Observer = readGlobal(options.env, 'ReportingObserver') as ReportingObserverConstructor | undefined;
  if (options.dev === false || typeof Observer !== 'function') {
    return { supported: false, count: 0 };
  }
  let observer: ReportingObserverLike;
  try {
    observer = new Observer(
      (reports) => {
        for (const report of reports) {
          const violation = violationFromReport(report, options.attribute);
          if (violation === undefined) continue;
          count += 1;
          reportIsolationViolation(options.telemetry, violation);
          options.onViolation?.(violation);
        }
      },
      { types: ['coep', 'coop'], buffered: true },
    );
    observer.observe();
  } catch {
    return { supported: false, count: 0 };
  }
  options.scope.defer(() => observer.disconnect());
  return {
    supported: true,
    get count() {
      return count;
    },
  };
}
