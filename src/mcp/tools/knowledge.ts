import { z } from 'zod';
import type { ToolDef } from './types.js';
import { jsonResult } from './util.js';
import { KnowledgeBase } from '../../knowledge/index.js';

const kb = new KnowledgeBase();

export const listWorkflows: ToolDef = {
  name: 'list_workflows',
  description:
    'List the built-in per-acquisition-category processing playbooks (OSC-HOO, OSC-RGB, ' +
    'mono-RGB/LRGB/HaLRGB/SHO, mosaic). Use get_workflow to fetch one before processing.',
  inputSchema: {},
  handler: async () => {
    const wfs = await kb.listWorkflows();
    return jsonResult(wfs.map((w) => ({ category: w.category, title: w.title })));
  },
};

export const getWorkflow: ToolDef = {
  name: 'get_workflow',
  description:
    'Fetch a processing playbook by category (e.g. "osc-hoo", "mono-sho"). Returns the full ' +
    'markdown: ordered steps, per-step settings guidance, confidence, and decision criteria. ' +
    'This is the knowledge layer for Stage-6 workflow orchestration over run_process.',
  inputSchema: { category: z.string().describe('Playbook category, e.g. "osc-hoo"') },
  handler: async (_backend, args) => {
    const md = await kb.getWorkflow(args.category as string);
    if (!md) {
      const avail = (await kb.listWorkflows()).map((w) => w.category).join(', ');
      return { content: [{ type: 'text', text: `No workflow "${String(args.category)}". Available: ${avail}` }], isError: true };
    }
    return { content: [{ type: 'text', text: md }] };
  },
};

export const getProcessingGuidance: ToolDef = {
  name: 'get_processing_guidance',
  description:
    'Return the general processing decision guide (Stage 7): when DBE vs ABE, BlurX/NoiseX ' +
    'strength, SPCC vs PCC, star removal, stretch ordering, deconvolution, etc. Grounds the ' +
    'measure→configure→verify loop.',
  inputSchema: {},
  handler: async () => {
    const doc = (await kb.getDoc('PROCESSING_GUIDE')) ?? 'PROCESSING_GUIDE.md not found in docs/.';
    return { content: [{ type: 'text', text: doc }] };
  },
};

export const explainConcept: ToolDef = {
  name: 'explain',
  description:
    'Teach/explain a PixInsight or astrophotography concept (Stage 13 learning mode), e.g. ' +
    '"why BlurXTerminator", "SPCC vs PCC", "what DBE does". Returns the relevant guidance doc ' +
    'for the assistant to explain from; if a topic is given, that guidance is prioritised.',
  inputSchema: { topic: z.string().optional().describe('Concept to explain') },
  handler: async (_backend, args) => {
    const guide = (await kb.getDoc('PROCESSING_GUIDE')) ?? '';
    const topic = (args.topic as string | undefined)?.trim();
    const header = topic ? `Explain: ${topic}\n\n` : '';
    return {
      content: [
        {
          type: 'text',
          text:
            header +
            (guide
              ? guide
              : 'No PROCESSING_GUIDE.md available; answer from first principles and the workflow playbooks (list_workflows).'),
        },
      ],
    };
  },
};

export const knowledgeTools: ToolDef[] = [
  listWorkflows,
  getWorkflow,
  getProcessingGuidance,
  explainConcept,
];
