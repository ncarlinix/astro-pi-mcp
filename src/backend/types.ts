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
}

export interface SendOptions {
  executeMethod?: ExecuteMethod;
  targetView?: string | null;
  timeoutMs?: number;
}
