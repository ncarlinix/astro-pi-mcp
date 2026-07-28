import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import { jsonResult } from './util.js';
import { analysisTools } from './analysis.js';
import { oscTools } from './osc.js';
import { paletteTools } from './palette.js';

/** Locate a sibling tool by name so this orchestrator reuses the same validated handlers. */
function findTool(list: ToolDef[], name: string): ToolDef {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`internal: tool "${name}" not found`);
  return t;
}

const isErr = (r: ToolResult): boolean => r.isError === true;
const textOf = (r: ToolResult): string => (r.content ?? []).map((c) => ('text' in c ? c.text : '')).join(' ');

/** Linked-stretch (color-calibrated) or unlinked (uncalibrated) with a chosen background
 *  target, then a saturation boost and green-cast removal. Returns a run_script code string. */
function finishScript(viewId: string, backgroundTarget: number, saturation: number, unlinked: boolean, applyScnr: boolean): string {
  const midY = (0.5 + 0.25 * Math.max(0, Math.min(1, saturation))).toFixed(3); // sat 0→0.5(none) .. 1→0.75
  const B = Math.max(0.03, Math.min(0.3, backgroundTarget)).toFixed(3);
  const linkedRows = unlinked
    ? `for(var c=0;c<3;c++){img.selectedChannel=c;var md=img.median(),mn=img.MAD()*1.4826;var cc=md-2.8*mn;if(cc<0)cc=0;var xx=md-cc;if(xx<0)xx=0;rows.push([cc,MTF(${B},xx),1,0,1]);}img.resetSelections();H.H=[rows[0],rows[1],rows[2],[0,0.5,1,0,1],[0,0.5,1,0,1]];`
    : `var meds=0,mads=0;for(var c=0;c<3;c++){img.selectedChannel=c;meds+=img.median();mads+=img.MAD()*1.4826;}img.resetSelections();var md=meds/3,mn=mads/3;var cc=md-2.8*mn;if(cc<0)cc=0;var xx=md-cc;if(xx<0)xx=0;var m=MTF(${B},xx);H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[cc,m,1,0,1],[0,0.5,1,0,1]];`;
  return `(function(){
  var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found: "+${JSON.stringify(viewId)}});
  var img=v.image; var rows=[];
  function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
  var H=new HistogramTransformation; ${linkedRows} H.executeOn(v); img.resetSelections();
  try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${midY}],[1,1]]; Cs.executeOn(v); }catch(e){}
  ${applyScnr ? 'try{ var sc=new SCNR; sc.amount=0.75; sc.executeOn(v); }catch(e){}' : '/* SCNR skipped: green carries Ha in palettes */'}
  return JSON.stringify({ok:true});
})()`;
}

/** Per-channel mono auto-stretch to a background target — used on Ha/OIII before palette
 *  combination (Foraxx and friends operate on nonlinear channels). */
function stretchMonoScript(ids: string[], backgroundTarget: number): string {
  const B = Math.max(0.03, Math.min(0.3, backgroundTarget)).toFixed(3);
  return `(function(){
    function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
    var ids=${JSON.stringify(ids)}; var done=[];
    for(var k=0;k<ids.length;k++){
      var v=View.viewById(ids[k]); if(v.isNull) continue;
      var img=v.image; img.resetSelections();
      var md=img.median(), mn=img.MAD()*1.4826; var c0=md-2.8*mn; if(c0<0)c0=0; var xx=md-c0; if(xx<0)xx=0; var m=MTF(${B},xx);
      var H=new HistogramTransformation; H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]]; H.executeOn(v); img.resetSelections();
      done.push(ids[k]);
    }
    return JSON.stringify({stretched:done});
  })()`;
}

