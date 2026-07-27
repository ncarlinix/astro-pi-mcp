import { z } from 'zod';
import { DEFAULT_CONFIG } from '../types.js';

/**
 * AstroPilot configuration schema. Values come from defaults, an optional
 * `astropilot.config.json`, and environment variables (env wins). See config/load.ts.
 */
export const configSchema = z.object({
  bridge: z
    .object({
      bridgeDir: z.string().min(1).default(DEFAULT_CONFIG.bridgeDir),
      pollIntervalMs: z.number().int().positive().default(DEFAULT_CONFIG.pollIntervalMs),
      defaultTimeoutMs: z.number().int().positive().default(DEFAULT_CONFIG.defaultTimeoutMs),
    })
    .default({}),
  logging: z
    .object({
      level: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
    })
    .default({}),
  /** Optional path to the PixInsight executable — documentation/convenience only; the
   *  attach model never launches PixInsight from Node. */
  pixInsightPath: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;
