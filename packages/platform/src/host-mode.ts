/**
 * Host modes as plugin bundles (R18.3a, R18.8–R18.10, R12.10).
 *
 * A host mode = detector + degraded capability profile + history strategy
 * (+ optional shell preset, host bridge). New modes (browser extension,
 * Electron/Tauri, TV, …) are added without touching this package:
 *
 *   declare module '@staticflux/platform' {
 *     interface HostModeRegistry { 'browser-extension': true }
 *   }
 *   export const extensionMode = defineHostMode({
 *     id: 'browser-extension', priority: 95,
 *     detect: (env) => readGlobal(env, 'chrome') !== undefined && …,
 *     capabilities: { serviceWorker: false },
 *     historyStrategy: 'memory',
 *   });
 */
import type { Result } from '@staticflux/core';
import type { PlatformEnv } from './env.js';
import {
  detectEmbedAgentHost,
  detectEmbedIframe,
  detectPwa,
  detectWebviewAndroid,
  detectWebviewIos,
  type HostModeId,
  type ModeDetector,
} from './detect-mode.js';
import type { CapabilityName } from './facts.js';

/** Open set of history strategies (implemented by the router, R18.9). */
export interface HistoryStrategyRegistry {
  /** Navigation API with History API fallback. */
  'navigation-api': true;
  /** In-memory history kept in sync with the host (embedded modes). */
  'memory-host-synced': true;
  /** Plain in-memory history. */
  memory: true;
  /** In-memory history plus the native back button via the host bridge (Android webview). */
  'native-back-bridge': true;
}
export type HistoryStrategyId = keyof HistoryStrategyRegistry & string;

/** Open set of shell presets (implemented by the shell). */
export interface ShellPresetRegistry {
  full: true;
  standalone: true;
  embedded: true;
  chromeless: true;
  /** One screen naming what is missing (`unsupportedHostMode`). */
  unsupported: true;
}
export type ShellPresetId = keyof ShellPresetRegistry & string;

/**
 * A host's capability restrictions. `false` forbids a capability in this host
 * even if detection says it exists; omitted means "use detection".
 */
export type HostCapabilityProfile = { readonly [K in CapabilityName]?: false } & {
  /** Safe-area insets must be respected (notches, host chrome). */
  readonly insets?: boolean;
};

/** Transport to the embedding host (iframe postMessage, MCP Apps bridge, native JS interface). */
export interface HostBridge {
  readonly id: string;
  send(message: unknown): Result<void>;
  /** Returns unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void;
  dispose(): void;
}

export interface HostModeDefinition<Id extends HostModeId = HostModeId> extends ModeDetector {
  readonly id: Id;
  readonly priority: number;
  detect(env: PlatformEnv): boolean;
  readonly capabilities: HostCapabilityProfile;
  readonly historyStrategy: HistoryStrategyId;
  readonly shellPreset?: ShellPresetId;
  /** Lazily loaded (code for other modes is never fetched, R12.10). */
  readonly bridge?: (signal: AbortSignal) => Promise<Result<HostBridge>>;
  readonly description?: string;
}

/* @__NO_SIDE_EFFECTS__ */
export function defineHostMode<const Id extends HostModeId>(definition: HostModeDefinition<Id>): HostModeDefinition<Id> {
  return definition;
}

export const webHostMode = defineHostMode({
  id: 'web',
  priority: 0,
  detect: () => true,
  capabilities: {},
  historyStrategy: 'navigation-api',
  shellPreset: 'full',
  description: 'Regular browser tab.',
});

export const pwaHostMode = defineHostMode({
  id: 'pwa',
  priority: 60,
  detect: detectPwa,
  capabilities: { insets: true },
  historyStrategy: 'navigation-api',
  shellPreset: 'standalone',
  description: 'Installed web app (standalone / fullscreen / window-controls-overlay display).',
});

export const embedIframeHostMode = defineHostMode({
  id: 'embed-iframe',
  priority: 70,
  detect: detectEmbedIframe,
  // Third-party frames: storage partitioned or blocked, SW scoped to the frame origin, no install.
  capabilities: { serviceWorker: false, popups: false, install: false, notifications: false },
  historyStrategy: 'memory-host-synced',
  shellPreset: 'embedded',
  description: 'Embedded in a third-party page via <iframe>.',
});

export const embedAgentHostMode = defineHostMode({
  id: 'embed-agent-host',
  priority: 80,
  detect: detectEmbedAgentHost,
  capabilities: {
    serviceWorker: false,
    sharedWorker: false,
    popups: false,
    install: false,
    notifications: false,
    webAuthn: false,
    share: false,
  },
  historyStrategy: 'memory-host-synced',
  shellPreset: 'chromeless',
  description: 'Rendered inside an agent host (ChatGPT Apps / MCP Apps frame).',
});

export const webviewIosHostMode = defineHostMode({
  id: 'webview-ios',
  priority: 85,
  detect: detectWebviewIos,
  // WKWebView: no SW unless app-bound domains, no install, no web notifications.
  capabilities: { serviceWorker: false, install: false, notifications: false, insets: true },
  historyStrategy: 'memory',
  shellPreset: 'chromeless',
  description: 'iOS WKWebView inside a native app.',
});

export const webviewAndroidHostMode = defineHostMode({
  id: 'webview-android',
  priority: 90,
  detect: detectWebviewAndroid,
  capabilities: { install: false, notifications: false, webAuthn: false, popups: false },
  historyStrategy: 'native-back-bridge',
  shellPreset: 'chromeless',
  description: 'Android System WebView inside a native app.',
});

export const BUILT_IN_HOST_MODES: readonly HostModeDefinition[] = [
  webHostMode,
  pwaHostMode,
  embedIframeHostMode,
  embedAgentHostMode,
  webviewIosHostMode,
  webviewAndroidHostMode,
];
