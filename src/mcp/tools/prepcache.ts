import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { cacheStats, cacheClear } from '../../prep/cache.js';

function mb(bytes: number): string { return `${(bytes / 1_048_576).toFixed(1)} MB`; }

export const prepCacheStatus: ToolDef = {
  name: 'prep_cache_status',
  description:
    'Report the prep cache: directory, entry count, total size, and per-entry source/object/age. ' +
    'The prep cache stores post-NXT linear artifacts so process_osc (with cache:true) can skip ' +
    'the ~10–15 min linear prep on an identical input + params.',
  inputSchema: {},
  handler: async (): Promise<ToolResult> => {
    const s = await cacheStats();
    const body = {
      dir: s.dir,
      count: s.count,
      totalSize: mb(s.bytes),
      entries: s.entries
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((e) => ({ object: e.object ?? '?', source: e.sourcePath, size: e.bytes ? mb(e.bytes) : '?', created: e.createdAt, fingerprint: e.fingerprint })),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  },
};

export const clearPrepCache: ToolDef = {
  name: 'clear_prep_cache',
  description:
    'Delete prep-cache artifacts. With no argument, clears the whole cache; pass a fingerprint ' +
    'to remove a single entry (from prep_cache_status). Returns how many artifacts were deleted.',
  inputSchema: {
    fingerprint: z.string().optional().describe('Specific entry to remove; omit to clear all'),
  },
  handler: async (_backend, args): Promise<ToolResult> => {
    const n = await cacheClear(args.fingerprint as string | undefined);
    return { content: [{ type: 'text', text: `Cleared ${n} prep-cache artifact(s)${args.fingerprint ? ` for ${String(args.fingerprint)}` : ''}.` }] };
  },
};

export const prepCacheTools: ToolDef[] = [prepCacheStatus, clearPrepCache];
