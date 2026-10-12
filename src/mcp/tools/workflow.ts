import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import type { ProcessingBackend } from '../../backend/types.js';
import { jsonResult } from './util.js';
import { analysisTools } from './analysis.js';
import { analyzeTools } from './analyze.js';
import { oscTools } from './osc.js';
import { paletteTools } from './palette.js';
import { stat } from 'node:fs/promises';
import { prepFingerprint, cacheLookup, cacheArtifactPath, cacheStore } from '../../prep/cache.js';

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
  var H=new HistogramTransformation; ${linkedRows} H.executeOn(v,false); img.resetSelections();
  try{ var Ck=new CurvesTransformation; Ck.K=[[0,0],[0.12,0.11],[0.3,${briY}],[1,1]]; Ck.executeOn(v,false); }catch(e){}
  try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${midY}],[1,1]]; Cs.executeOn(v,false); }catch(e){}
  ${applyScnr ? 'try{ var sc=new SCNR; sc.amount=0.75; sc.executeOn(v,false); }catch(e){}' : '/* SCNR skipped: green carries Ha in palettes */'}
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
      var H=new HistogramTransformation; H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]]; H.executeOn(v,false); img.resetSelections();
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
    var Hh=new HistogramTransformation; Hh.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[hc0,m,1,0,1],[0,0.5,1,0,1]]; Hh.executeOn(ha,false);
    var Ho=new HistogramTransformation; Ho.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[oc0,m,1,0,1],[0,0.5,1,0,1]]; Ho.executeOn(oi,false);
    return JSON.stringify({ok:true});
  })()`;
}

/** Force-close a list of view ids if they exist (frees full-res pixel data + any history).
 *  Used to drop intermediates (stars/Ha/OIII) and to purge stale windows from prior runs so
 *  RAM does not grow across invocations. */
function closeViewsScript(ids: string[]): string {
  return `(function(){
    var ids=${JSON.stringify(ids)}, closed=[];
    for(var i=0;i<ids.length;i++){ var w=ImageWindow.windowById(ids[i]); if(w && !w.isNull){ try{ w.forceClose(); closed.push(ids[i]); }catch(e){} } }
    return JSON.stringify({closed:closed});
  })()`;
}

/** Close pipeline JUNK windows that pile up across runs: the master's embedded rejection maps
 *  (integration_rejection_low/high…) that open alongside it, plus any leftover masks / split-star
 *  windows. Matches by id pattern and NEVER closes the result (keepId) or a plain integration view.
 *  This bounds per-run window growth (each run otherwise leaves ~2 full-res rejection windows). */
function closePipelineJunkScript(keepId: string): string {
  return `(function(){
    var keep=${JSON.stringify(keepId)};
    var re=/(_rejection_|_rejection$|rejection_high|rejection_low|_mask$|nebmask|nebboost|_stars$|_Ha$|_OIII$)/i;
    var ws=ImageWindow.windows, closed=[];
    for(var i=ws.length-1;i>=0;i--){ var id=ws[i].mainView.id; if(id===keep) continue; if(re.test(id)){ try{ ws[i].forceClose(); closed.push(id); }catch(e){} } }
    return JSON.stringify({closed:closed});
  })()`;
}

/** Rename an open view's id (used to prefix the final result with final_). */
function renameScript(fromId: string, toId: string): string {
  return `(function(){var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++){if(ws[i].mainView.id===${JSON.stringify(fromId)}){try{ws[i].mainView.id=${JSON.stringify(toId)};}catch(e){return JSON.stringify({error:String(e)});}return JSON.stringify({renamed:ws[i].mainView.id});}}return JSON.stringify({error:"view not found"});})()`;
}

/** Brightness (midtone lift) + saturation finish for already-stretched images.
 *  The K-curve lifts the nebula midtones while anchoring the low end so the background stays dark.
 *  applyScnr removes a green cast (broadband) — skipped for palettes where green carries Ha. */
function saturateScript(viewId: string, saturation: number, brightness: number, applyScnr = false): string {
  const satY = (0.5 + 0.25 * Math.max(0, Math.min(1, saturation))).toFixed(3);
  const briY = (0.3 + 0.25 * Math.max(0, Math.min(1, brightness))).toFixed(3); // x=0.3 -> y (lift mids)
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    try{ var Ck=new CurvesTransformation; Ck.K=[[0,0],[0.12,0.11],[0.3,${briY}],[1,1]]; Ck.executeOn(v,false); }catch(e){}
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${satY}],[1,1]]; Cs.executeOn(v,false); }catch(e){}
    ${applyScnr ? 'try{ var sc=new SCNR; sc.amount=0.75; sc.executeOn(v,false); }catch(e){}' : ''}
    return JSON.stringify({ok:true});
  })()`;
}

