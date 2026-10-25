/**
 * One tab of the leader-kill scenario: starts the store worker and, unless
 * `?mode=verify`, commits every ~`rate` ms (editing one page at a time).
 * Reports worker messages to the scenario through `window.__report`.
 */
export {};

const query = new URLSearchParams(location.search);
const ws = query.get('ws') ?? 'ws_manual';
const verify = query.get('mode') === 'verify';
const rate = Number(query.get('rate') ?? 10);
const peer = `p${crypto.randomUUID().slice(0, 8)}`;

type Page = Window & {
  __report?: (message: Record<string, unknown>) => void;
  __stop?: () => void;
  __pending?: () => Promise<number>;
};
const page = window as Page;
const report = (message: Record<string, unknown>): void => page.__report?.({ ...message, peer });

const worker = new Worker(new URL('./leader-tab.worker.ts', import.meta.url), { type: 'module' });
let pendingReply: ((n: number) => void) | undefined;
worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
  if (event.data['type'] === 'pending') {
    pendingReply?.(Number(event.data['n']));
    return;
  }
  report(event.data);
};
worker.postMessage({ type: 'init', ws, peer, verify, compactMs: Number(query.get('compact') ?? 50) });

let stopped = false;
page.__stop = () => {
  stopped = true;
};
page.__pending = () =>
  new Promise<number>((resolve) => {
    pendingReply = resolve;
    worker.postMessage({ type: 'pending' });
  });

if (!verify) {
  let k = 0;
  let hot = 0;
  const generate = (): void => {
    if (stopped) return;
    if (k % 50 === 0) hot = Math.floor(Math.random() * 40);
    worker.postMessage({ type: 'commit', c: { id: `${peer}:${k}`, part: `page:${hot}` } });
    k += 1;
    setTimeout(generate, rate * (0.5 + Math.random()));
  };
  setTimeout(generate, 50);
}
report({ type: 'hello', verify });
