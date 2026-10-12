import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import type { ToolDef } from './types.js';
import { processingTools } from './processing.js';
import { imageTools } from './images.js';
import { analysisTools } from './analysis.js';
import { measurementTools } from './measurement.js';
import { analyzeTools } from './analyze.js';
import { knowledgeTools } from './knowledge.js';
import { targetTools } from './target.js';
import { paletteTools } from './palette.js';
import { oscTools } from './osc.js';
import { equipmentTools } from './equipment.js';
import { recipeTools } from './recipes.js';
import { preferenceTools } from './preferences.js';
import { planningTools } from './planning.js';
import { workflowTools } from './workflow.js';
import { evaluationTools } from './evaluate.js';
import { compareTools } from './compare.js';
import { maskTools } from './masks.js';
import { sessionTools } from './session.js';
import { projectTools } from './project.js';
import { backendTools } from './backends.js';
import { qualityTools } from './quality.js';
import { roiTools } from './roi.js';
import { annotateTools } from './annotate.js';
import { starTools } from './stars.js';
import { detailTools } from './detail.js';
import { prepCacheTools } from './prepcache.js';
import { knowledgeStoreTools } from './knowledgestore.js';
import { scoringTools } from './scoring.js';
import { veraluxTools } from './veralux.js';
import { selfTestTools } from './selftest.js';

/** Every AstroPilot tool across Stages 3–20 (primitives + understanding + orchestration). */
export const allTools: ToolDef[] = [
  ...imageTools, // S3 image lifecycle
  ...processingTools, // S3 process execution
  ...analysisTools, // S3 statistics/render/plate-solve
  ...measurementTools, // S4 measurement probes
  ...analyzeTools, // S4 analyze_image
  ...targetTools, // S5 target classification
  ...knowledgeTools, // S6/7/13 workflows + guidance + explain
  ...evaluationTools, // S8/15 evaluate_image
  ...qualityTools, // S22 quality gates (verify_result / check_burn)
  ...roiTools, // S23 subject auto-framing (find_subject_roi)
  ...annotateTools, // S24 LCARS acquisition card (annotate_image)
  ...starTools, // S25 star extract / recombine / reduce (StarXTerminator)
  ...detailTools, // S26 detail: HDRMT core-taming + LHE local contrast
  ...prepCacheTools, // S27 prep cache status / clear (Phase 4.1)
  ...knowledgeStoreTools, // S28 hierarchical param knowledge store (Phase 4.2)
  ...scoringTools, // S29 pick_best bracket selector (Phase 4.4)
  ...veraluxTools, // S30 VeraLux HyperMetricStretch (Phase 3.3)
  ...selfTestTools, // S31 self_test health / process-availability check
  ...maskTools, // S9 masks
  ...paletteTools, // S10 palettes
  ...oscTools, // S11 OSC + duoband
  ...equipmentTools, // S12 equipment profiles
  ...recipeTools, // S14 recipes
  ...compareTools, // S16 multi-version compare
  ...sessionTools, // S17 history/snapshot
  ...projectTools, // S17 project mgmt + report
  ...preferenceTools, // S18 preferences/memory
  ...backendTools, // S19 plugin backends
  ...planningTools, // S20 session planning
  ...workflowTools, // S21 end-to-end OSC orchestrator (data-aware palette)
];

/** Register every tool on an McpServer, binding each handler to the given backend. */
export function registerTools(server: McpServer, backend: ProcessingBackend): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>): Promise<CallToolResult> =>
        (await tool.handler(backend, args)) as unknown as CallToolResult,
    );
  }
}
