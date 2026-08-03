import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { JsonStore } from '../../store/json-store.js';

/** An astrophotography project: acquisition inventory + processing log (Stage 17). */
export interface Project {
  id: string;
  name?: string;
  target?: string;
  equipmentProfileId?: string;
  frames?: { lights?: number; darks?: number; flats?: number; bias?: number };
  notes?: string;
  log: Array<{ at: string; entry: string }>;
  createdAt: string;
  updatedAt: string;
}

const store = () => new JsonStore<Project>('projects');

export const saveProject: ToolDef = {
  name: 'save_project',
  description:
    'Create or update an astrophotography project: target, equipment profile, frame counts ' +
    '(lights/darks/flats/bias), and notes. Use log_project_step to append processing history.',
  inputSchema: {
    id: z.string().describe('Stable project id, e.g. "rosette-2026"'),
    name: z.string().optional(),
    target: z.string().optional(),
    equipmentProfileId: z.string().optional(),
    frames: z
      .object({ lights: z.number().int().optional(), darks: z.number().int().optional(), flats: z.number().int().optional(), bias: z.number().int().optional() })
      .optional(),
    notes: z.string().optional(),
  },
  handler: async (_backend, args) => {
    const s = store();
    const now = new Date().toISOString();
    const existing = await s.get(args.id as string);
    const project: Project = {
      id: args.id as string,
      name: (args.name as string | undefined) ?? existing?.name,
      target: (args.target as string | undefined) ?? existing?.target,
      equipmentProfileId: (args.equipmentProfileId as string | undefined) ?? existing?.equipmentProfileId,
      frames: (args.frames as Project['frames']) ?? existing?.frames,
      notes: (args.notes as string | undefined) ?? existing?.notes,
      log: existing?.log ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await s.put(project);
    return jsonResult({ saved: project });
  },
};

export const listProjects: ToolDef = {
  name: 'list_projects',
  description: 'List saved projects (id, name, target, frame totals, log length).',
  inputSchema: {},
  handler: async () => {
    const ps = await store().list();
    return jsonResult(
      ps.map((p) => ({ id: p.id, name: p.name, target: p.target, frames: p.frames, logEntries: p.log.length })),
    );
  },
};

export const logProjectStep: ToolDef = {
  name: 'log_project_step',
  description: 'Append a timestamped entry to a project’s processing log (decisions, steps, results).',
  inputSchema: { id: z.string(), entry: z.string() },
  handler: async (_backend, args) => {
    const s = store();
    const p = await s.get(args.id as string);
    if (!p) return { content: [{ type: 'text', text: `No project: ${String(args.id)}` }], isError: true };
    p.log.push({ at: new Date().toISOString(), entry: args.entry as string });
    p.updatedAt = new Date().toISOString();
    await s.put(p);
    return jsonResult({ id: p.id, logEntries: p.log.length });
  },
};

export const generateReport: ToolDef = {
  name: 'generate_report',
  description:
    'Generate a Markdown processing report for a project (target, equipment, frame inventory, ' +
    'and the full processing log). Returns the markdown text.',
  inputSchema: { id: z.string() },
  handler: async (_backend, args) => {
    const p = await store().get(args.id as string);
    if (!p) return { content: [{ type: 'text', text: `No project: ${String(args.id)}` }], isError: true };
    const f = p.frames ?? {};
    const lines = [
      `# Processing Report — ${p.name ?? p.id}`,
      '',
      `- **Target:** ${p.target ?? '—'}`,
      `- **Equipment profile:** ${p.equipmentProfileId ?? '—'}`,
      `- **Frames:** lights ${f.lights ?? 0}, darks ${f.darks ?? 0}, flats ${f.flats ?? 0}, bias ${f.bias ?? 0}`,
      `- **Created:** ${p.createdAt}`,
      `- **Updated:** ${p.updatedAt}`,
      '',
      p.notes ? `## Notes\n\n${p.notes}\n` : '',
      '## Processing log',
      '',
      ...(p.log.length ? p.log.map((e) => `- \`${e.at}\` ${e.entry}`) : ['_(no entries logged)_']),
      '',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
};

export const projectTools: ToolDef[] = [saveProject, listProjects, logProjectStep, generateReport];
