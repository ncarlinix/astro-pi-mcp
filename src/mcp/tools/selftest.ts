import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson } from './util.js';

/** Processes the pipeline relies on, grouped so a failure points at the cause (e.g. all three RC
 *  Astro modules missing → re-activate in Module Manager; VeraLux missing → not installed). */
const PROBE = {
  rcAstro: ['BlurXTerminator', 'NoiseXTerminator', 'StarXTerminator'],
  color: ['SpectrophotometricColorCalibration', 'BackgroundNeutralization', 'SCNR', 'ColorCalibration'],
  core: ['PixelMath', 'GradientCorrection', 'HistogramTransformation', 'CurvesTransformation', 'StarMask', 'IntegerResample', 'DynamicCrop'],
  detail: ['HDRMultiscaleTransform', 'LocalHistogramEqualization'],
  veralux: ['HyperMetricStretch', 'StarComposer'],
  stretch: ['GeneralizedHyperbolicStretch'],
};

function probeScript(): string {
  const all = Object.values(PROBE).flat();
  return `(function(){var names=${JSON.stringify(all)};var r={};for(var i=0;i<names.length;i++){var n=names[i];var ok=false;try{eval('new '+n+'();');ok=true;}catch(e){ok=false;}r[n]=ok;}var eng='?';try{eng=CoreApplication.versionMajor+'.'+CoreApplication.versionMinor+'.'+CoreApplication.versionRelease;}catch(e){}return JSON.stringify({processes:r,engine:eng});})()`;
}

export const selfTest: ToolDef = {
  name: 'self_test',
  description:
    'Health check: confirms the bridge is live and probes whether the PixInsight processes the ' +
    'pipeline depends on are loaded (RC Astro BXT/NXT/StarX, SPCC/colour, core, HDRMT/LHE, VeraLux, ' +
    'GHS). Run after any PixInsight update — catches the exact breakages seen before (RC Astro ' +
    'dropped by an update; VeraLux availability). Reports per-process + any missing groups + hints.',
  inputSchema: {},
  handler: async (backend): Promise<ToolResult> => {
    const alive = await backend.isAlive().catch(() => false);
    if (!alive) {
      return { content: [{ type: 'text', text: 'FAIL — watcher not responding. Start the AstroPilot watcher (Script > AstroPilot > Start Watcher, or F9).' }], isError: true };
    }
    const res = await runScriptJson(backend, probeScript(), 30_000);
    if ('error' in res) return { content: [{ type: 'text', text: `self_test probe failed: ${res.error}` }], isError: true };
    const procs = (res.data.processes ?? {}) as Record<string, boolean>;
    const missing = Object.keys(procs).filter((k) => !procs[k]);
    const groups: Record<string, string[]> = {};
    for (const [g, names] of Object.entries(PROBE)) {
      const gone = names.filter((n) => procs[n] === false);
      if (gone.length) groups[g] = gone;
    }
    const hints: string[] = [];
    if (groups.rcAstro) hints.push('RC Astro (BXT/NXT/StarX) missing — re-activate in Process > Modules after a PixInsight update.');
    if (groups.veralux) hints.push('VeraLux (HyperMetricStretch/StarComposer) missing — install its repo via Resources > Updates.');
    const pass = missing.length === 0;
    const body = { pass, engine: res.data.engine, missing, missingGroups: groups, hints: hints.length ? hints : undefined, processes: procs };
    return { content: [{ type: 'text', text: `${pass ? 'PASS' : 'ATTENTION'} — ${JSON.stringify(body, null, 2)}` }] };
  },
};

export const selfTestTools: ToolDef[] = [selfTest];