/** GeneralizedHyperbolicStretch (GHS) stretch of LINEAR data. Unlike a plain MTF autostretch, GHS
 *  focuses added contrast around a symmetry point (SP) placed on the background peak, giving more
 *  nebula contrast without over-stretching star cores (less pixelation). Auto-tuned from the image
 *  statistics: black point clipped at median-2.8·MAD, SP on the background median, with D/b setting
 *  the stretch intensity. Applied to all channels together (SC_RGB) so SPCC colour is preserved.
 *  PJSR identifiers verified against the live module (stretchFactor=D, localIntensity=b, etc.). */
function ghsStretchScript(viewId: string, D: number, b: number, backgroundTarget: number): string {
  const B = Math.max(0.03, Math.min(0.3, backgroundTarget)).toFixed(3);
  return `(function(){
    function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    var img=v.image; img.resetSelections();
    var nch=img.numberOfChannels, meds=0, mads=0;
    for(var c=0;c<nch;c++){ img.selectedChannel=c; meds+=img.median(); mads+=img.MAD()*1.4826; }
    img.resetSelections();
    var med=meds/nch, mad=mads/nch;
    var bp=med-2.8*mad; if(bp<0)bp=0; if(bp>0.2)bp=0.2;
    var sp=med; if(sp<bp)sp=bp; if(sp>0.9)sp=0.9;
    var g=new GeneralizedHyperbolicStretch;
    g.stretchType=0;          // ST_GeneralisedHyperbolic
    g.stretchChannel=3;       // SC_RGB — stretch all channels together (preserve colour)
    g.stretchFactor=${D};     // D  — stretch intensity
    g.localIntensity=${b};    // b  — local contrast focus around SP
    g.symmetryPoint=sp;       // SP — placed on the background peak
    g.shadowProtection=0;     // LP
    g.highlightProtection=1;  // HP
    g.blackPoint=bp;          // BP — clip the background
    g.whitePoint=1;           // WP
    g.colourBlend=1; g.clipType=2; g.useRGBWorkingSpace=false; g.inverse=false;
    g.executeOn(v,false); img.resetSelections();
    // The GH curve lifts everything toward mid-grey but leaves the nebula dim. Re-anchor with an
    // MTF stretch to the background TARGET: sets the black point AND lifts midtones to a known level
    // (not just a black clip — that darkened the sky without brightening the nebula = "too dim").
    var m2=0,s2=0; for(var c=0;c<nch;c++){ img.selectedChannel=c; m2+=img.median(); s2+=img.MAD()*1.4826; } img.resetSelections();
    m2/=nch; s2/=nch; var c0=m2-2.8*s2; if(c0<0)c0=0; var xm=m2-c0; if(xm<0)xm=0; var mt=MTF(${B},xm);
    var H=new HistogramTransformation; H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,mt,1,0,1],[0,0.5,1,0,1]]; H.executeOn(v,false); img.resetSelections();
    return JSON.stringify({ok:true, med:med, mad:mad, blackPoint:bp, symmetryPoint:sp, bgClip:c0, bgMidtone:mt, D:${D}, b:${b}});
  })()`;
}

/** Nebula-only saturation boost via a RangeSelection mask (bright nebula selected, background
 *  protected). Only meaningful on a STARLESS image — otherwise the mask would grab stars too. */
