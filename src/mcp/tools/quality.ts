import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import type { ProcessingBackend } from '../../backend/types.js';

/**
 * PJSR: the core-burn + hard-clip gates. Non-destructive (throwaway PixelMath masks, closed
 * after). coreBurn tiles the frame into 100px blocks and fails if ANY block has >3% of its
 * pixels above 0.93 max-channel luminance — large enough that a single saturated star can't
 * trip it, but a blown nebula/galaxy core does, even a small one a global clipped-% misses
 * (the M83 nucleus-at-1.0 case). hardClip is reported for info only (stars clip legitimately).
 */
function burnScript(viewId: string): string {
  const V = JSON.stringify(viewId);
  return `(function(){
  var w = ImageWindow.windowById(${V});
  if (w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var v = w.mainView, img = v.image, nch = img.numberOfChannels;
  var lum = nch>1 ? "max(max($T[0],$T[1]),$T[2])" : "$T";
  function mask(thr,id){ var ex=ImageWindow.windowById(id); if(ex && !ex.isNull) ex.forceClose();
    var P=new PixelMath; P.expression="iif("+lum+">"+thr+",1,0)"; P.useSingleExpression=true;
    P.createNewImage=true; P.newImageId=id; P.showNewImage=false; P.executeOn(v,false);
    return ImageWindow.windowById(id); }
  function r(x,n){ return Math.round(x*n)/n; }
  var BT=0.93, BLK=100, BADFRAC=0.03;
  var bw=mask(BT,"__qa_burn"), m=bw.mainView.image, W=m.width, H=m.height;
  var bad=0,total=0,worst=0,worstXY=[0,0];
  for(var by=0;by<H;by+=BLK) for(var bx=0;bx<W;bx+=BLK){
    m.selectedRect=new Rect(bx,by,Math.min(bx+BLK,W),Math.min(by+BLK,H));
    var f=m.mean(); total++;
    if(f>BADFRAC){ bad++; if(f>worst){worst=f;worstXY=[bx,by];} } }
  m.resetSelections(); bw.forceClose();
  var cw=mask(0.999,"__qa_clip"), cm=cw.mainView.image;
  cm.selectedRect=new Rect(0,0,cm.width,cm.height); var clipFrac=cm.mean();
  cm.resetSelections(); cw.forceClose();
  return JSON.stringify({
    coreBurn:{ pass:bad===0, burntBlocks:bad, totalBlocks:total, worstBlockFraction:r(worst,1e4),
               worstBlockXY:worstXY, blockPx:BLK, failFraction:BADFRAC, luminanceThreshold:BT },
    hardClip:{ info:true, clippedFraction:r(clipFrac,1e6), threshold:0.999 } });
})()`;
}

/**
 * PJSR: the star-quality gate via PixInsight's native StarDetector (no RC Astro dependency).
 * Fails if too few stars are detected — the signature of star destruction from over-aggressive
 * StarXTerminator / denoise / stretch. Reports the count and median detected star size.
 */
function starsScript(viewId: string, minStars: number): string {
  const V = JSON.stringify(viewId);
  return `(function(){
  var w = ImageWindow.windowById(${V});
  if (w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var img = w.mainView.image;
  var SD = new StarDetector;
  try { SD.structureLayers = 5; SD.noiseLayers = 2; SD.hotPixelFilterRadius = 1; } catch(e){}
  var S; try { S = SD.stars(img); } catch(e){ return JSON.stringify({error:"StarDetector failed: "+(e.message||String(e))}); }
  var n = S.length, sizes=[];
  for (var i=0;i<n;i++){ var s=S[i]; if(s && typeof s.size==="number") sizes.push(s.size); }
  sizes.sort(function(a,b){return a-b;});
  var med = sizes.length ? sizes[Math.floor(sizes.length/2)] : 0;
  return JSON.stringify({ pass:n>=${minStars}, starCount:n, medianSize:Math.round(med*100)/100, minStars:${minStars} });
})()`;
}

async function runBurn(backend: ProcessingBackend, viewId: string) {
  return runScriptJson(backend, burnScript(viewId), 60_000);
}
async function runStars(backend: ProcessingBackend, viewId: string, minStars: number) {
  return runScriptJson(backend, starsScript(viewId, minStars), 120_000);
}

export const verifyResult: ToolDef = {
  name: 'verify_result',
  description:
    'Run quality gates on a processed view and return PASS/FAIL with per-gate detail. Gates: ' +
    'core-burn (100px block scan — fails on a blown nebula/galaxy core a global clipped-% ' +
    'misses, without false-positiving on stars) and star-quality (native StarDetector — fails ' +
    'if too few stars survive, the signature of over-processing). Reports the hard-clip ' +
    'fraction for info. Non-destructive. Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    minStars: z.number().int().positive().optional().describe('Minimum detected stars to pass (default 50)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const minStars = (args.minStars as number | undefined) ?? 50;
    const burn = await runBurn(backend, viewId);
    if ('error' in burn) return { content: [{ type: 'text', text: `verify_result (burn) failed: ${burn.error}` }], isError: true };
    const stars = await runStars(backend, viewId, minStars);
    if ('error' in stars) return { content: [{ type: 'text', text: `verify_result (stars) failed: ${stars.error}` }], isError: true };
    const coreBurn = burn.data.coreBurn as { pass?: unknown } | undefined;
    const burnPass = coreBurn?.pass === true;
    const starsPass = (stars.data as { pass?: unknown }).pass === true;
    const pass = burnPass && starsPass;
    return jsonResultWithVerdict(pass, { view: viewId, pass, gates: { ...burn.data, starQuality: stars.data } });
  },
};

export const checkBurn: ToolDef = {
  name: 'check_burn',
  description:
    'Core-burn gate only: 100px block scan, fails if any block has >3% of pixels above 0.93 ' +
    'max-channel luminance (a blown core). Non-destructive. Omit "view" for the active image.',
  inputSchema: { view: z.string().optional().describe('View id; omit for the active image') },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const burn = await runBurn(backend, viewId);
    if ('error' in burn) return { content: [{ type: 'text', text: `check_burn failed: ${burn.error}` }], isError: true };
    const cb = (burn.data.coreBurn ?? {}) as { pass?: unknown };
    return jsonResultWithVerdict(cb.pass === true, cb);
  },
};

export const checkStars: ToolDef = {
  name: 'check_stars',
  description:
    'Star-quality gate only: detects stars with the native StarDetector and fails if the ' +
    'count is below "minStars" (default 50) — catches star destruction from over-processing. ' +
    'Non-destructive. Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    minStars: z.number().int().positive().optional().describe('Minimum detected stars to pass (default 50)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const stars = await runStars(backend, viewId, (args.minStars as number | undefined) ?? 50);
    if ('error' in stars) return { content: [{ type: 'text', text: `check_stars failed: ${stars.error}` }], isError: true };
    return jsonResultWithVerdict((stars.data as { pass?: unknown }).pass === true, stars.data);
  },
};

/** PASS/FAIL prefix + pretty JSON. A gate FAIL is a valid result, not a tool error. */
function jsonResultWithVerdict(pass: boolean, body: unknown): ToolResult {
  return { content: [{ type: 'text', text: `${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(body, null, 2)}` }] };
}

export const qualityTools: ToolDef[] = [verifyResult, checkBurn, checkStars];
