import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configSchema, type Config } from './schema.js';

/** Deep-partial config as it may appear in a JSON file or programmatic override. */
export type ConfigInput = {
  bridge?: Partial<Config['bridge']>;
  logging?: Partial<Config['logging']>;
  pixInsightPath?: string;
};

const CONFIG_FILENAME = 'astropilot.config.json';

function readConfigFile(cwd: string): ConfigInput {
  try {
    const raw = readFileSync(resolve(cwd, CONFIG_FILENAME), 'utf-8');
    return JSON.parse(raw) as ConfigInput;
  } catch {
    // No file (or unreadable) → rely on defaults + env. A malformed file surfaces later
    // via Zod if it produced bad types; a missing file is the normal case.
    return {};
  }
}

/** Environment overrides. Each is applied only when set, so it wins over file + defaults. */
function envOverrides(env: NodeJS.ProcessEnv): ConfigInput {
  const bridge: Partial<Config['bridge']> = {};
  if (env.ASTROPILOT_BRIDGE_DIR) bridge.bridgeDir = env.ASTROPILOT_BRIDGE_DIR;
  if (env.ASTROPILOT_POLL_MS) bridge.pollIntervalMs = Number(env.ASTROPILOT_POLL_MS);
  if (env.ASTROPILOT_TIMEOUT_MS) bridge.defaultTimeoutMs = Number(env.ASTROPILOT_TIMEOUT_MS);

  const logging: Partial<Config['logging']> = {};
  if (env.ASTROPILOT_LOG_LEVEL) {
    logging.level = env.ASTROPILOT_LOG_LEVEL as Config['logging']['level'];
  }

  const out: ConfigInput = {};
  if (Object.keys(bridge).length) out.bridge = bridge;
  if (Object.keys(logging).length) out.logging = logging;
  if (env.ASTROPILOT_PI_PATH) out.pixInsightPath = env.ASTROPILOT_PI_PATH;
  return out;
}

function merge(...sources: ConfigInput[]): ConfigInput {
  const out: ConfigInput = {};
  for (const s of sources) {
    if (s.bridge) out.bridge = { ...out.bridge, ...s.bridge };
    if (s.logging) out.logging = { ...out.logging, ...s.logging };
    if (s.pixInsightPath !== undefined) out.pixInsightPath = s.pixInsightPath;
  }
  return out;
}

/**
 * Load and validate configuration. Precedence (lowest → highest):
 * schema defaults → astropilot.config.json → environment variables → explicit overrides.
 */
export function loadConfig(
  overrides: ConfigInput = {},
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Config {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const merged = merge(readConfigFile(cwd), envOverrides(env), overrides);
  return configSchema.parse(merged);
}
