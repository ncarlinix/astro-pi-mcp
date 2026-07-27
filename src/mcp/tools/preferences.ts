import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { JsonDoc } from '../../store/json-store.js';

/** User + per-project processing preferences (Stage 18 AI memory). Free-form key→value with
 *  a documented set of common keys; project overrides shadow global values. */
interface Preferences {
  global: Record<string, unknown>;
  projects: Record<string, Record<string, unknown>>;
}

const COMMON_KEYS = [
  'stretchStyle',
  'favoritePalette',
  'noiseTolerance',
  'starSize',
  'galaxyStyle',
  'nebulaStyle',
  'teachingLevel',
];

const doc = () => new JsonDoc<Preferences>('preferences');
const empty: Preferences = { global: {}, projects: {} };

export const setPreference: ToolDef = {
  name: 'set_preference',
  description:
    'Remember a processing preference (Stage 18). Common keys: ' +
    COMMON_KEYS.join(', ') +
    '. Scope "global" (default) or a project id. Project preferences override global ones.',
  inputSchema: {
    key: z.string().describe('Preference key'),
    value: z.union([z.string(), z.number(), z.boolean()]).describe('Preference value'),
    project: z.string().optional().describe('Project id for a project-scoped override'),
  },
  handler: async (_backend, args) => {
    const d = doc();
    const prefs = await d.read(structuredClone(empty));
    const key = args.key as string;
    const value = args.value as unknown;
    if (args.project) {
      const p = (prefs.projects[args.project as string] ??= {});
      p[key] = value;
    } else {
      prefs.global[key] = value;
    }
    await d.write(prefs);
    return jsonResult({ set: key, scope: args.project ?? 'global', value });
  },
};

export const getPreferences: ToolDef = {
  name: 'get_preferences',
  description:
    'Get processing preferences. With a project id, returns the effective set (global merged ' +
    'with project overrides) plus the raw layers.',
  inputSchema: { project: z.string().optional() },
  handler: async (_backend, args) => {
    const prefs = await doc().read(structuredClone(empty));
    if (args.project) {
      const overrides = prefs.projects[args.project as string] ?? {};
      return jsonResult({
        scope: args.project,
        effective: { ...prefs.global, ...overrides },
        global: prefs.global,
        overrides,
      });
    }
    return jsonResult({ scope: 'global', effective: prefs.global, projects: Object.keys(prefs.projects) });
  },
};

export const preferenceTools: ToolDef[] = [setPreference, getPreferences];
