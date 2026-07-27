import type { ProcessingBackend } from './types.js';

const backends = new Map<string, ProcessingBackend>();

/** Register a backend. Throws if a backend with the same id is already registered. */
export function registerBackend(backend: ProcessingBackend): void {
  if (backends.has(backend.id)) {
    throw new Error(`Backend already registered: ${backend.id}`);
  }
  backends.set(backend.id, backend);
}

/** Look up a backend by id. Throws if none is registered under that id. */
export function getBackend(id: string): ProcessingBackend {
  const backend = backends.get(id);
  if (!backend) {
    const known = [...backends.keys()].join(', ') || '(none)';
    throw new Error(`Unknown backend: ${id} (registered: ${known})`);
  }
  return backend;
}

export function listBackends(): ProcessingBackend[] {
  return [...backends.values()];
}

/** Test helper: clear the registry. */
export function clearBackends(): void {
  backends.clear();
}
