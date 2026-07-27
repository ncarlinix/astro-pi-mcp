import type { BridgeResult } from '../../types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import type { ToolResult } from './types.js';

/** Result of running a PJSR probe that prints a JSON object as its final expression. */
export type ScriptJson =
  | { data: Record<string, unknown> }
  | { error: string };

/** Run a run_script probe and parse its JSON return value. A `{error}` field in the JSON,
 *  a bridge error, or unparseable output all collapse to `{ error }`. */
export async function runScriptJson(
  backend: ProcessingBackend,
  code: string,
  timeoutMs?: number,
): Promise<ScriptJson> {
  const res = await backend.send('run_script', '__script__', { code }, timeoutMs ? { timeoutMs } : undefined);
  if (res.status === 'error') return { error: res.error?.message ?? 'script failed' };
  const raw = (res.outputs as { returnValue?: unknown } | undefined)?.returnValue;
  if (typeof raw !== 'string') return { error: 'watcher returned no value' };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.error === 'string') return { error: data.error };
    return { data };
  } catch {
    return { error: `unparseable script output: ${raw.slice(0, 200)}` };
  }
}

/** Resolve a view id, falling back to the active image when none is given. Null = none. */
export async function resolveViewId(
  backend: ProcessingBackend,
  view: string | undefined,
): Promise<string | null> {
  if (view) return view;
  const res = await backend.send('active_image', '__internal__', {});
  const id = (res.outputs as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

/** Wrap a JSON-serialisable payload as a text tool result. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** A uniform "no view / no active image" error result. */
export function noViewResult(): ToolResult {
  return { content: [{ type: 'text', text: 'No view specified and no active image.' }], isError: true };
}

/** Convert a bridge result into an MCP tool result. Errors set `isError` with the error
 *  message; successes return outputs (pretty JSON) plus any human-readable message. */
export function toToolResult(res: BridgeResult): ToolResult {
  if (res.status === 'error') {
    const err = res.error;
    const text = err ? `${err.type ? err.type + ': ' : ''}${err.message}` : 'Unknown error';
    return { content: [{ type: 'text', text }], isError: true };
  }
  const parts: string[] = [];
  if (res.outputs && Object.keys(res.outputs).length > 0) {
    parts.push(JSON.stringify(res.outputs, null, 2));
  }
  if (res.message) parts.push(res.message);
  return { content: [{ type: 'text', text: parts.join('\n\n') || 'ok' }] };
}
