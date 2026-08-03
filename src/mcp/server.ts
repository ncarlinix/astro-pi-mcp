import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProcessingBackend } from '../backend/types.js';
import { registerTools } from './tools/index.js';
import { VERSION } from '../version.js';

/** Build the AstroPilot MCP server with all Stage-3 tools registered against `backend`. */
export function createServer(backend: ProcessingBackend): McpServer {
  const server = new McpServer({ name: 'astropilot', version: VERSION });
  registerTools(server, backend);
  return server;
}
