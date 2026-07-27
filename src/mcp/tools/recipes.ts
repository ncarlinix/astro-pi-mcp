import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { JsonStore } from '../../store/json-store.js';
import type { ExecuteMethod } from '../../types.js';

/** One step of a recipe: a process to run (or a raw PJSR script). */
export interface RecipeStep {
  processId?: string;
  settings?: Record<string, unknown>;
  script?: string; // alternative: run arbitrary PJSR
  view?: string; // target view for this step; falls back to run_recipe's view
}

export interface Recipe {
  id: string;
  name?: string;
  description?: string;
  category?: string; // e.g. "Natural Galaxy", "OSC Nebula"
  version: number;
  steps: RecipeStep[];
  updatedAt: string;
}

const store = () => new JsonStore<Recipe>('recipes');

const stepSchema = z.object({
  processId: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
  script: z.string().optional(),
  view: z.string().optional(),
});

export const saveRecipe: ToolDef = {
  name: 'save_recipe',
  description:
    'Create or update a reusable, versioned processing recipe (an ordered list of steps, each ' +
    'a run_process call or a PJSR script). Saving an existing id auto-increments its version.',
  inputSchema: {
    id: z.string().describe('Stable recipe id, e.g. "natural-galaxy"'),
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    steps: z.array(stepSchema).describe('Ordered steps'),
  },
  handler: async (_backend, args) => {
    const s = store();
    const existing = await s.get(args.id as string);
    const recipe: Recipe = {
      id: args.id as string,
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      category: args.category as string | undefined,
      version: (existing?.version ?? 0) + 1,
      steps: args.steps as RecipeStep[],
      updatedAt: new Date().toISOString(),
    };
    await s.put(recipe);
    return jsonResult({ saved: recipe });
  },
};

export const listRecipes: ToolDef = {
  name: 'list_recipes',
  description: 'List saved processing recipes (id, name, category, version, step count).',
  inputSchema: {},
  handler: async () => {
    const rs = await store().list();
    return jsonResult(
      rs.map((r) => ({ id: r.id, name: r.name, category: r.category, version: r.version, steps: r.steps.length })),
    );
  },
};

export const getRecipe: ToolDef = {
  name: 'get_recipe',
  description: 'Get a full recipe by id.',
  inputSchema: { id: z.string() },
  handler: async (_backend, args) => {
    const r = await store().get(args.id as string);
    return r ? jsonResult(r) : { content: [{ type: 'text', text: `No recipe: ${String(args.id)}` }], isError: true };
  },
};

export const deleteRecipe: ToolDef = {
  name: 'delete_recipe',
  description: 'Delete a recipe by id.',
  inputSchema: { id: z.string() },
  handler: async (_backend, args) => {
    const ok = await store().delete(args.id as string);
    return { content: [{ type: 'text', text: ok ? `Deleted ${String(args.id)}` : `No recipe: ${String(args.id)}` }], isError: !ok };
  },
};

export const runRecipe: ToolDef = {
  name: 'run_recipe',
  description:
    'Execute a saved recipe step by step against PixInsight. Each step runs a process (or PJSR ' +
    'script) via the bridge; execution stops at the first failing step and reports progress. ' +
    'Provide "view" as the default target for steps that do not name one.',
  inputSchema: {
    id: z.string().describe('Recipe id to run'),
    view: z.string().optional().describe('Default target view for steps'),
    dryRun: z.boolean().optional().describe('Report the plan without executing'),
  },
  handler: async (backend, args) => {
    const recipe = await store().get(args.id as string);
    if (!recipe) return { content: [{ type: 'text', text: `No recipe: ${String(args.id)}` }], isError: true };

    const defaultView = args.view as string | undefined;
    const results: Array<Record<string, unknown>> = [];

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i]!;
      const view = step.view ?? defaultView;
      const method: { executeMethod: ExecuteMethod; targetView: string | null } = view
        ? { executeMethod: 'executeOn', targetView: view }
        : { executeMethod: 'executeGlobal', targetView: null };

      if (args.dryRun) {
        results.push({ step: i, plan: step.script ? 'run_script' : step.processId, view });
        continue;
      }

      const res = step.script
        ? await backend.send('run_script', '__script__', { code: step.script })
        : await backend.send('run_process', step.processId!, { processId: step.processId, settings: step.settings ?? {} }, method);

      results.push({ step: i, processId: step.processId ?? 'run_script', status: res.status, message: res.message ?? res.error?.message });
      if (res.status === 'error') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ recipe: recipe.id, stoppedAtStep: i, results }, null, 2) },
            { type: 'text', text: `Recipe "${recipe.id}" failed at step ${i}: ${res.error?.message ?? 'error'}` },
          ],
          isError: true,
        };
      }
    }
    return jsonResult({ recipe: recipe.id, version: recipe.version, dryRun: !!args.dryRun, results });
  },
};

export const recipeTools: ToolDef[] = [saveRecipe, listRecipes, getRecipe, deleteRecipe, runRecipe];