function nebulaMaskSatScript(viewId: string, saturation: number): string {
  const satY = (0.55 + 0.15 * Math.max(0, Math.min(1, saturation))).toFixed(3);
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    var R=new RangeSelection; R.lowRange=0.10; R.highRange=1.0; R.fuzziness=0.4; R.smoothness=12; R.lightness=true; R.invert=false;
    R.executeOn(v,false);
    var ws=ImageWindow.windows; var mw=ws[ws.length-1]; mw.mainView.id="nebmask_tmp";
    v.window.mask=mw; v.window.maskInverted=false; v.window.maskEnabled=true; v.window.maskVisible=false;
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${satY}],[1,1]]; Cs.executeOn(v,false); }catch(e){}
    v.window.removeMask(); mw.forceClose();
    return JSON.stringify({ok:true});
  })()`;
}

/** Star-separation recombine: independently stretch the (linear) stars image to a low background
 *  so cores stay TIGHT, optionally dim it (reduce mode), then screen it back onto the stretched
 *  starless nebula. This is what lets the nebula be pushed bright while stars stay pinpoint. */
function starsRecombineScript(nebViewId: string, starsViewId: string, dim: boolean): string {
  return `(function(){
    function MTF(m,x){ if(x<=0)return 0; if(x>=1)return 1; return ((m-1)*x)/(((2*m-1)*x)-m); }
    var neb=View.viewById(${JSON.stringify(nebViewId)}); var sw=ImageWindow.windowById(${JSON.stringify(starsViewId)});
    if(neb.isNull||sw.isNull||sw.isNull===undefined) return JSON.stringify({error:"nebula or stars view missing"});
    var sv=sw.mainView, si=sv.image; si.resetSelections();
    var nch=si.numberOfChannels, sm=0, ss=0;
    for(var c=0;c<nch;c++){ si.selectedChannel=c; sm+=si.median(); ss+=si.MAD()*1.4826; } si.resetSelections();
    sm/=nch; ss/=nch; var sc0=sm-2.8*ss; if(sc0<0)sc0=0; var sxx=sm-sc0; if(sxx<0)sxx=0; var smt=MTF(0.06,sxx);
    var Hs=new HistogramTransformation; Hs.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[sc0,smt,1,0,1],[0,0.5,1,0,1]]; Hs.executeOn(sv,false); si.resetSelections();
    ${dim ? 'try{ var Cd=new CurvesTransformation; Cd.K=[[0,0],[0.5,0.32],[1,0.85]]; Cd.executeOn(sv,false); }catch(e){}' : ''}
    var PM=new PixelMath; PM.expression="~(~"+${JSON.stringify(nebViewId)}+" * ~"+${JSON.stringify(starsViewId)}+")"; PM.useSingleExpression=true; PM.createNewImage=false; PM.executeOn(neb,false);
    return JSON.stringify({ok:true, starsBlackPoint:sc0, starsMidtone:smt, dimmed:${dim ? 'true' : 'false'}});
  })()`;
}

/** Nebula-only BRIGHTEN + CONTRAST + SATURATION through a RangeSelection mask. Selects the bright
 *  nebula and protects the dark background, so the sky stays clean/gradient-free while the nebula
 *  gains brightness, punch and colour. This is the fix for "MTF background is cleanest but the
 *  nebula isn't bright enough" — boost locally instead of stretching harder globally. boost 0..1
 *  scales the effect from identity to a strong lift. */
function nebulaBoostScript(viewId: string, boost: number): string {
  const b = Math.max(0, Math.min(1, boost));
  // Interpolate curve node y-values from identity (b=0) toward the validated strong look (b=1).
  const y15 = (0.15 + b * (0.14 - 0.15)).toFixed(3); // slight toe (contrast)
  const y40 = (0.40 + b * (0.52 - 0.40)).toFixed(3); // midtone lift
  const y70 = (0.70 + b * (0.82 - 0.70)).toFixed(3); // upper-mid lift
  const sat = (0.5 + b * (0.72 - 0.5)).toFixed(3);   // saturation midpoint
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    var R=new RangeSelection; R.lowRange=0.10; R.highRange=1.0; R.fuzziness=0.5; R.smoothness=18; R.lightness=true; R.invert=false;
    R.executeOn(v,false);
    var ws=ImageWindow.windows; var mw=ws[ws.length-1]; mw.mainView.id="nebboost_tmp";
    v.window.mask=mw; v.window.maskInverted=false; v.window.maskEnabled=true; v.window.maskVisible=false;
    try{ var Ck=new CurvesTransformation; Ck.K=[[0,0],[0.15,${y15}],[0.4,${y40}],[0.7,${y70}],[1,1]]; Ck.executeOn(v,false); }catch(e){}
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,${sat}],[1,1]]; Cs.executeOn(v,false); }catch(e){}
    v.window.removeMask(); mw.forceClose();
    return JSON.stringify({ok:true, boost:${b}});
  })()`;
}

