import { z } from 'zod';
import type { ToolDef } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';
import { starMetricsScript } from '../../pjsr/measure/stars.js';
import { resolveTarget } from '../../astro/simbad.js';

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

export const targetTools: ToolDef[] = [resolveTargetTool, classifyTargetTool];
