/**
 * The Export panel under Clean Pop (happy-dom): kit controls only, the a11y audit, the choice (format, scale for PNG
 * only, scope, transparent), Export / Cancel, the status line, and binding to the export service's port.
 */
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from './formats.js';
import { bindExportPanel, defineExportPanel, EXPORT_CANCEL_EVENT, EXPORT_PANEL_ID, EXPORT_RUN_EVENT, exportPanel, formatBytes, type IfExportPanelElement, statusText } from './panel.js';
import type { ExportStatus } from './service.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineExportPanel());

afterEach(async () => {
  const d = dispose;
  dispose = undefined;
  await d?.();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount(status: ExportStatus = { kind: 'idle' }): Promise<{ panel: IfExportPanelElement; root: ShadowRoot; runs: ExportOptions[]; cancels: number[] }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const test = mountTestRoot({ units: [] });
  dispose = () => test.dispose();
  render(html`<if-export-panel .status=${status}></if-export-panel>`, test.container);
  await settle();
  const panel = test.container.querySelector('if-export-panel') as IfExportPanelElement;
  const runs: ExportOptions[] = [];
  const cancels: number[] = [];
  panel.addEventListener(EXPORT_RUN_EVENT, (e) => runs.push((e as CustomEvent<ExportOptions>).detail));
  panel.addEventListener(EXPORT_CANCEL_EVENT, () => cancels.push(1));
  await settle();
  return { panel, root: panel.shadowRoot as ShadowRoot, runs, cancels };
}

const control = (root: ShadowRoot, name: string): HTMLElement => {
  const found = root.querySelector(`[data-control="${name}"]`);
  if (found === null) throw new Error(`no control ${name}`);
  return found as HTMLElement;
};
const change = (el: HTMLElement, value: string): boolean => el.dispatchEvent(new CustomEvent('sf-change', { detail: { value } }));

describe('<if-export-panel>', () => {
  it('renders the choice from kit components, accessibly, and exports with it', async () => {
    const { panel, root, runs } = await mount();
    expect(root.querySelectorAll('sf-segmented')).toHaveLength(3); // format, scale (PNG), scope
    expect(control(root, 'export').textContent?.trim()).toBe('Export PNG');
    expect(control(root, 'status').textContent).toContain('change nothing');
    expectNoA11yIssues(root);
    change(control(root, 'format'), 'pdf');
    await settle();
    expect(root.querySelector('[data-control="scale"]')).toBeNull(); // vector: no scale
    change(control(root, 'scope'), 'pages');
    control(root, 'transparent').click();
    await settle();
    control(root, 'export').click();
    panel.exportNow();
    expect(runs).toEqual([
      { ...DEFAULT_EXPORT_OPTIONS, format: 'pdf', scope: 'pages', transparent: true },
      { ...DEFAULT_EXPORT_OPTIONS, format: 'pdf', scope: 'pages', transparent: true },
    ]);
    change(control(root, 'format'), 'png');
    await settle();
    change(control(root, 'scale'), '3');
    await settle();
    expect(panel.options.scale).toBe(3);
  });

  it('shows progress with Cancel while running, then the files or the failure', async () => {
    const running = await mount({ kind: 'running', options: { ...DEFAULT_EXPORT_OPTIONS, scope: 'pages' }, progress: { state: 'rendering', fraction: 0.4, page: 0, pages: 2 } });
    expect(control(running.root, 'status').textContent).toContain('Exporting PNG page 1 of 2 · 40%');
    expect(running.root.querySelector('[data-control="export"]')).toBeNull();
    control(running.root, 'cancel').click();
    expect(running.cancels).toHaveLength(1);
    expectNoA11yIssues(running.root);
    expect(statusText({ kind: 'done', options: DEFAULT_EXPORT_OPTIONS, files: [{ name: 'Flyer.png', mime: 'image/png', size: 24_576 }], missingImages: ['as_x'] }).text).toBe('Exported Flyer.png (24 KB) · 1 image missing');
    expect(statusText({ kind: 'done', options: DEFAULT_EXPORT_OPTIONS, files: [{ name: 'a', mime: 'x', size: 1 }, { name: 'b', mime: 'x', size: 1 }], missingImages: [] }).text).toBe('Exported 2 files');
    expect(statusText({ kind: 'failed', options: DEFAULT_EXPORT_OPTIONS, message: 'No GPU.', code: 'IF-EXP-005' })).toEqual({ text: 'Export failed: No GPU.', tone: 'danger', busy: false });
    expect(statusText({ kind: 'cancelled', options: DEFAULT_EXPORT_OPTIONS }).text).toBe('Export cancelled.');
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('binds to the export service: status in, runs and cancels out, unbinds', async () => {
    const { panel } = await mount();
    let status: ExportStatus = { kind: 'idle' };
    const listeners = new Set<() => void>();
    const runs: ExportOptions[] = [];
    let cancels = 0;
    const unbind = bindExportPanel(panel, {
      status: () => status,
      subscribe: (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      run: (o) => void runs.push(o),
      cancel: () => void (cancels += 1),
    });
    status = { kind: 'cancelled', options: DEFAULT_EXPORT_OPTIONS };
    for (const l of listeners) l();
    expect(panel.status.kind).toBe('cancelled');
    panel.exportNow();
    panel.dispatchEvent(new CustomEvent(EXPORT_CANCEL_EVENT));
    unbind();
    panel.exportNow();
    expect(runs).toHaveLength(1);
    expect(cancels).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it('is a dock panel contribution', () => {
    expect(exportPanel.id).toBe(EXPORT_PANEL_ID);
    expect(exportPanel.placements).toContain('dock');
  });
});
