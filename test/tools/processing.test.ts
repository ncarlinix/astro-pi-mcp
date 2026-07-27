import { describe, it, expect } from 'vitest';
import {
  executeJs,
  runProcess,
  getProcessParameters,
  runProcessIcon,
  waitUntilIdle,
  cancelJob,
} from '../../src/mcp/tools/processing.js';
import { recordingBackend } from './helpers.js';

describe('processing tools', () => {
  it('execute_js forwards run_script with the code', async () => {
    const { backend, calls } = recordingBackend();
    await executeJs.handler(backend, { code: '2+2' });
    expect(calls[0]).toMatchObject({
      tool: 'run_script',
      process: '__script__',
      parameters: { code: '2+2' },
    });
  });

  it('run_process executes globally without a view', async () => {
    const { backend, calls } = recordingBackend();
    await runProcess.handler(backend, { processId: 'PixelMath', settings: { expression: '$T' } });
    expect(calls[0]).toMatchObject({
      tool: 'run_process',
      process: 'PixelMath',
      parameters: { processId: 'PixelMath', settings: { expression: '$T' } },
      options: { executeMethod: 'executeGlobal', targetView: null },
    });
  });

  it('run_process executes on a view when given', async () => {
    const { backend, calls } = recordingBackend();
    await runProcess.handler(backend, { processId: 'Convolution', view: 'img1' });
    expect(calls[0]!.options).toEqual({ executeMethod: 'executeOn', targetView: 'img1' });
    expect(calls[0]!.parameters).toEqual({ processId: 'Convolution', settings: {} });
  });

  it('get_process_parameters forwards the processId', async () => {
    const { backend, calls } = recordingBackend();
    await getProcessParameters.handler(backend, { processId: 'StarNet2' });
    expect(calls[0]).toMatchObject({
      tool: 'get_process_parameters',
      parameters: { processId: 'StarNet2' },
    });
  });

  it('run_process_icon forwards icon name and execute method', async () => {
    const { backend, calls } = recordingBackend();
    await runProcessIcon.handler(backend, { iconName: 'myABE', view: 'v' });
    expect(calls[0]).toMatchObject({
      tool: 'run_process_icon',
      parameters: { iconName: 'myABE' },
      options: { executeMethod: 'executeOn', targetView: 'v' },
    });
  });

  it('wait_until_idle reports idle when the watcher is alive', async () => {
    const { backend } = recordingBackend(undefined, true);
    const res = await waitUntilIdle.handler(backend, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('wait_until_idle errors when the watcher is dead', async () => {
    const { backend } = recordingBackend(undefined, false);
    const res = await waitUntilIdle.handler(backend, {});
    expect(res.isError).toBe(true);
  });

  it('cancel_job returns a message without sending a command', async () => {
    const { backend, calls } = recordingBackend();
    const res = await cancelJob.handler(backend, {});
    expect(calls).toHaveLength(0);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });
});
