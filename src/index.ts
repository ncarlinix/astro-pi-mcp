import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/load.js';
import { createLogger } from './logging/logger.js';
import { PixInsightBackend } from './backend/pixinsight.js';
import { registerBackend } from './backend/registry.js';
import { createServer } from './mcp/server.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(`AstroPilot AI v${VERSION} starting`);

  const backend = new PixInsightBackend(config.bridge, logger);
  registerBackend(backend);

  // Reap leftovers from previous sessions before serving.
  const reaped = await backend.init();
  if (reaped > 0) logger.info(`Reaped ${reaped} stale bridge file(s)`);

  const alive = await backend.isAlive();
  if (!alive) {
    logger.warn(
      'PixInsight watcher not responding. Open pjsr/astropilot-watcher.js in PixInsight ' +
        'and run it (F9) — tools will time out until it is running.',
    );
  } else {
    logger.info('PixInsight watcher is alive');
  }

  const server = createServer(backend);
  await server.connect(new StdioServerTransport());
  logger.info('MCP server connected over stdio');
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
