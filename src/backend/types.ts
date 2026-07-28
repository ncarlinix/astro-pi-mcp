import type { BridgeResult, ExecuteMethod } from '../types.js';

/**
 * A processing backend AstroPilot can drive. PixInsight is the first implementation
 * (a thin wrapper over the file-bridge BridgeClient); future backends — Siril, GraXpert,
 * etc. (Stage 19) — implement this same interface and register in the registry.
 */
export interface ProcessingBackend {
  /** Stable identifier, e.g. "pixinsight". */
  readonly id: string;

  /** Is the backend reachable right now? (For PixInsight: is the watcher responding?) */
  isAlive(): Promise<boolean>;

  /**
   * Send one command and await its terminal result. Mirrors BridgeClient.sendCommand so
   * the MCP tool layer can depend on the interface, not the concrete client.
   */
  send(
    tool: string,
    process: string,
    parameters: Record<string, unknown>,
    options?: SendOptions,
  ): Promise<BridgeResult>;

  /**
   * Cleanly stop the backend's in-app agent (for PixInsight: the PJSR watcher), freeing the
   * app's UI. Optional — backends without a long-running in-app agent may omit it. Returns
   * true if the agent stopped within the timeout.
   */
  stopWatcher?(timeoutMs?: number): Promise<boolean>;
}

export interface SendOptions {
  executeMethod?: ExecuteMethod;
  targetView?: string | null;
  timeoutMs?: number;
}
