import { z } from 'zod';
import type { ToolDef } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';
import { starMetricsScript } from '../../pjsr/measure/stars.js';
import { resolveTarget } from '../../astro/simbad.js';
import { classifyFilter, classifyObject, buildBrief, targetKey, type TargetClass } from '../../astro/briefs.js';
import { knowledgeResolve } from '../../knowledge/store.js';

export const resolveTargetTool: ToolDef = {
  name: 'resolve_target',
  description:
    'Resolve an astronomical object name (e.g. "M31", "NGC 7000", "Rosette Nebula") to ICRS ' +
    'J2000 coordinates and an object type via the CDS Sesame/SIMBAD service. Requires network.',
  inputSchema: { name: z.string().describe('Object name or catalog id') },
  handler: async (_backend, args) => {
    try {
      const r = await resolveTarget(args.name as string);
      return jsonResult(r);
    } catch (e) {
      return { content: [{ type: 'text', text: `Name resolution failed (offline?): ${String(e)}` }], isError: true };
    }
  },
};

/** Map SIMBAD object-type hints to AstroPilot target categories. */
function categoryFromOtype(otype: string | null): string | null {
  if (!otype) return null;
  const t = otype.toLowerCase();
  if (/(galaxy|gxy|agn|seyfert)/.test(t)) return 'Galaxy';
  if (/(globular)/.test(t)) return 'Globular Cluster';
  if (/(open cluster|opcl|\bcl\b)/.test(t)) return 'Open Cluster';
  if (/(planetary neb|pn\b)/.test(t)) return 'Planetary Nebula';
  if (/(reflection neb)/.test(t)) return 'Reflection Nebula';
  if (/(emission neb|hii|h ii)/.test(t)) return 'Emission Nebula';
  if (/(dark neb)/.test(t)) return 'Dark Nebula';
  if (/(nebula|neb)/.test(t)) return 'Nebula (unspecified)';
  if (/(comet)/.test(t)) return 'Comet';
  return null;
}

export const classifyTargetTool: ToolDef = {
  name: 'classify_target',
  description:
    'Assemble evidence to classify what an open image contains (Stage 5): reads header ' +
    'metadata (OBJECT/filter), optionally resolves the object name online, and measures star ' +
    'density as a morphology hint. Returns a heuristic category + confidence PLUS the raw ' +
    'evidence — the assistant should confirm with a visual look (take_screenshot). Omit ' +
    '"view" for the active image.',
  inputSchema: {
    view: z.string().optional(),
    resolveOnline: z.boolean().optional().describe('Query SIMBAD/Sesame for the OBJECT name (network)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();

    const metaRes = await runScriptJson(backend, metadataScript(viewId));
    const meta = 'data' in metaRes ? (metaRes.data.metadata as Record<string, unknown>) : {};
    const geometry = 'data' in metaRes ? (metaRes.data.geometry as Record<string, unknown>) : {};
    const objectName = (meta?.object as string | undefined) ?? null;

    const starRes = await runScriptJson(backend, starMetricsScript(viewId, 100), 600_000);
    const starCount = 'data' in starRes ? Number(starRes.data.starCount) : null;
    const w = Number(geometry?.width) || 0;
    const h = Number(geometry?.height) || 0;
    const mpx = (w * h) / 1e6;
    const starDensity = starCount !== null && mpx > 0 ? starCount / mpx : null;

    let resolved = null;
    let category: string | null = null;
    let confidence = 'low';
    if (args.resolveOnline && objectName) {
      try {
        resolved = await resolveTarget(objectName);
        category = categoryFromOtype(resolved.objectType);
        if (category) confidence = 'medium';
      } catch {
        /* offline; fall through to heuristics */
      }
    }
    // Morphology fallback when no catalog type: very high star density → cluster/starfield.
    if (!category && starDensity !== null) {
      if (starDensity > 2000) {
        category = 'Star-rich field (cluster / Milky Way / starfield)';
        confidence = 'low';
      }
    }

    return jsonResult({
      viewId,
      guessedCategory: category ?? 'unknown — inspect visually (take_screenshot)',
      confidence,
      evidence: {
        objectName,
        filter: meta?.filter ?? null,
        simbad: resolved,
        starCount,
        starDensityPerMpx: starDensity !== null ? Number(starDensity.toPrecision(4)) : null,
        geometry,
      },
      note: 'Heuristic only. Confirm with a visual look and, for nebulae, the emission vs broadband filter.',
    });
  },
};


const TARGET_CLASSES = ['emission-nebula','galaxy','reflection-nebula','planetary-nebula','supernova-remnant','open-cluster','globular-cluster','unknown'] as const;

export const recommendProcessingTool: ToolDef = {
  name: 'recommend_processing',
  description:
    'Turn a target\'s traits into a concrete process_osc recommendation (Phase 4.3): reads the ' +
    'view\'s OBJECT + FILTER, classifies the object (catalog) and filter (broadband vs dual-band), ' +
    'and returns ready-to-spread process_osc params plus rationale and things to confirm. ' +
    'Override "filter", "targetClass", or "dataType" when the header is a bare wheel position or ' +
    'the catalog misses. Omit "view" for the active image. Read-only.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    filter: z.string().optional().describe('Override the FILTER (e.g. "L-eXtreme", "UV/IR") when the header is just a position'),
    targetClass: z.enum(TARGET_CLASSES).optional().describe('Override the object classification'),
    dataType: z.enum(['broadband','duoband']).optional().describe('Force broadband/duoband (overrides filter inference)'),
    useKnowledge: z.boolean().optional().describe('Layer learned params (knowledge store) over the brief defaults (default true)'),
  },
  handler: async (backend, args) => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const metaRes = await runScriptJson(backend, metadataScript(viewId));
    const meta = 'data' in metaRes ? (metaRes.data.metadata as Record<string, unknown>) : {};
    const object = (meta?.object as string | undefined) ?? null;
    const headerFilter = (meta?.filter as string | undefined) ?? null;

    const filterStr = (args.filter as string | undefined) ?? headerFilter;
    let fr = classifyFilter(filterStr);
    if (args.dataType) fr = { dataType: args.dataType as 'broadband' | 'duoband', matched: 'override' };

    const cls = (args.targetClass as TargetClass | undefined) ?? classifyObject(object).class;
    const brief = buildBrief(object, cls, fr);

    // Phase 4.2: layer learned params (knowledge store) over the brief defaults, most-specific wins.
    const useKnowledge = args.useKnowledge !== false;
    let recommended = brief.recommended;
    let learned: Record<string, string> | undefined;
    if (useKnowledge) {
      const tk = targetKey(object);
      const k = await knowledgeResolve({ target: tk || undefined, type: cls });
      if (Object.keys(k.params).length) {
        recommended = { ...brief.recommended, ...k.params };
        learned = k.provenance;
      }
    }
    return jsonResult({
      ...brief,
      recommended,
      learned,
      filterSeen: filterStr ?? null,
      classifiedVia: args.targetClass ? 'override' : classifyObject(object).via,
      next: `process_osc with: ${JSON.stringify(recommended)}`,
    });
  },
};

export const targetTools: ToolDef[] = [resolveTargetTool, classifyTargetTool, recommendProcessingTool];
