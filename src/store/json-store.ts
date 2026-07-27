import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Base directory for all AstroPilot persistent state (overridable in tests). */
export function storeBaseDir(): string {
  return process.env.ASTROPILOT_HOME ?? '~/.astropilot';
}

/**
 * A tiny persistent JSON collection keyed by id, stored one file per collection under a
 * base directory (default ~/.astropilot). Used by equipment profiles, recipes,
 * preferences, and projects. Atomic writes (tmp + rename). Not concurrency-safe across
 * processes — a single MCP server owns it.
 */
export class JsonStore<T extends { id: string }> {
  private file: string;

  constructor(collection: string, baseDir = storeBaseDir()) {
    this.file = join(expandHome(baseDir), `${collection}.json`);
  }

  private async readAll(): Promise<Record<string, T>> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(await readFile(this.file, 'utf-8')) as Record<string, T>;
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, T>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmp, this.file);
  }

  async list(): Promise<T[]> {
    return Object.values(await this.readAll());
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.readAll())[id];
  }

  async put(item: T): Promise<T> {
    const all = await this.readAll();
    all[item.id] = item;
    await this.writeAll(all);
    return item;
  }

  async delete(id: string): Promise<boolean> {
    const all = await this.readAll();
    if (!(id in all)) return false;
    delete all[id];
    await this.writeAll(all);
    return true;
  }
}

/** A single-object JSON document (e.g. global preferences) at baseDir/name.json. */
export class JsonDoc<T> {
  private file: string;

  constructor(name: string, baseDir = storeBaseDir()) {
    this.file = join(expandHome(baseDir), `${name}.json`);
  }

  async read(fallback: T): Promise<T> {
    if (!existsSync(this.file)) return fallback;
    try {
      return JSON.parse(await readFile(this.file, 'utf-8')) as T;
    } catch {
      return fallback;
    }
  }

  async write(data: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmp, this.file);
  }
}

/** Test/util helper: remove a collection/doc file if present. */
export async function removeStoreFiles(baseDir: string): Promise<void> {
  const dir = expandHome(baseDir);
  if (!existsSync(dir)) return;
  for (const f of await readdir(dir)) {
    if (f.endsWith('.json') || f.endsWith('.json.tmp')) await unlink(join(dir, f)).catch(() => {});
  }
}
