/**
 * Bridge protocol types — the wire format shared between the MCP server and the PJSR
 * watcher running inside PixInsight. Ported from the reference `pixinsight-mcp` project
 * and adapted (bridge dir renamed to ~/.astropilot/bridge). See docs/bridge-protocol
 * and .plan/findings.md.
 */

/** A command written by the MCP server to `bridge/commands/<id>.json`. */
export interface BridgeCommand {
  /** Unique command id (UUID v4); also the result filename. */
  id: string;
  /** ISO 8601 creation time; the watcher refuses commands older than 10 minutes. */
  timestamp: string;
  /** Originating MCP tool name (e.g. "run_process", "run_script", "list_open_images"). */
  tool: string;
  /** PixInsight process class name, or a sentinel: "__internal__" / "__script__". */
  process: string;
  /** Tool-specific parameters; keys match PJSR property names for process settings. */
  parameters: Record<string, unknown>;
  /** How to execute a process instance. */
  executeMethod: ExecuteMethod;
  /** View id for `executeOn`; null for `executeGlobal`. */
  targetView: string | null;
}

export type ExecuteMethod = 'executeGlobal' | 'executeOn';

export type BridgeStatus = 'success' | 'error' | 'running';

/** A result written by the watcher to `bridge/results/<id>.json`. */
export interface BridgeResult {
  id: string;
  timestamp: string;
  status: BridgeStatus;
  /** Echo of the command's `process` (or a sentinel like "timeout"/"malformed-result"). */
  process: string;
  duration_ms: number;
  /** Tool-specific outputs; success results also carry `watcherRev`. */
  outputs?: Record<string, unknown>;
  message?: string;
  error?: BridgeError;
}

export interface BridgeError {
  message: string;
  type?: string;
  stack?: string;
}

/** MCP-server-side bridge configuration. */
export interface BridgeConfig {
  /** Bridge root; `~/` is expanded to the user's home. Contains commands/results/logs. */
  bridgeDir: string;
  /** Result-file poll interval in ms. */
  pollIntervalMs: number;
  /** Per-command timeout in ms. */
  defaultTimeoutMs: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  bridgeDir: '~/.astropilot/bridge',
  pollIntervalMs: 200,
  defaultTimeoutMs: 300_000,
};

/**
 * Watcher handler revision the server expects. Every success result echoes the watcher's
 * revision as `outputs.watcherRev`; the BridgeClient hard-errors on an older watcher so a
 * stale in-PixInsight script never silently misbehaves. Bump when watcher handlers change.
 */
export const EXPECTED_WATCHER_REV = 3;
