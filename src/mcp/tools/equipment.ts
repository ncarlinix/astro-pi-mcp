import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { JsonStore } from '../../store/json-store.js';

export interface EquipmentProfile {
  id: string;
  name?: string;
  camera?: string;
  telescope?: string;
  reducer?: string;
  mount?: string;
  filter?: string;
  bortle?: number;
  typicalExposureSec?: number;
  gain?: number;
  offset?: number;
  preferredStyle?: string;
}

const store = () => new JsonStore<EquipmentProfile>('equipment');

export const saveEquipmentProfile: ToolDef = {
  name: 'save_equipment_profile',
  description:
    'Create or update a reusable equipment profile (camera, scope, reducer, mount, filter, ' +
    'Bortle class, typical exposure/gain, preferred style). The AI adapts recommendations to ' +
    'the active profile.',
  inputSchema: {
    id: z.string().describe('Stable profile id, e.g. "rig-533-redcat"'),
    name: z.string().optional(),
    camera: z.string().optional(),
    telescope: z.string().optional(),
    reducer: z.string().optional(),
    mount: z.string().optional(),
    filter: z.string().optional(),
    bortle: z.number().int().min(1).max(9).optional(),
    typicalExposureSec: z.number().positive().optional(),
    gain: z.number().optional(),
    offset: z.number().optional(),
    preferredStyle: z.string().optional(),
  },
  handler: async (_backend, args) => {
    const saved = await store().put(args as unknown as EquipmentProfile);
    return jsonResult({ saved });
  },
};

export const listEquipmentProfiles: ToolDef = {
  name: 'list_equipment_profiles',
  description: 'List all saved equipment profiles.',
  inputSchema: {},
  handler: async () => jsonResult(await store().list()),
};

export const getEquipmentProfile: ToolDef = {
  name: 'get_equipment_profile',
  description: 'Get one equipment profile by id.',
  inputSchema: { id: z.string() },
  handler: async (_backend, args) => {
    const p = await store().get(args.id as string);
    return p
      ? jsonResult(p)
      : { content: [{ type: 'text', text: `No profile: ${String(args.id)}` }], isError: true };
  },
};

export const deleteEquipmentProfile: ToolDef = {
  name: 'delete_equipment_profile',
  description: 'Delete an equipment profile by id.',
  inputSchema: { id: z.string() },
  handler: async (_backend, args) => {
    const ok = await store().delete(args.id as string);
    return { content: [{ type: 'text', text: ok ? `Deleted ${String(args.id)}` : `No profile: ${String(args.id)}` }], isError: !ok };
  },
};

export const equipmentTools: ToolDef[] = [
  saveEquipmentProfile,
  listEquipmentProfiles,
  getEquipmentProfile,
  deleteEquipmentProfile,
];
