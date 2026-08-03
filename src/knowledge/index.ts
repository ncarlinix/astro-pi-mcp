import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default docs dir: <project>/docs, resolved relative to this compiled module
 *  (dist/knowledge/index.js → ../../docs). Overridable via ASTROPILOT_DOCS_DIR. */
function defaultDocsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.ASTROPILOT_DOCS_DIR ?? join(here, '..', '..', 'docs');
}

const NON_CATEGORY = new Set(['README.md', '_common.md']);

export interface WorkflowInfo {
  category: string; // filename without extension, e.g. "osc-hoo"
  title: string;
  file: string;
}

export class KnowledgeBase {
  private docsDir: string;
  private workflowsDir: string;

  constructor(docsDir: string = defaultDocsDir()) {
    this.docsDir = docsDir;
    this.workflowsDir = join(docsDir, 'workflows');
  }

  private async firstHeading(path: string): Promise<string> {
    try {
      const text = await readFile(path, 'utf-8');
      const m = /^#\s+(.+)$/m.exec(text);
      return m ? m[1]!.trim() : basename(path);
    } catch {
      return basename(path);
    }
  }

  /** List the per-category processing playbooks (Stage 6). */
  async listWorkflows(): Promise<WorkflowInfo[]> {
    if (!existsSync(this.workflowsDir)) return [];
    const files = (await readdir(this.workflowsDir)).filter(
      (f) => f.endsWith('.md') && !NON_CATEGORY.has(f),
    );
    const out: WorkflowInfo[] = [];
    for (const f of files.sort()) {
      out.push({
        category: f.replace(/\.md$/, ''),
        title: await this.firstHeading(join(this.workflowsDir, f)),
        file: join(this.workflowsDir, f),
      });
    }
    return out;
  }

  /** Fetch a playbook's full markdown by category (e.g. "osc-hoo", "mono-sho"). */
  async getWorkflow(category: string): Promise<string | null> {
    const file = join(this.workflowsDir, `${category.replace(/[^a-z0-9-]/gi, '')}.md`);
    if (!existsSync(file)) return null;
    return readFile(file, 'utf-8');
  }

  /** Fetch a top-level knowledge doc by name (without extension), e.g. "PROCESSING_GUIDE". */
  async getDoc(name: string): Promise<string | null> {
    const file = join(this.docsDir, `${name.replace(/[^a-z0-9_-]/gi, '')}.md`);
    if (!existsSync(file)) return null;
    return readFile(file, 'utf-8');
  }
}
