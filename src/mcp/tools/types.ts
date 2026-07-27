import type { z } from 'zod';
import type { ProcessingBackend } from '../../backend/types.js';

/** MCP CallTool result shape (subset we use). */
export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/**
 * A tool definition decoupled from the MCP server so it can be unit-tested by calling
 * `handler(backend, args)` directly. `inputSchema` is a Zod raw shape (the McpServer
 * registration form), not a z.object.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (backend: ProcessingBackend, args: Record<string, unknown>) => Promise<ToolResult>;
}
