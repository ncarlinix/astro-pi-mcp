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

export const stopWatcherTool: ToolDef = {
  name: 'stop_watcher',
  description:
    'Cleanly stop the PixInsight PJSR watcher so PixInsight becomes interactive again (zoom, ' +
    'run processes by hand). While the watcher polls it holds the engine and the UI is locked. ' +
    'Call this when finishing an AstroPilot session, or whenever the user wants PixInsight back. ' +
    'Writes the shutdown sentinel the watcher polls for; to resume, re-run astropilot-watcher.js ' +
    '(F9). Handy on macOS where Ctrl+F11 (the manual abort) is intercepted by the OS.',
  inputSchema: {},
  handler: async (backend) => {
    if (typeof backend.stopWatcher !== 'function') {
      return {
        content: [{ type: 'text', text: `Backend "${backend.id}" has no stoppable watcher.` }],
        isError: true,
      };
    }
    const stopped = await backend.stopWatcher();
    return jsonResult({
      stopped,
      message: stopped
        ? 'Watcher stopped — PixInsight is interactive again. Re-run astropilot-watcher.js (F9) to resume.'
        : 'Shutdown signal sent but the watcher still appears alive; it may stop shortly, or use the Process Console abort button.',
    });
  },
};

export const backendTools: ToolDef[] = [listBackendsTool, stopWatcherTool];
