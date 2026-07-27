import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBackend,
  getBackend,
  listBackends,
  clearBackends,
} from '../src/backend/registry.js';
import type { ProcessingBackend } from '../src/backend/types.js';
import type { BridgeResult } from '../src/types.js';

function fakeBackend(id: string): ProcessingBackend {
  return {
    id,
    isAlive: async () => true,
    send: async (): Promise<BridgeResult> => ({
      id: 'x',
      timestamp: new Date().toISOString(),
      status: 'success',
      process: '__test__',
      duration_ms: 0,
    }),
  };
}

describe('backend registry', () => {
  beforeEach(() => clearBackends());

  it('registers and retrieves a backend by id', () => {
    const b = fakeBackend('pixinsight');
    registerBackend(b);
    expect(getBackend('pixinsight')).toBe(b);
    expect(listBackends()).toEqual([b]);
  });

  it('throws on duplicate registration', () => {
    registerBackend(fakeBackend('pixinsight'));
    expect(() => registerBackend(fakeBackend('pixinsight'))).toThrow(/already registered/);
  });

  it('throws on unknown id', () => {
    expect(() => getBackend('nope')).toThrow(/Unknown backend/);
  });
});
