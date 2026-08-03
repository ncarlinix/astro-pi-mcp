import type { ProcessingBackend, SendOptions } from '../../src/backend/types.js';
import type { BridgeResult } from '../../src/types.js';

export interface RecordedCall {
  tool: string;
  process: string;
  parameters: Record<string, unknown>;
  options?: SendOptions;
}

export type SendImpl = (
  call: RecordedCall,
) => BridgeResult | Promise<BridgeResult>;

function defaultResult(process: string): BridgeResult {
  return {
    id: 'test',
    timestamp: new Date().toISOString(),
    status: 'success',
    process,
    duration_ms: 1,
    outputs: { watcherRev: 1 },
    message: 'ok',
  };
}

/** A ProcessingBackend that records every send() and returns a canned/overridable result. */
export function recordingBackend(sendImpl?: SendImpl, alive = true) {
  const calls: RecordedCall[] = [];
  const backend: ProcessingBackend = {
    id: 'fake',
    isAlive: async () => alive,
    send: async (tool, process, parameters, options) => {
      const call: RecordedCall = { tool, process, parameters, options };
      calls.push(call);
      return (await sendImpl?.(call)) ?? defaultResult(process);
    },
  };
  return { backend, calls };
}
