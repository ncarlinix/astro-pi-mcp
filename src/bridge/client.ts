import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  DEFAULT_CONFIG,
  EXPECTED_WATCHER_REV,
  type BridgeCommand,
  type BridgeConfig,
  type BridgeResult,
} from '../types.js';
import type { SendOptions } from '../backend/types.js';

/** Minimal logger surface (Pino-compatible); defaults to a no-op so tests need no logger. */
export interface BridgeLogger {
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

const noopLogger: BridgeLogger = { warn: () => {}, error: () => {} };

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lenient result shape check — the watcher is trusted local code, so we only guard the
 *  fields the client relies on; anything failing this is treated as a malformed result. */
const bridgeResultSchema = z.object({
  id: z.string(),
  status: z.enum(['success', 'error', 'running']),
  outputs: z.record(z.unknown()).optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
});

const STALE_MS = 600_000; // 10 minutes, matches the watcher's refusal window.
const MALFORMED_GRACE_MS = 2000;

/**
 * Owns the file-bridge protocol: atomic command writes, result polling with timeout and
 * malformed-result fail-fast, watcher-liveness ping, version-skew detection, and stale
 * command/result reaping. Ported from the reference `pixinsight-mcp` project and adapted
 * to the AstroPilot bridge dir, an injectable logger, and Zod result validation.
 */
export class BridgeClient {
  private config: BridgeConfig;
  private commandsDir: string;
  private resultsDir: string;
  private logsDir: string;
  private log: BridgeLogger;
  private revWarned = false;

  constructor(config?: Partial<BridgeConfig>, logger: BridgeLogger = noopLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const bridgeDir = expandHome(this.config.bridgeDir);
    this.commandsDir = join(bridgeDir, 'commands');
    this.resultsDir = join(bridgeDir, 'results');
    this.logsDir = join(bridgeDir, 'logs');
    this.log = logger;
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.commandsDir, { recursive: true });
    await mkdir(this.resultsDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
  }

  async sendCommand(
    tool: string,
    process: string,
    parameters: Record<string, unknown>,
    options?: SendOptions,
  ): Promise<BridgeResult> {
    await this.ensureDirectories();

    const id = randomUUID();
    const command: BridgeCommand = {
      id,
      timestamp: new Date().toISOString(),
      tool,
      process,
      parameters,
      executeMethod: options?.executeMethod ?? 'executeGlobal',
      targetView: options?.targetView ?? null,
    };

    // Atomic write: "<id>.tmp" (outside the watcher's *.json glob) then rename, so the
    // watcher never picks up a partially written command file.
    const commandPath = join(this.commandsDir, `${id}.json`);
    const tmpPath = join(this.commandsDir, `${id}.tmp`);
    await writeFile(tmpPath, JSON.stringify(command, null, 2), 'utf-8');
    await rename(tmpPath, commandPath);

    const timeoutMs = options?.timeoutMs ?? this.config.defaultTimeoutMs;
    const result = await this.waitForResult(id, process, timeoutMs);
    return this.checkWatcherRev(result);
  }

  /**
   * Version-skew handling. Only success results carry `outputs.watcherRev`. A watcher
   * OLDER than this server is dangerous (the server may rely on handler behavior it
   * lacks), so every command hard-errors with fix instructions. A NEWER watcher only gets
   * a one-time warning appended to the result (stderr is near-invisible in an agent
   * session, so the warning also rides in the result the agent reads).
   */
  private checkWatcherRev(result: BridgeResult): BridgeResult {
    if (result.status !== 'success') return result;
    const rev = (result.outputs as Record<string, unknown> | undefined)?.watcherRev;
    if (rev === EXPECTED_WATCHER_REV) return result;

    const reinstall =
      'Update pjsr/astropilot-watcher.js in PixInsight and re-run it (F9), then restart ' +
      'the MCP server.';

    if (rev === undefined || Number(rev) < EXPECTED_WATCHER_REV) {
      const detail =
        rev === undefined
          ? 'predates watcher-revision reporting'
          : `reports watcher revision ${String(rev)}, this server expects ${EXPECTED_WATCHER_REV}`;
      if (!this.revWarned) {
        this.revWarned = true;
        this.log.error(`installed AstroPilot watcher ${detail}. ${reinstall}`);
      }
      return {
        id: result.id,
        timestamp: result.timestamp,
        status: 'error',
        process: result.process,
        duration_ms: result.duration_ms,
        error: {
          message:
            `The command ran, but the installed AstroPilot watcher ${detail}, so this ` +
            `server cannot trust its handler behavior. ${reinstall}`,
          type: 'WatcherRevisionMismatch',
        },
      };
    }

    // Watcher newer than server: warn once, in the result the agent actually reads.
    if (!this.revWarned) {
      this.revWarned = true;
      const note =
        `installed watcher reports revision ${String(rev)}, this server expects ` +
        `${EXPECTED_WATCHER_REV}; the watcher is newer, update the MCP server.`;
      this.log.warn(note);
      result.message = (result.message ? result.message + '\n' : '') + 'WARNING: ' + note;
    }
    return result;
  }

