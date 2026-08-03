import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult } from './util.js';

const viewArg = { view: z.string().optional().describe('View id; omit for the active image') };

export const getHistory: ToolDef = {
  name: 'get_history',
  description: 'Current process-history pointer + canUndo/canRedo for a view. Omit "view" for active.',
  inputSchema: viewArg,
  handler: async (backend, args) => toToolResult(await backend.send('get_history', '__internal__', { viewId: args.view })),
};

export const getFullHistory: ToolDef = {
  name: 'get_full_history',
  description:
    'Full named process-history step list (with compact per-step parameters) for a view. Omit ' +
    '"view" for active.',
  inputSchema: { ...viewArg, maxParamLines: z.number().int().min(1).max(60).optional() },
  handler: async (backend, args) =>
    toToolResult(await backend.send('get_full_history', '__internal__', { viewId: args.view, maxParamLines: args.maxParamLines })),
};

export const undo: ToolDef = {
  name: 'undo',
  description: 'Undo N process-history steps on a view (default 1). Omit "view" for active.',
  inputSchema: { ...viewArg, steps: z.number().int().min(1).optional() },
  handler: async (backend, args) => toToolResult(await backend.send('undo', '__internal__', { viewId: args.view, steps: args.steps })),
};

export const redo: ToolDef = {
  name: 'redo',
  description: 'Redo N process-history steps on a view (default 1). Omit "view" for active.',
  inputSchema: { ...viewArg, steps: z.number().int().min(1).optional() },
  handler: async (backend, args) => toToolResult(await backend.send('redo', '__internal__', { viewId: args.view, steps: args.steps })),
};

export const snapshot: ToolDef = {
  name: 'snapshot',
  description:
    'Take an in-memory snapshot of a view (a hidden window) you can restore later. Omit "view" ' +
    'for active; snapshotId defaults to "<view>_snap".',
  inputSchema: { ...viewArg, snapshotId: z.string().optional() },
  handler: async (backend, args) =>
    toToolResult(await backend.send('snapshot', '__internal__', { viewId: args.view, snapshotId: args.snapshotId })),
};

export const restore: ToolDef = {
  name: 'restore',
  description: 'Restore a view from a previously taken snapshot (registers an undoable step).',
  inputSchema: { ...viewArg, snapshotId: z.string().describe('Snapshot id to restore from') },
  handler: async (backend, args) =>
    toToolResult(await backend.send('restore', '__internal__', { viewId: args.view, snapshotId: args.snapshotId })),
};

export const sessionTools: ToolDef[] = [getHistory, getFullHistory, undo, redo, snapshot, restore];
