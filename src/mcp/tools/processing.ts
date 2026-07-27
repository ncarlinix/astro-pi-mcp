import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult } from './util.js';
import type { ExecuteMethod } from '../../types.js';

function methodFor(view?: string): { executeMethod: ExecuteMethod; targetView: string | null } {
  return view
    ? { executeMethod: 'executeOn', targetView: view }
    : { executeMethod: 'executeGlobal', targetView: null };
}

export const executeJs: ToolDef = {
  name: 'execute_js',
  description:
    'Execute an arbitrary PJSR (PixInsight JavaScript) snippet inside PixInsight and ' +
    'return the value of its final expression. Use for anything not covered by a ' +
    'dedicated tool. The code runs with full PixInsight scripting access.',
  inputSchema: { code: z.string().describe('PJSR source to eval; its last expression is returned') },
  handler: async (backend, args) => {
    const res = await backend.send('run_script', '__script__', { code: args.code });
    return toToolResult(res);
  },
};

export const runProcess: ToolDef = {
  name: 'run_process',
  description:
    'Run any PixInsight process by its class name (e.g. "AutomaticBackgroundExtractor", ' +
    '"PixelMath", "BlurXTerminator"). Settings are assigned to the process instance; ' +
    'unknown parameter names are rejected — use get_process_parameters to discover them. ' +
    'Omit "view" to execute globally.',
  inputSchema: {
    processId: z.string().describe('PixInsight process class name'),
    settings: z.record(z.unknown()).optional().describe('Parameter name → value map'),
    view: z.string().optional().describe('Target view id; omit for executeGlobal'),
  },
  handler: async (backend, args) => {
    const processId = args.processId as string;
    const settings = (args.settings as Record<string, unknown>) ?? {};
    const res = await backend.send(
      'run_process',
      processId,
      { processId, settings },
      methodFor(args.view as string | undefined),
    );
    return toToolResult(res);
  },
};

export const getProcessParameters: ToolDef = {
  name: 'get_process_parameters',
  description:
    'Introspect a PixInsight process: returns its settable parameter names and current ' +
    'default values. Call this before run_process to learn valid settings.',
  inputSchema: { processId: z.string().describe('PixInsight process class name') },
  handler: async (backend, args) => {
    const res = await backend.send('get_process_parameters', '__internal__', {
      processId: args.processId,
    });
    return toToolResult(res);
  },
};

export const runProcessIcon: ToolDef = {
  name: 'run_process_icon',
  description:
    'Execute a process icon from the PixInsight workspace by its icon id. Omit "view" to ' +
    'execute globally.',
  inputSchema: {
    iconName: z.string().describe('Process icon id in the workspace'),
    view: z.string().optional().describe('Target view id; omit for executeGlobal'),
  },
  handler: async (backend, args) => {
    const res = await backend.send(
      'run_process_icon',
      '__internal__',
      { iconName: args.iconName },
      methodFor(args.view as string | undefined),
    );
    return toToolResult(res);
  },
};

export const waitUntilIdle: ToolDef = {
  name: 'wait_until_idle',
  description:
    'Confirm PixInsight is ready for the next command. The bridge is synchronous — every ' +
    'command already blocks until it completes — so this simply verifies the watcher is ' +
    'alive and reports idle.',
  inputSchema: {},
  handler: async (backend) => {
    const alive = await backend.isAlive();
    return {
      content: [
        {
          type: 'text',
          text: alive
            ? 'idle: watcher alive, no command in flight'
            : 'watcher not responding — is astropilot-watcher.js running in PixInsight?',
        },
      ],
      isError: !alive,
    };
  },
};

export const cancelJob: ToolDef = {
  name: 'cancel_job',
  description:
    'Request cancellation of the in-flight command. NOTE: the file bridge is synchronous ' +
    'and a running PixInsight process cannot be interrupted mid-execution, so this is a ' +
    'best-effort no-op reported honestly; it does not abort a process already running.',
  inputSchema: {},
  handler: async () => ({
    content: [
      {
        type: 'text',
        text:
          'No cancellable job: the AstroPilot bridge executes one command at a time and ' +
          'cannot interrupt a PixInsight process already running. Wait for it to finish.',
      },
    ],
  }),
};

export const processingTools: ToolDef[] = [
  executeJs,
  runProcess,
  getProcessParameters,
  runProcessIcon,
  waitUntilIdle,
  cancelJob,
];
