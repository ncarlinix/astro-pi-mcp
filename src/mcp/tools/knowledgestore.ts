import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { knowledgeResolve, knowledgeSet, knowledgeRecord, knowledgeStats, knowledgeClear, type Level } from '../../knowledge/store.js';

const LEVELS = ['universal', 'trait', 'type', 'target'] as const;

export const knowledgeGet: ToolDef = {
  name: 'knowledge_get',
  description:
    'Resolve learned processing params for a target/type/traits (Phase 4.2), most-specific-first ' +
    '(universal < trait < type < target). Returns the merged params plus per-key provenance. This ' +
    'is the learned layer recommend_processing applies on top of the 4.3 brief defaults.',
  inputSchema: {
    target: z.string().optional().describe('Target key, e.g. "M83" (normalized)'),
    type: z.string().optional().describe('Target class, e.g. "galaxy"'),
    traits: z.array(z.string()).optional().describe('Active trait names'),
  },
  handler: async (_b, args): Promise<ToolResult> => {
    const r = await knowledgeResolve({ target: args.target as string | undefined, type: args.type as string | undefined, traits: args.traits as string[] | undefined });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  },
};

export const knowledgeSetTool: ToolDef = {
  name: 'knowledge_set',
  description:
    'Set (merge) processing params at a knowledge level. level=universal needs no name; ' +
    'trait/type/target need "name" (e.g. type "galaxy", target "M83"). These override the 4.3 ' +
    'brief defaults for matching targets.',
  inputSchema: {
    level: z.enum(LEVELS),
    name: z.string().optional().describe('Bucket name for trait/type/target (omit for universal)'),
    params: z.record(z.unknown()).describe('Param key→value map to merge, e.g. {"nebulaBoost":0.4}'),
  },
  handler: async (_b, args): Promise<ToolResult> => {
    await knowledgeSet(args.level as Level, (args.name as string | undefined) ?? null, args.params as Record<string, unknown>);
    return { content: [{ type: 'text', text: `Set ${String(args.level)}${args.name ? `:${String(args.name)}` : ''} params ${JSON.stringify(args.params)}` }] };
  },
};

export const knowledgeRecordTool: ToolDef = {
  name: 'knowledge_record',
  description:
    'Record the params that worked for a specific target (e.g. after a result you liked). Stores ' +
    'them at the target level and auto-promotes a value to the type level once enough sibling ' +
    'targets of that type agree. Returns any params promoted this call.',
  inputSchema: {
    target: z.string().describe('Target key, e.g. "M83"'),
    type: z.string().optional().describe('Target class for promotion, e.g. "galaxy"'),
    params: z.record(z.unknown()).describe('Accepted param key→value map'),
  },
  handler: async (_b, args): Promise<ToolResult> => {
    const { promoted } = await knowledgeRecord(args.target as string, (args.type as string | undefined) ?? null, args.params as Record<string, unknown>);
    const note = Object.keys(promoted).length ? ` Promoted to type:${String(args.type)}: ${JSON.stringify(promoted)}` : '';
    return { content: [{ type: 'text', text: `Recorded ${JSON.stringify(args.params)} for ${String(args.target)}.${note}` }] };
  },
};

export const knowledgeStatus: ToolDef = {
  name: 'knowledge_status',
  description: 'Dump the knowledge store: universal/trait/type params and per-target params + observation counts.',
  inputSchema: {},
  handler: async (): Promise<ToolResult> => {
    const s = await knowledgeStats();
    return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
  },
};

export const clearKnowledge: ToolDef = {
  name: 'clear_knowledge',
  description: 'Clear the knowledge store. No args = wipe all; pass level (+name) to clear one bucket.',
  inputSchema: {
    level: z.enum(LEVELS).optional(),
    name: z.string().optional(),
  },
  handler: async (_b, args): Promise<ToolResult> => {
    const ok = await knowledgeClear(args.level as Level | undefined, (args.name as string | undefined) ?? null);
    return { content: [{ type: 'text', text: ok ? 'Knowledge cleared.' : 'Clear failed.' }], isError: !ok };
  },
};

export const knowledgeStoreTools: ToolDef[] = [knowledgeGet, knowledgeSetTool, knowledgeRecordTool, knowledgeStatus, clearKnowledge];
