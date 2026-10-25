/** Listeners bound to an element's connection (rule 5: every listener has a signal). */
import type { ReactiveController, ReactiveControllerHost } from 'lit';

/**
 * Install listeners on connect and remove them on disconnect: `install(signal)` runs on every
 * connection; pass `{ signal }` to every `addEventListener`.
 */
export class ConnectedListeners implements ReactiveController {
  private connection: AbortController | undefined;

  constructor(
    host: ReactiveControllerHost,
    private readonly install: (signal: AbortSignal) => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connection?.abort();
    this.connection = new AbortController();
    this.install(this.connection.signal);
  }

  hostDisconnected(): void {
    this.connection?.abort();
    this.connection = undefined;
  }

  /** The current connection's signal (aborted after disconnect). */
  get signal(): AbortSignal | undefined {
    return this.connection?.signal;
  }
}