  private async waitForResult(
    id: string,
    process: string,
    timeoutMs: number,
  ): Promise<BridgeResult> {
    const resultPath = join(this.resultsDir, `${id}.json`);
    const startTime = Date.now();
    // A result file that exists but won't parse is either (a) a partial write caught
    // mid-flight (transient — retry briefly) or (b) a genuinely malformed result
    // (permanent). Give a short grace for (a), then surface (b) instead of polling to the
    // full timeout.
    let unparseableSince: number | null = null;

    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(resultPath)) {
        await sleep(50); // let the file settle
        let data: string;
        try {
          data = await readFile(resultPath, 'utf-8');
        } catch {
          await sleep(this.config.pollIntervalMs);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          if (unparseableSince === null) unparseableSince = Date.now();
          if (Date.now() - unparseableSince < MALFORMED_GRACE_MS) {
            await sleep(this.config.pollIntervalMs);
            continue;
          }
          try {
            await unlink(resultPath);
          } catch {
            /* ignore */
          }
          return this.malformed(id, startTime, data);
        }

        const validated = bridgeResultSchema.safeParse(parsed);
        if (!validated.success) {
          try {
            await unlink(resultPath);
          } catch {
            /* ignore */
          }
          return this.malformed(id, startTime, data);
        }
        unparseableSince = null;

        const result = parsed as BridgeResult;
        // "running" ack: the watcher picked the command up; keep polling for the terminal
        // result.
        if (result.status === 'running') {
          await sleep(this.config.pollIntervalMs);
          continue;
        }

        try {
          await unlink(resultPath);
        } catch {
          /* ignore */
        }
        return result;
      }
      await sleep(this.config.pollIntervalMs);
    }

    return {
      id,
      timestamp: new Date().toISOString(),
      status: 'error',
      process: 'timeout',
      duration_ms: Date.now() - startTime,
      error: {
        message: `Command timed out after ${timeoutMs}ms. The AstroPilot watcher may not be running in PixInsight (open pjsr/astropilot-watcher.js and run it with F9).`,
        type: 'Timeout',
      },
    };
  }

  private malformed(id: string, startTime: number, raw: string): BridgeResult {
    return {
      id,
      timestamp: new Date().toISOString(),
      status: 'error',
      process: 'malformed-result',
      duration_ms: Date.now() - startTime,
      error: {
        message:
          'The watcher delivered a result that is not valid JSON (or is missing required ' +
          'fields); the command likely ran but its result was corrupted. Verify the image ' +
          'state before retrying. Raw result (truncated): ' +
          JSON.stringify(raw.slice(0, 200)),
        type: 'MalformedResult',
      },
    };
  }

  /** Liveness probe: a cheap list_open_images with a short timeout. */
  async isWatcherAlive(): Promise<boolean> {
    try {
      const result = await this.sendCommand('list_open_images', '__internal__', {}, {
        timeoutMs: 5000,
      });
      return result.status === 'success';
    } catch {
      return false;
    }
  }

  /** Reap leftovers from dead sessions in both commands/ and results/. Returns count. */
  async cleanStaleCommands(): Promise<number> {
    let cleaned = 0;
    try {
      for (const file of await readdir(this.commandsDir)) {
        const filePath = join(this.commandsDir, file);
        if (file.endsWith('.json')) {
          try {
            const data = await readFile(filePath, 'utf-8');
            const cmd = JSON.parse(data) as BridgeCommand;
            if (Date.now() - new Date(cmd.timestamp).getTime() > STALE_MS) {
              await unlink(filePath);
              cleaned++;
            }
          } catch {
            await unlink(filePath); // malformed → remove
            cleaned++;
          }
        } else if (file.endsWith('.tmp')) {
          // Orphan from a crash between write and rename; no timestamp inside → use mtime.
          try {
            const { mtimeMs } = await stat(filePath);
            if (Date.now() - mtimeMs > STALE_MS) {
              await unlink(filePath);
              cleaned++;
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* commandsDir unreadable; still try results below */
    }
    try {
      for (const file of await readdir(this.resultsDir)) {
        if (!file.endsWith('.json') && !file.endsWith('.tmp')) continue;
        const filePath = join(this.resultsDir, file);
        try {
          const { mtimeMs } = await stat(filePath);
          if (Date.now() - mtimeMs > STALE_MS) {
            await unlink(filePath);
            cleaned++;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return cleaned;
  }

  getConfig(): BridgeConfig {
    return { ...this.config };
  }
}