/** Star REDUCTION of an ALREADY-SPLIT stars layer (screen-space; caller splits with unscreen=false
 *  so screen(starless,stars)==original), then screens it back onto the (starless) nebula view. Uses
 *  a smooth Morphological SELECTION to shrink star radii ROUNDLY (avoids the flat-disk / hard-ring
 *  artifacts that Erosion + a hard toe curve produce), a SOFT taper to fade faint stars without a
 *  sharp edge, and SCNR + slight desaturation so cores read white. Closes the stars window after.
 *  strength 0..1 → stronger shrink + more faint-star removal. */
function reduceStarsLayerScript(nebViewId: string, starsViewId: string, strength: number): string {
  const s = Math.max(0, Math.min(1, strength));
  const selPt = (0.36 - 0.20 * s).toFixed(3);      // selection point <0.5 biases to shrink; lower = smaller stars
  const iters = s >= 0.85 ? 3 : (s >= 0.4 ? 2 : 1); // morphological iterations
  const amount = (0.5 + 0.31 * s).toFixed(3);       // 0.5 → 0.81 blend
  const tp = (0.06 + 0.20 * s).toFixed(3);          // soft-taper knee: faint stars below this fade (smoothly)
  const tpy = (0.06 + 0.20 * s) * 0.22;             // taper y at the knee (small but non-zero → no hard ring)
  return `(function(){
    var neb=View.viewById(${JSON.stringify(nebViewId)}); var sw=ImageWindow.windowById(${JSON.stringify(starsViewId)});
    if(neb.isNull){ return JSON.stringify({error:"nebula view missing"}); }
    if(sw.isNull){ var ws=ImageWindow.windows; for(var i=0;i<ws.length;i++){ if(/_stars$/.test(ws[i].mainView.id)) sw=ws[i]; } }
    if(!sw||sw.isNull) return JSON.stringify({error:"stars view missing"});
    var sv=sw.mainView;
    // Morphological SELECTION (operator 5): smooth, round shrink of star radii — no flat tops.
    try{ var M=new MorphologicalTransformation; M.operator=5; M.selectionPoint=${selPt}; M.structureSize=5; M.numberOfIterations=${iters}; M.amount=${amount}; M.executeOn(sv,false); }catch(e){}
    // Soft taper: fade faint stars/halos smoothly (no hard cutoff → no ring). Bright cores ~identity.
    try{ var Cf=new CurvesTransformation; Cf.K=[[0,0],[${tp},${tpy.toFixed(3)}],[0.5,0.44],[1,1]]; Cf.executeOn(sv,false); }catch(e){}
    // Colour: strip green, slight desaturate so bright cores read white.
    try{ var scn=new SCNR; scn.amount=0.8; scn.executeOn(sv,false); }catch(e){}
    try{ var Cs=new CurvesTransformation; Cs.S=[[0,0],[0.5,0.42],[1,1]]; Cs.executeOn(sv,false); }catch(e){}
    var PM=new PixelMath; PM.expression="~(~"+${JSON.stringify(nebViewId)}+" * ~"+sw.mainView.id+")"; PM.useSingleExpression=true; PM.createNewImage=false; PM.executeOn(neb,false);
    try{ sw.forceClose(); }catch(e){}
    return JSON.stringify({ok:true, selectionPoint:${selPt}, iterations:${iters}, strength:${s}});
  })()`;
}

/** Deepen the background toward true black with a per-channel black-point pull. Clips the sky
 *  low end to zero WITHOUT touching the nebula midtones (everything above the clip is just
 *  rescaled slightly brighter). Strength 0 = gentle (clip at median-2.8σ), 1 = hard (median-1.0σ). */
