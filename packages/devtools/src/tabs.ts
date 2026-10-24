/** Panel tabs (shared by the installer and the lazy panel without importing Lit). */
export const DEVTOOLS_TABS = [
  'boot',
  'journeys',
  'graph',
  'lifecycles',
  'decisions',
  'stores',
  'violations',
  'metrics',
  'settings',
] as const;

export type DevtoolsTab = (typeof DEVTOOLS_TABS)[number];

export const TAB_LABELS: Readonly<Record<DevtoolsTab, string>> = {
  boot: 'Boot',
  journeys: 'Journeys',
  graph: 'Graph',
  lifecycles: 'Lifecycles',
  decisions: 'Decisions',
  stores: 'Stores',
  violations: 'Violations',
  metrics: 'Metrics',
  settings: 'Settings',
};

export function isDevtoolsTab(value: unknown): value is DevtoolsTab {
  return typeof value === 'string' && (DEVTOOLS_TABS as readonly string[]).includes(value);
}
