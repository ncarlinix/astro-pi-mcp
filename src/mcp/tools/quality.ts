import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, resolveViewId, noViewResult } from './util.js';

/**
 * PJSR: run the quality gates on an already-open view. Non-destructive — it works on
 * throwaway PixelMath masks that are force-closed afterwards; the view is never modified.
 *
 * coreBurn is the primary gate: it tiles the frame into 100px blocks and fails if ANY block
 * has more than 3% of its pixels above 0.93 max-channel luminance. The block is large enough
 * that a single saturated star can't trip it, but a blown nebula/galaxy core does — even a
 * small one, which a global "clipped %" misses entirely (this is what the M83 nucleus-at-1.0
 * blowout needed). hardClip is reported for information only (bright stars clip legitimately),
 * so it never fails the overall result.
 */
function gatesScript(viewId: string): string {
  const V = JSON.stringify(viewId);
  return `(function(){
  var w = ImageWindow.windowById(${V});
  if (w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var v = w.mainView, img = v.image, nch = img.numberOfChannels;
  var lum = nch>1 ? "max(max($T[0],$T[1]),$T[2])" : "$T";
  function mask(thr,id){ var ex=ImageWindow.windowById(id); if(!ex.isNull) ex.forceClose();
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
  var coreBurn={ pass:bad===0, burntBlocks:bad, totalBlocks:total,
    worstBlockFraction:r(worst,1e4), worstBlockXY:worstXY,
    blockPx:BLK, failFraction:BADFRAC, luminanceThreshold:BT };
  var hardClip={ info:true, clippedFraction:r(clipFrac,1e6), threshold:0.999 };
  return JSON.stringify({ pass:coreBurn.pass, view:${V}, size:[W,H],
    gates:{ coreBurn:coreBurn, hardClip:hardClip } });
})()`;
}

/** Shared handler: run the gates script, format a PASS/FAIL result. `pick` selects what to
 *  surface (the whole report, or just one gate). A gate FAIL is a valid result, not a tool
 *  error, so isError is reserved for an actual script/bridge failure. */
async function runGates(
  backend: Parameters<ToolDef['handler']>[0],
  view: string | undefined,
  label: string,
  pick: (data: Record<string, unknown>) => { pass: boolean; body: unknown },
): Promise<ToolResult> {
  const viewId = await resolveViewId(backend, view);
  if (!viewId) return noViewResult();
  const out = await runScriptJson(backend, gatesScript(viewId));
  if ('error' in out) {
    return { content: [{ type: 'text', text: `${label} failed: ${out.error}` }], isError: true };
  }
  const { pass, body } = pick(out.data);
  return { content: [{ type: 'text', text: `${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(body, null, 2)}` }] };
}

export const verifyResult: ToolDef = {
  name: 'verify_result',
  description:
    'Run quality gates on a processed view and return PASS/FAIL with per-gate detail. ' +
    'Enforces the core-burn gate (100px block scan: fails if any block has >3% of pixels ' +
    'above 0.93 luminance — catches a blown nebula/galaxy core that a global clipped-% ' +
    'misses, without false-positiving on individual stars) and reports the hard-clip ' +
    'fraction for info. Non-destructive. Omit "view" for the active image.',
  inputSchema: { view: z.string().optional().describe('View id; omit for the active image') },
  handler: (backend, args) =>
    runGates(backend, args.view as string | undefined, 'verify_result', (d) => ({
      pass: d.pass === true,
      body: d,
    })),
};

export const checkBurn: ToolDef = {
  name: 'check_burn',
  description:
    'Core-burn gate only: tiles the view into 100px blocks and fails if any block has >3% ' +
    'of pixels above 0.93 max-channel luminance (a blown core). Non-destructive. Omit ' +
    '"view" for the active image.',
  inputSchema: { view: z.string().optional().describe('View id; omit for the active image') },
  handler: (backend, args) =>
    runGates(backend, args.view as string | undefined, 'check_burn', (d) => {
      const cb = ((d.gates as Record<string, unknown> | undefined)?.coreBurn ?? {}) as Record<string, unknown>;
      return { pass: cb.pass === true, body: cb };
    }),
};

export const qualityTools: ToolDef[] = [verifyResult, checkBurn];