function deepenBackgroundScript(viewId: string, strength: number): string {
  const k = (2.8 - 1.8 * Math.max(0, Math.min(1, strength))).toFixed(2); // 0→2.8σ, 1→1.0σ
  return `(function(){
    var v=View.viewById(${JSON.stringify(viewId)}); if(v.isNull) return JSON.stringify({error:"view not found"});
    var img=v.image; img.resetSelections();
    var nch=img.numberOfChannels, m=0, s=0;
    for(var c=0;c<nch;c++){ img.selectedChannel=c; m+=img.median(); s+=img.MAD()*1.4826; } img.resetSelections();
    m/=nch; s/=nch; var c0=m-${k}*s; if(c0<0)c0=0;
    var H=new HistogramTransformation; H.H=[[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,0.5,1,0,1],[0,0.5,1,0,1]]; H.executeOn(v,false); img.resetSelections();
    return JSON.stringify({ok:true, blackPoint:c0, sigmaK:${k}});
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
    starHandling: z
      .enum(['keep', 'separate', 'reduce', 'starless'])
      .optional()
      .describe(
        "Default keep (single stretch). 'separate': StarXTerminator split, stretch the starless " +
        "nebula bright + independently stretch stars, then screen back — bright nebula + tight " +
        "stars. 'reduce': like separate but dims the stars. 'starless': discard stars.",
      ),
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
    gradientTool: z.enum(['gc', 'none']).optional().describe("Gradient step: 'gc' (default GradientCorrection) or 'none' (skip, e.g. already GraXpert-processed)"),
    backgroundTarget: z.number().min(0.03).max(0.3).optional().describe('Stretch background level (default 0.10). Used by the mtf stretch; ghs auto-tunes from image stats.'),
    backgroundBlack: z.number().min(0).max(1).optional().describe('Deepen the background toward black at the end (broadband). 0=off, 1=hard clip. Default 0.35.'),
    nebulaBoost: z.number().min(0).max(1).optional().describe('Brighten + contrast + saturate the NEBULA only, via a mask (background stays clean/gradient-free). 0=off, 1=strong. Default 0.6 (broadband).'),
    stretch: z
      .enum(['mtf', 'ghs'])
      .optional()
      .describe(
        "Stretch method (broadband). 'mtf' (default): MTF autostretch to backgroundTarget. " +
        "'ghs': GeneralizedHyperbolicStretch — more nebula contrast, tighter/less-pixelated stars.",
      ),
    ghsD: z.number().min(0).max(30).optional().describe('GHS stretch intensity D (default 8)'),
    ghsB: z.number().min(-5).max(15).optional().describe('GHS local intensity b (default -1)'),
    starReduction: z.number().min(0).max(1).optional().describe("Star-shrink strength for starHandling:'reduce' (0=subtle, 1=strong). Default 0.5"),
    solve: z.boolean().optional().describe('Plate solve first (default true)'),
    cache: z.boolean().optional().describe('Reuse a cached post-NXT linear prep when the same source master + prep params were processed before (broadband only). Default false. See prep_cache_status.'),
    refresh: z.boolean().optional().describe('With cache:true, ignore any existing cache entry and re-run the prep, then overwrite the cache. Default false.'),
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
    const gradientTool = (args.gradientTool as string) ?? 'gc';
    const backgroundTarget = (args.backgroundTarget as number) ?? 0.1;
    const stretch = (args.stretch as string) ?? 'mtf';
    const ghsD = (args.ghsD as number) ?? 8;
    const ghsB = (args.ghsB as number) ?? -1;
    const backgroundBlack = (args.backgroundBlack as number) ?? 0.35;
    const nebulaBoost = (args.nebulaBoost as number) ?? 0.6;
    const starReduction = (args.starReduction as number) ?? 0.5;
    const solve = args.solve !== false;
    const useCache = args.cache === true;
    const refresh = args.refresh === true;
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
    const intermediates: string[] = []; // full-res windows to force-close at the end (free RAM)

    // Purge leftovers from a prior/interrupted run so RAM doesn't grow across invocations and the
    // final rename doesn't collide (final_natural1, final_natural2, …). Targets only ids THIS run
    // produces, plus final_natural — never the caller's source view.
    await run('purge stale windows', toTR(backend.send('run_script', 'run_script', {
      code: closeViewsScript(['final_natural', `${workView}_stars`, `${workView}_Ha`, `${workView}_OIII`].filter((id) => id !== workView)),
    })));
    // Sweep leftover rejection maps / masks / star layers from any prior run (keep the source view).
    await run('purge pipeline junk', toTR(backend.send('run_script', 'run_script', { code: closePipelineJunkScript(workView) })));
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

    // 4.1 prep cache (opt-in, broadband): fingerprint the source master + prep params; on a hit,
    // load the cached post-NXT linear image and skip GC/SPCC/BXT/NXT. Fully fail-safe.
    let prepFp: string | null = null;
    let prepSourcePath = '';
    let cacheHit = false;
    if (useCache && dataType === 'broadband') {
      try {
        const probe = await backend.send('run_script', 'run_script', {
          code: `(function(){var v=View.viewById(${JSON.stringify(workView)});var w=(v&&!v.isNull)?v.window:null;return JSON.stringify({filePath:(w&&!w.isNull)?w.filePath:""});})()`,
        });
        const rv = (probe.outputs as { returnValue?: string } | undefined)?.returnValue;
        prepSourcePath = rv ? (JSON.parse(rv).filePath || '') : '';
        if (prepSourcePath) {
          const st = await stat(prepSourcePath);
          prepFp = prepFingerprint({ sourcePath: prepSourcePath, sizeBytes: st.size, mtimeMs: st.mtimeMs, params: { v: 1, gradientTool, gc, bxt, nxt, spcc: true, solve } });
          if (!refresh) {
            const hit = await cacheLookup(prepFp);
            if (hit) {
              const op = await run('prep cache HIT (load linear)', toTR(backend.send('open_image', '__internal__', { filePath: hit.file })));
              if (!isErr(op)) {
                const m = /"id":\s*"([^"]+)"/.exec(textOf(op));
                if (m) { workView = m[1]!; colorView = workView; cacheHit = true; }
              }
            }
          }
        }
      } catch { /* no cache; fall through to a normal prep */ }
    }

    if (dataType === 'broadband') {
      if (!cacheHit) {
        // Gradient (linear) → natural color via SPCC → BXT/NXT
        if (gradientTool !== 'none') await run('GradientCorrection', proc('GradientCorrection', workView, gc));
        const spcc = await run('SPCC', proc('SpectrophotometricColorCalibration', workView));
        if (isErr(spcc) || /"executed":\s*false/.test(textOf(spcc))) unlinked = true; // fall back to unlinked stretch
        await run('BXT', proc('BlurXTerminator', colorView, bxt));
        await run('NXT', proc('NoiseXTerminator', colorView, nxt));
        // 4.1: cache the post-NXT linear prep for identical future runs (best-effort; never fatal).
        if (useCache && prepFp) {
          try {
            const artifact = await cacheArtifactPath(prepFp);
            const sv = await run('cache prep (save linear)', toTR(backend.send('save_image', '__internal__', { viewId: colorView, filePath: artifact, overwrite: true })));
            if (!isErr(sv)) await cacheStore({ fingerprint: prepFp, file: artifact, sourcePath: prepSourcePath });
          } catch { /* caching is best-effort */ }
        }
      }
    } else {
      // Duoband best practice: extract → PER-CHANNEL gradient + noise (gradients transfer on
      // combine) → LinearFit OIII to Ha → stretch each channel → THEN palette-combine (Foraxx
      // and the neutralized look need nonlinear channels).
      const ex = await run('extract_duoband', extractDuoband.handler(backend, { view: workView }));
      if (isErr(ex)) return jsonResult({ ok: false, steps, error: 'duoband extraction failed' });
      const haId = `${workView}_Ha`, oiiiId = `${workView}_OIII`;
      if (gradientTool !== 'none') { await run('GC(Ha)', proc('GradientCorrection', haId, gc)); await run('GC(OIII)', proc('GradientCorrection', oiiiId, gc)); }
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
      intermediates.push(haId, oiiiId); // extracted mono channels no longer needed after combine
    }

    // 4) Star handling. Two split strategies:
    //    - 'separate'/'starless' split BEFORE the stretch so the starless nebula can be pushed
    //      bright without bloating stars (stars stretched independently, screened back / discarded).
    //    - 'reduce' splits AFTER the stretch instead (step 6a): the base image keeps the exact
    //      single-stretch look and stars are only ever SHRUNK, never re-stretched larger.
    const splitBefore = starHandling === 'separate' || starHandling === 'starless';
    let starsView: string | null = null;
    if (splitBefore) {
      const sx = await run('StarXTerminator', proc('StarXTerminator', colorView, { stars: true, unscreen: true }));
      if (!isErr(sx)) { starsView = `${colorView}_stars`; intermediates.push(starsView); } // freed after recombine/discard
    }

    // 5) Finish on the nebula (starless if split-before, full otherwise). Broadband: stretch +
    //    saturation + SCNR. Duoband: channels were already stretched before combine, so sat only.
    if (preStretched) {
      // Duoband: channels already stretched (mtf); no SCNR (green carries Ha in palettes).
      await run('finish (sat)', toTR(backend.send('run_script', 'run_script', { code: saturateScript(colorView, saturation, brightness, false) })));
    } else if (stretch === 'ghs') {
      // Broadband GHS: dedicated GHS stretch (re-anchored to backgroundTarget), then the sat/SCNR
      // finish. GHS output is inherently less saturated than MTF, so push saturation harder here.
      const ghsSat = Math.min(1, saturation + 0.25);
      await run(`GHS stretch (D=${ghsD}, b=${ghsB})`, toTR(backend.send('run_script', 'run_script', { code: ghsStretchScript(colorView, ghsD, ghsB, backgroundTarget) })));
      await run('finish (sat/SCNR)', toTR(backend.send('run_script', 'run_script', { code: saturateScript(colorView, ghsSat, brightness, true) })));
    } else {
      // Broadband MTF: combined stretch + sat + SCNR.
      await run('finish (mtf)', toTR(backend.send('run_script', 'run_script', { code: finishScript(colorView, backgroundTarget, saturation, unlinked, true, brightness) })));
    }

    // 5a) For 'reduce', split stars AFTER the stretch so the nebula boost (5c) lands ONLY on the
    //     starless nebula — otherwise the boost brightens stars into flat white clipped disks.
    //     unscreen=false: layer is nonlinear, so screen(starless,stars) reconstructs the original.
    let reduceStarsView: string | null = null;
    if (starHandling === 'reduce') {
      const sxr = await run('StarXTerminator (reduce split)', proc('StarXTerminator', colorView, { stars: true, unscreen: false }));
      if (!isErr(sxr)) reduceStarsView = `${colorView}_stars`;
    }

    // 5b) Nebula-only saturation boost through a mask (image is starless here for split-before
    //     modes, so the mask selects nebula and leaves the background neutral).
    if (splitBefore && starsView) {
      await run('nebula mask sat', toTR(backend.send('run_script', 'run_script', { code: nebulaMaskSatScript(colorView, saturation) })));
    }

    // 5c) Nebula-only brighten + contrast + saturation via a mask (broadband). Punches up the
    //     nebula locally so the background can stay MTF-clean (no global over-stretch → no gradients).
    if (dataType === 'broadband' && nebulaBoost > 0) {
      await run(`nebula boost (${nebulaBoost})`, toTR(backend.send('run_script', 'run_script', { code: nebulaBoostScript(colorView, nebulaBoost) })));
    }

    // 6) Recombine the independently-stretched stars for 'separate' (full, tight); 'starless'
    //    leaves them off.
    if (starHandling === 'separate' && starsView) {
      await run('recombine stars (full)', toTR(backend.send('run_script', 'run_script', { code: starsRecombineScript(colorView, starsView, false) })));
    }

    // 6a) Star REDUCTION: smoothly shrink the (already-split) stars layer and screen it back onto
    //     the boosted starless nebula. screen(starless, stars) == original, so stars only get smaller.
    if (starHandling === 'reduce' && reduceStarsView) {
      await run(`reduce stars (${starReduction})`, toTR(backend.send('run_script', 'run_script', { code: reduceStarsLayerScript(colorView, reduceStarsView, starReduction) })));
    }

    // 6b) Deepen the background toward true black (broadband; low end only, nebula untouched).
    if (dataType === 'broadband' && backgroundBlack > 0) {
      await run(`deepen background (${backgroundBlack})`, toTR(backend.send('run_script', 'run_script', { code: deepenBackgroundScript(colorView, backgroundBlack) })));
    }

    // 6c) Free intermediate full-res windows (extracted channels, split stars). Never close the
    //     result view. This is the per-run half of the memory fix (the other half is no undo swap).
    const toClose = intermediates.filter((id) => id && id !== colorView);
    if (toClose.length) {
      await run(`close intermediates (${toClose.length})`, toTR(backend.send('run_script', 'run_script', { code: closeViewsScript(toClose) })));
    }
    // Also sweep pipeline junk (rejection maps that opened with the master, stray masks/star layers)
    // so full-res windows don't accumulate across runs and exhaust RAM.
    await run('close pipeline junk', toTR(backend.send('run_script', 'run_script', { code: closePipelineJunkScript(colorView) })));

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
      stretch: dataType === 'broadband' ? stretch : 'mtf',
      backgroundBlack: dataType === 'broadband' ? backgroundBlack : 0,
      nebulaBoost: dataType === 'broadband' ? nebulaBoost : 0,
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