/** Saturation-only finish for the duoband path (channels are already stretched before combine). */
function saturateScript(viewId: string, saturation: number): string {
  const midY = (0.5 + 0.25 * Math.max(0, Math.min(1, saturation))).toFixed(3);
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${midY}],[1,1]]; Cs.executeOn(v); }catch(e){}
    return JSON.stringify({ok:true});
  })()`;
}

/** Adapt a raw bridge run_script result into a ToolResult for the step logger. */
function toTR(p: Promise<{ status: string; outputs?: unknown; error?: unknown }>): Promise<ToolResult> {
  return p.then((br) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(br.outputs ?? br.error ?? {}) }],
    isError: br.status === 'error',
  }));
}

export const processOsc: ToolDef = {
  name: 'process_osc',
  description:
    'End-to-end OSC processing in one call. Data-aware: broadband → plate solve, ' +
    'GradientCorrection, SPCC (natural color); duoband (L-eXtreme/L-Ultimate) → extract Ha/OIII ' +
    'and combine into the chosen palette (HOO / synthetic-SHO). Then BXT, NXT, background-targeted ' +
    'stretch, star handling, and saturation. Composes the validated primitives (plate_solve, ' +
    'run_process, extract_duoband, apply_palette). NOTE: the duoband + palette path needs ' +
    'validation on real duoband data; foraxx is not built in (its expression is not hard-coded).',
  inputSchema: {
    view: z.string().optional().describe('Source view id; omit for the active image'),
    dataType: z.enum(['broadband', 'duoband']).describe('broadband (RGB) or duoband (dual narrowband OSC)'),
    palette: z
      .enum(['natural', 'HOO', 'synthetic-SHO', 'foraxx'])
      .optional()
      .describe('duoband: HOO (default), foraxx (dynamic), or synthetic-SHO (artistic). Ignored for broadband.'),
    starHandling: z.enum(['keep', 'reduce', 'starless']).optional().describe('Default keep'),
    saturation: z.number().min(0).max(1).optional().describe('Saturation boost 0..1 (default 0.5)'),
    backgroundTarget: z.number().min(0.03).max(0.3).optional().describe('Stretch background level (default 0.10)'),
    solve: z.boolean().optional().describe('Plate solve first (default true)'),
  },
  handler: async (backend: ProcessingBackend, args): Promise<ToolResult> => {
    const steps: string[] = [];
    const run = async (label: string, r: Promise<ToolResult>): Promise<ToolResult> => {
      const res = await r;
      steps.push(`${label}: ${isErr(res) ? 'ERROR — ' + textOf(res).slice(0, 160) : 'ok'}`);
      return res;
    };

    const plateSolve = findTool(analysisTools, 'plate_solve');
    const extractDuoband = findTool(oscTools, 'extract_duoband');
    const applyPalette = findTool(paletteTools, 'apply_palette');

    // run_process lives in processingTools; import lazily to avoid a hard import cycle risk.
    const { processingTools } = await import('./processing.js');
    const rp = findTool(processingTools, 'run_process');
    const proc = (processId: string, view: string, settings?: Record<string, unknown>) =>
      rp.handler(backend, { processId, view, ...(settings ? { settings } : {}) });

    const dataType = args.dataType as 'broadband' | 'duoband';
    const starHandling = (args.starHandling as string) ?? 'keep';
    const saturation = (args.saturation as number) ?? 0.5;
    const backgroundTarget = (args.backgroundTarget as number) ?? 0.1;
    const solve = args.solve !== false;
    const view = (args.view as string | undefined) ?? undefined;

    // 1) Plate solve (WCS lands on the original view via the copy-astrometry fix)
    let workView = view ?? 'integration';
    if (solve) {
      const s = await run('plate_solve', plateSolve.handler(backend, { view }));
      if (!isErr(s)) {
        const m = /"solvedViewId":\s*"([^"]+)"/.exec(textOf(s));
        if (m) workView = m[1]!;
      }
    }

    let colorView = workView;
    let unlinked = false;
    let preStretched = false; // duoband path stretches channels before combining
    const gc = { protection: true, protectionThreshold: 0.1, protectionAmount: 0.5, scale: 5, smoothness: 0.4 };

    if (dataType === 'broadband') {
      // Gradient (linear) → natural color via SPCC → BXT/NXT
      await run('GradientCorrection', proc('GradientCorrection', workView, gc));
      const spcc = await run('SPCC', proc('SpectrophotometricColorCalibration', workView));
      if (isErr(spcc) || /"executed":\s*false/.test(textOf(spcc))) unlinked = true; // fall back to unlinked stretch
      await run('BXT', proc('BlurXTerminator', colorView));
      await run('NXT', proc('NoiseXTerminator', colorView));
    } else {
      // Duoband best practice: extract → PER-CHANNEL gradient + noise (gradients transfer on
      // combine) → LinearFit OIII to Ha → stretch each channel → THEN palette-combine (Foraxx
      // and the neutralized look need nonlinear channels).
      const ex = await run('extract_duoband', extractDuoband.handler(backend, { view: workView }));
      if (isErr(ex)) return jsonResult({ ok: false, steps, error: 'duoband extraction failed' });
      const haId = `${workView}_Ha`, oiiiId = `${workView}_OIII`;
      await run('GC(Ha)', proc('GradientCorrection', haId, gc));
      await run('GC(OIII)', proc('GradientCorrection', oiiiId, gc));
      await run('BXT(Ha)', proc('BlurXTerminator', haId));
      await run('BXT(OIII)', proc('BlurXTerminator', oiiiId));
      await run('NXT(Ha)', proc('NoiseXTerminator', haId));
      await run('NXT(OIII)', proc('NoiseXTerminator', oiiiId));
      await run('LinearFit OIII->Ha', proc('LinearFit', oiiiId, { referenceViewId: haId }));
      await run('stretch channels', toTR(backend.send('run_script', 'run_script', { code: stretchMonoScript([haId, oiiiId], backgroundTarget) })));
      const pal = (args.palette as string) ?? 'HOO';
      if (pal === 'natural') return jsonResult({ ok: false, steps, error: 'natural palette is broadband-only' });
      // PixInsight view ids allow only [A-Za-z0-9_] and can't start with a digit, so "synthetic-SHO"
      // must be sanitized or the created view id won't match what we later look up.
      const combined = `${pal.replace(/[^A-Za-z0-9_]/g, '_')}_result`;
      const ap = await run(`apply_palette:${pal}`, applyPalette.handler(backend, { palette: pal, ha: haId, oiii: oiiiId, newImageId: combined }));
      if (isErr(ap)) return jsonResult({ ok: false, steps, error: `palette ${pal} failed` });
      colorView = combined;
      preStretched = true; // channels were already stretched before combine
    }

    // 4) Star handling (split before stretch when reducing/removing)
    let starsView: string | null = null;
    if (starHandling === 'reduce' || starHandling === 'starless') {
      const sx = await run('StarXTerminator', proc('StarXTerminator', colorView, { stars: true, unscreen: true }));
      if (!isErr(sx)) starsView = `${colorView}_stars`;
    }

    // 5) Finish on the (starless, if split) nebula. Broadband: stretch + saturation + SCNR.
    //    Duoband: channels were already stretched before combine, so saturation only.
    const finishCode = preStretched
      ? saturateScript(colorView, saturation)
      : finishScript(colorView, backgroundTarget, saturation, unlinked, dataType === 'broadband');
    await run('finish', toTR(backend.send('run_script', 'run_script', { code: finishCode })));

    // 6) Recombine stars for 'reduce' (dim + screen); 'starless' leaves them off
    if (starHandling === 'reduce' && starsView) {
      const recombine = `(function(){
        var s=ImageWindow.windowById(${JSON.stringify(starsView)}); if(!s.isNull){ var H=new HistogramTransformation; H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[0.12,0.45,1,0,1],[0,0.5,1,0,1]]; H.executeOn(s.mainView); }
        var neb=View.viewById(${JSON.stringify(colorView)});
        var PM=new PixelMath; PM.expression="~(~"+${JSON.stringify(colorView)}+" * ~"+${JSON.stringify(starsView)}+")"; PM.useSingleExpression=true; PM.createNewImage=false; PM.executeOn(neb);
        return JSON.stringify({ok:true});
      })()`;
      await run('recombine stars (dimmed)', backend.send('run_script', 'run_script', { code: recombine })
        .then((br) => ({ content: [{ type: 'text' as const, text: '' }], isError: br.status === 'error' })));
    }

    return jsonResult({
      ok: true,
      resultView: colorView,
      dataType,
      palette: dataType === 'duoband' ? ((args.palette as string) ?? 'HOO') : 'natural',
      starHandling,
      backgroundTarget,
      saturation,
      colorFallbackUnlinked: unlinked,
      steps,
      note:
        'Composed from validated primitives. The duoband/palette path needs validation on real ' +
        'duoband (L-eXtreme/L-Ultimate) data. For foraxx, apply its authoritative PixelMath via run_process("PixelMath").',
    });
  },
};

export const workflowTools: ToolDef[] = [processOsc];
