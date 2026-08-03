import { BridgeClient, type BridgeLogger } from '../bridge/client.js';
import type { BridgeConfig, BridgeResult } from '../types.js';
import type { ProcessingBackend, SendOptions } from './types.js';

/**
 * PixInsight backend — a thin adapter from the generic ProcessingBackend interface to the
 * file-bridge BridgeClient. Attach model: it never launches PixInsight; the user runs the
 * PJSR watcher inside their own PixInsight session.
 */
export class PixInsightBackend implements ProcessingBackend {
  readonly id = 'pixinsight';
  private client: BridgeClient;

  constructor(config?: Partial<BridgeConfig>, logger?: BridgeLogger) {
    this.client = new BridgeClient(config, logger);
  }

  /** Reap stale bridge files left by dead sessions. Call once at startup. */
  async init(): Promise<number> {
    await this.client.ensureDirectories();
    return this.client.cleanStaleCommands();
  }

  isAlive(): Promise<boolean> {
    return this.client.isWatcherAlive();
  }

  /** Stop the in-PixInsight PJSR watcher (writes the shutdown sentinel it polls for). */
  stopWatcher(timeoutMs?: number): Promise<boolean> {
    return this.client.stopWatcher(timeoutMs);
  }

  send(
    tool: string,
    process: string,
    parameters: Record<string, unknown>,
    options?: SendOptions,
  ): Promise<BridgeResult> {
    return this.client.sendCommand(tool, process, parameters, options);
  }
}
