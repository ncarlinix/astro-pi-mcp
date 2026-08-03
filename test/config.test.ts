import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { DEFAULT_CONFIG } from '../src/types.js';

// A cwd with no astropilot.config.json so tests exercise defaults + env only.
const NO_FILE = { cwd: '/nonexistent-astropilot-cwd', env: {} as NodeJS.ProcessEnv };

describe('loadConfig', () => {
  it('applies schema defaults when nothing is provided', () => {
    const cfg = loadConfig({}, NO_FILE);
    expect(cfg.bridge.bridgeDir).toBe(DEFAULT_CONFIG.bridgeDir);
    expect(cfg.bridge.pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
    expect(cfg.bridge.defaultTimeoutMs).toBe(DEFAULT_CONFIG.defaultTimeoutMs);
    expect(cfg.logging.level).toBe('info');
    expect(cfg.pixInsightPath).toBeUndefined();
  });

  it('lets environment variables override defaults', () => {
    const env = {
      ASTROPILOT_BRIDGE_DIR: '/tmp/custom-bridge',
      ASTROPILOT_POLL_MS: '50',
      ASTROPILOT_TIMEOUT_MS: '1000',
      ASTROPILOT_LOG_LEVEL: 'debug',
      ASTROPILOT_PI_PATH: '/opt/PixInsight',
    } as unknown as NodeJS.ProcessEnv;
    const cfg = loadConfig({}, { cwd: NO_FILE.cwd, env });
    expect(cfg.bridge.bridgeDir).toBe('/tmp/custom-bridge');
    expect(cfg.bridge.pollIntervalMs).toBe(50);
    expect(cfg.bridge.defaultTimeoutMs).toBe(1000);
    expect(cfg.logging.level).toBe('debug');
    expect(cfg.pixInsightPath).toBe('/opt/PixInsight');
  });

  it('lets explicit overrides win over env', () => {
    const env = { ASTROPILOT_LOG_LEVEL: 'debug' } as unknown as NodeJS.ProcessEnv;
    const cfg = loadConfig({ logging: { level: 'silent' } }, { cwd: NO_FILE.cwd, env });
    expect(cfg.logging.level).toBe('silent');
  });

  it('throws a Zod error on an invalid log level', () => {
    const env = { ASTROPILOT_LOG_LEVEL: 'loud' } as unknown as NodeJS.ProcessEnv;
    expect(() => loadConfig({}, { cwd: NO_FILE.cwd, env })).toThrow();
  });

  it('throws on a non-positive poll interval', () => {
    expect(() => loadConfig({ bridge: { pollIntervalMs: 0 } }, NO_FILE)).toThrow();
  });
});
