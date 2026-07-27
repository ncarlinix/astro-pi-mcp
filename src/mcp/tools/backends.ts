import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { listBackends } from '../../backend/registry.js';

export const listBackendsTool: ToolDef = {
  name: 'list_backends',
  description:
    'List registered processing backends and their liveness (Stage 19 plugin architecture). ' +
    'PixInsight is the built-in backend; additional backends (Siril, GraXpert, …) implement ' +
    'the ProcessingBackend interface and register at startup.',
  inputSchema: {},
  handler: async () => {
    const backends = listBackends();
    const rows = await Promise.all(
      backends.map(async (b) => ({ id: b.id, alive: await b.isAlive().catch(() => false) })),
    );
    return jsonResult({
      backends: rows,
      pluginContract: 'Implement ProcessingBackend { id, isAlive(), send(tool,process,params,opts) } and registerBackend() it.',
    });
  },
};

export const backendTools: ToolDef[] = [listBackendsTool];
