import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import { jsonResult } from './util.js';
import { analysisTools } from './analysis.js';
import { analyzeTools } from './analyze.js';
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
function finishScript(viewId: string, backgroundTarget: number, saturation: number, unlinked: boolean, applyScnr: boolean, brightness: number): string {
  const midY = (0.5 + 0.25 * Math.max(0, Math.min(1, saturation))).toFixed(3); // sat 0→0.5(none) .. 1→0.75
  const briY = (0.3 + 0.25 * Math.max(0, Math.min(1, brightness))).toFixed(3); // midtone lift (bg anchored)
  const B = Math.max(0.03, Math.min(0.3, backgroundTarget)).toFixed(3);
  const linkedRows = unlinked
    ? `for(var c=0;c<3;c++){img.selectedChannel=c;var md=img.median(),mn=img.MAD()*1.4826;var cc=md-2.8*mn;if(cc<0)cc=0;var xx=md-cc;if(xx<0)xx=0;rows.push([cc,MTF(${B},xx),1,0,1]);}img.resetSelections();H.H=[rows[0],rows[1],rows[2],[0,0.5,1,0,1],[0,0.5,1,0,1]];`
    : `var meds=0,mads=0;for(var c=0;c<3;c++){img.selectedChannel=c;meds+=img.median();mads+=img.MAD()*1.4826;}img.resetSelections();var md=meds/3,mn=mads/3;var cc=md-2.8*mn;if(cc<0)cc=0;var xx=md-cc;if(xx<0)xx=0;var m=MTF(${B},xx);H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[cc,m,1,0,1],[0,0.5,1,0,1]];`;
  return `(function(){
  var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found: "+${JSON.stringify(viewId)}});
  var img=v.image; var rows=[];
  function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
  var H=new HistogramTransformation; ${linkedRows} H.executeOn(v); img.resetSelections();
  try{ var Ck=new CurvesTransformation; Ck.K=[[0,0],[0.12,0.11],[0.3,${briY}],[1,1]]; Ck.executeOn(v); }catch(e){}
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

/** SHARED-transform stretch: compute an auto-stretch from Ha (the dominant line) and apply the
 *  SAME HistogramTransformation to both channels, PRESERVING the true Ha:OIII ratio. Used for
 *  extended/Ha-dominant targets so the red isn't washed out (unlike per-channel equalization). */
function stretchSharedScript(haId: string, oiiiId: string, backgroundTarget: number): string {
  const B = Math.max(0.03, Math.min(0.3, backgroundTarget)).toFixed(3);
  return `(function(){
    function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
    var ha=View.viewById(${JSON.stringify(haId)}), oi=View.viewById(${JSON.stringify(oiiiId)});
    if(ha.isNull||oi.isNull) return JSON.stringify({error:"channel missing"});
    // Shared MIDTONE from Ha (preserves the Ha:OIII signal dominance -> red), but PER-CHANNEL
    // black point (clips each channel's own background -> backgrounds align -> neutral, no cast).
    var hi=ha.image; hi.resetSelections(); var hmd=hi.median(), hmn=hi.MAD()*1.4826; var hc0=hmd-2.8*hmn; if(hc0<0)hc0=0; var hxx=hmd-hc0; if(hxx<0)hxx=0; var m=MTF(${B},hxx); hi.resetSelections();
    var oimg=oi.image; oimg.resetSelections(); var omd=oimg.median(), omn=oimg.MAD()*1.4826; var oc0=omd-2.8*omn; if(oc0<0)oc0=0; oimg.resetSelections();
    var Hh=new HistogramTransformation; Hh.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[hc0,m,1,0,1],[0,0.5,1,0,1]]; Hh.executeOn(ha);
    var Ho=new HistogramTransformation; Ho.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[oc0,m,1,0,1],[0,0.5,1,0,1]]; Ho.executeOn(oi);
    return JSON.stringify({ok:true});
  })()`;
}

/** Rename an open view's id (used to prefix the final result with final_). */
function renameScript(fromId: string, toId: string): string {
  return `(function(){var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++){if(ws[i].mainView.id===${JSON.stringify(fromId)}){try{ws[i].mainView.id=${JSON.stringify(toId)};}catch(e){return JSON.stringify({error:String(e)});}return JSON.stringify({renamed:ws[i].mainView.id});}}return JSON.stringify({error:"view not found"});})()`;
}

/** Brightness (midtone lift) + saturation finish for the duoband path (channels already stretched).
 *  The K-curve lifts the nebula midtones while anchoring the low end so the background stays dark. */
function saturateScript(viewId: string, saturation: number, brightness: number): string {
  const satY = (0.5 + 0.25 * Math.max(0, Math.min(1, saturation))).toFixed(3);
  const briY = (0.3 + 0.25 * Math.max(0, Math.min(1, brightness))).toFixed(3); // x=0.3 -> y (lift mids)
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    try{ var Ck=new CurvesTransformation; Ck.K=[[0,0],[0.12,0.11],[0.3,${briY}],[1,1]]; Ck.executeOn(v); }catch(e){}
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${satY}],[1,1]]; Cs.executeOn(v); }catch(e){}
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
    coverage: z
      .enum(['compact', 'extended'])
      .optional()
      .describe(
        'duoband nebula size. compact (default, e.g. Helix): equalize channels + aggressive ' +
        'ABE/BN flatten. extended (frame-filling, Ha-dominant, e.g. Dragons of Ara): preserve ' +
        'Ha:OIII ratio (shared stretch, no LinearFit) + gentle GC + SCNR (no ABE/BN, which need sky).',
      ),
    saturation: z.number().min(0).max(1).optional().describe('Saturation boost 0..1 (default 0.5)'),
    brightness: z.number().min(0).max(1).optional().describe('Nebula midtone lift 0..1 (default 0.6); background stays dark'),
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
    const analyzeImg = findTool(analyzeTools, 'analyze_image');
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
    const brightness = (args.brightness as number) ?? 0.6;
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

    // Adaptive BXT/NXT strength from a quick SNR read (skipStars = fast). Noisier data → stronger
    // denoise + gentler nonstellar sharpening (hard sharpening amplifies noise); cleaner data →
    // lighter denoise + more detail. Star sharpening stays low regardless (avoids dark rings).
    let bxtNonstellar = 0.82, nxtDenoise = 0.9, snr: number | null = null;
    const az = await run('analyze (adaptive tuning)', analyzeImg.handler(backend, { view: workView, skipStars: true }));
    if (!isErr(az)) {
      const snrs = [...textOf(az).matchAll(/"medianOverSigma":\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]!)).filter((n) => isFinite(n));
      if (snrs.length) { snrs.sort((a, b) => a - b); snr = snrs[Math.floor(snrs.length / 2)]!; }
    }
    if (snr !== null) {
      if (snr < 40) { nxtDenoise = 0.93; bxtNonstellar = 0.7; }        // noisy
      else if (snr < 80) { nxtDenoise = 0.88; bxtNonstellar = 0.82; }  // typical
      else { nxtDenoise = 0.82; bxtNonstellar = 0.9; }                 // clean
    }
    const bxt = { sharpen_stars: 0.18, sharpen_nonstellar: bxtNonstellar, auto_nonstellar_psf: true };
    const nxt = { denoise: nxtDenoise, denoise_lf: nxtDenoise, denoise_color: nxtDenoise, denoise_lf_color: nxtDenoise };

    if (dataType === 'broadband') {
      // Gradient (linear) → natural color via SPCC → BXT/NXT
      await run('GradientCorrection', proc('GradientCorrection', workView, gc));
      const spcc = await run('SPCC', proc('SpectrophotometricColorCalibration', workView));
      if (isErr(spcc) || /"executed":\s*false/.test(textOf(spcc))) unlinked = true; // fall back to unlinked stretch
      await run('BXT', proc('BlurXTerminator', colorView, bxt));
      await run('NXT', proc('NoiseXTerminator', colorView, nxt));
    } else {
      // Duoband best practice: extract → PER-CHANNEL gradient + noise (gradients transfer on
      // combine) → LinearFit OIII to Ha → stretch each channel → THEN palette-combine (Foraxx
      // and the neutralized look need nonlinear channels).
      const ex = await run('extract_duoband', extractDuoband.handler(backend, { view: workView }));
      if (isErr(ex)) return jsonResult({ ok: false, steps, error: 'duoband extraction failed' });
      const haId = `${workView}_Ha`, oiiiId = `${workView}_OIII`;
      await run('GC(Ha)', proc('GradientCorrection', haId, gc));
      await run('GC(OIII)', proc('GradientCorrection', oiiiId, gc));
      await run('BXT(Ha)', proc('BlurXTerminator', haId, bxt));
      await run('BXT(OIII)', proc('BlurXTerminator', oiiiId, bxt));
      await run('NXT(Ha)', proc('NoiseXTerminator', haId, nxt));
      await run('NXT(OIII)', proc('NoiseXTerminator', oiiiId, nxt));
      let pal = (args.palette as string) ?? 'HOO';
      if (pal === 'natural') pal = 'HOO'; // HOO is the natural duoband palette
      const palId = pal.replace(/[^A-Za-z0-9_]/g, '_'); // view ids allow only [A-Za-z0-9_]
      const combined = `final_${palId}`;
      const coverage = (args.coverage as string) ?? 'compact';

      if (coverage === 'extended') {
        // Frame-filling / Ha-dominant (e.g. Dragons of Ara): PRESERVE the Ha:OIII ratio so the red
        // isn't washed to gray. No LinearFit (it scales weak OIII up to Ha). Shared stretch, and
        // SCNR instead of ABE/BN — the frame has no clean sky region for those.
        await run('shared stretch (preserve ratio)', toTR(backend.send('run_script', 'run_script', { code: stretchSharedScript(haId, oiiiId, backgroundTarget) })));
        const ap = await run(`apply_palette:${pal}`, applyPalette.handler(backend, { palette: pal, ha: haId, oiii: oiiiId, newImageId: combined }));
        if (isErr(ap)) return jsonResult({ ok: false, steps, error: `palette ${pal} failed` });
        await run('SCNR (green)', proc('SCNR', combined));
        // Per-channel black point leaves a mild Ha-red background tint; BN neutralizes it (the
        // frame has sky in the corners) without harming the red nebula (verified on Dragons).
        await run('BackgroundNeutralization', proc('BackgroundNeutralization', combined));
      } else {
        // Compact (e.g. Helix): equalize channels (LinearFit + per-channel stretch) then flatten
        // aggressively (ABE deg4 fits the wavy residual; BN removes the cast) — valid because the
        // frame is mostly sky.
        await run('LinearFit OIII->Ha', proc('LinearFit', oiiiId, { referenceViewId: haId }));
        await run('per-channel stretch', toTR(backend.send('run_script', 'run_script', { code: stretchMonoScript([haId, oiiiId], backgroundTarget) })));
        const ap = await run(`apply_palette:${pal}`, applyPalette.handler(backend, { palette: pal, ha: haId, oiii: oiiiId, newImageId: combined }));
        if (isErr(ap)) return jsonResult({ ok: false, steps, error: `palette ${pal} failed` });
        await run('ABE deg4 flatten', proc('AutomaticBackgroundExtractor', combined, {
          polyDegree: 4, targetCorrection: 1, replaceTarget: true, discardModel: true,
        }));
        await run('BackgroundNeutralization', proc('BackgroundNeutralization', combined));
      }
      // Final denoise on the COMBINED RGB: NXT separates luma/chroma only with all 3 channels,
      // so a pass here cleans residual chroma noise that per-channel NXT can't (repo mono-rgb doc).
      await run('final NXT (chroma)', proc('NoiseXTerminator', combined, nxt));
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
      ? saturateScript(colorView, saturation, brightness)
      : finishScript(colorView, backgroundTarget, saturation, unlinked, dataType === 'broadband', brightness);
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

    // 7) Prefix the final result with final_ (duoband already named final_<pal>; broadband result
    //    is the processed working view, so rename it here).
    if (dataType === 'broadband') {
      const rn = await run('name final', toTR(backend.send('run_script', 'run_script', { code: renameScript(colorView, 'final_natural') })));
      if (!isErr(rn)) colorView = 'final_natural';
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
