import { pino, destination, type Logger } from 'pino';
import type { Config } from '../config/schema.js';

export type { Logger };

/**
 * Create the application logger. In development (NODE_ENV !== "production") logs are
 * pretty-printed to stderr; in production they are line-delimited JSON.
 *
 * IMPORTANT: an MCP server speaks JSON-RPC over stdout, so logs must go to stderr only —
 * never stdout — or they corrupt the protocol stream.
 */
export function createLogger(cfg: Config): Logger {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    return pino({
      level: cfg.logging.level,
      transport: {
        target: 'pino-pretty',
        options: { destination: 2, colorize: true, translateTime: 'SYS:HH:MM:ss' },
      },
    });
  }
  // Production: JSON to stderr (fd 2). pino's default is stdout, which would corrupt MCP.
  return pino({ level: cfg.logging.level }, destination(2));
}
