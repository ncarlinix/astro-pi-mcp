import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';

/**
 * PJSR: find the "spectacular" subject region and propose a crop.
 *
 * Clones the view, downsamples hard (~1024px long edge), strips stars with StarXTerminator
 * (so bright stars don't drag the centroid — wrapped in try/catch so it still works if SXT
 * isn't loaded; the heavy downsample + squared-signal weighting suppress stars either way),
 * then computes a signal-weighted centroid and spread on a coarse grid. The crop is sized at
 * max(2.4·sigma, `fraction`·frame) — so faint sprawling targets and compact ones both frame
 * sensibly — fitted to `aspect`, clamped to the frame. Non-destructive: the working clone is
 * closed; a preview rectangle is created on the original view for inspection. The returned
 * `dynamicCrop` block feeds straight into a DynamicCrop (centerX/centerY/width/height, all
 * normalised 0..1).
 */
function roiScript(viewId: string, aspect: number, fraction: number, previewId: string): string {
  const V = JSON.stringify(viewId);
  const P = JSON.stringify(previewId);
  return `(function(){
  var w = ImageWindow.windowById(${V});
  if (w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var W=w.mainView.image.width, H=w.mainView.image.height, nch=w.mainView.image.numberOfChannels;
  var ex=ImageWindow.windowById("__roi_work"); if(!ex.isNull) ex.forceClose();
  var work=new ImageWindow(W,H,nch,32,true,nch>1,"__roi_work");
  work.mainView.beginProcess(); work.mainView.image.assign(w.mainView.image); work.mainView.endProcess();
  var f=Math.max(1,Math.round(Math.max(W,H)/1024));
  var ir=new IntegerResample; ir.zoomFactor=-f; ir.executeOn(work.mainView,false);
  var starxUsed=false;
  try { var sx=new StarXTerminator; try{sx.stars=false;}catch(e){} sx.executeOn(work.mainView,false); starxUsed=true; } catch(e){}
  var img=work.mainView.image, gw=img.width, gh=img.height;
  img.selectedChannel = nch>1 ? 1 : 0;
  img.selectedRect=new Rect(0,0,gw,gh); var bg=img.median();
  var Nx=48,Ny=32,sw=0,swx=0,swy=0,swxx=0,swyy=0;
  for(var j=0;j<Ny;j++) for(var i=0;i<Nx;i++){
    var x0=(i*gw/Nx)|0,x1=((i+1)*gw/Nx)|0,y0=(j*gh/Ny)|0,y1=((j+1)*gh/Ny)|0;
    if(x1<=x0)x1=x0+1; if(y1<=y0)y1=y0+1;
    img.selectedRect=new Rect(x0,y0,x1,y1);
    var wv=img.median()-bg; if(wv<0)wv=0; wv*=wv;
    var xc=(x0+x1)/2,yc=(y0+y1)/2;
    sw+=wv;swx+=wv*xc;swy+=wv*yc;swxx+=wv*xc*xc;swyy+=wv*yc*yc; }
  img.resetSelections();
  var sb=W/gw,cx,cy,sigx,sigy;
  if(sw<=0){cx=gw/2;cy=gh/2;sigx=gw/4;sigy=gh/4;}
  else{cx=swx/sw;cy=swy/sw;sigx=Math.sqrt(Math.max(swxx/sw-cx*cx,1));sigy=Math.sqrt(Math.max(swyy/sw-cy*cy,1));}
  work.forceClose();
  var ASPECT=${aspect}, FRACTION=${fraction}, K=2.4;
  var hw=K*sigx*sb, hh=K*sigy*sb;
  if(hw/hh<ASPECT) hw=hh*ASPECT; else hh=hw/ASPECT;
  var minHW=FRACTION*W/2; if(hw<minHW){ hw=minHW; hh=hw/ASPECT; }
  if(hh>H/2){hh=H/2;hw=hh*ASPECT;} if(hw>W/2){hw=W/2;hh=hw/ASPECT;}
  var CX=Math.min(Math.max(cx*sb,hw),W-hw), CY=Math.min(Math.max(cy*sb,hh),H-hh);
  var r=[Math.round(CX-hw),Math.round(CY-hh),Math.round(CX+hw),Math.round(CY+hh)];
  try{ w.deletePreview(w.previewById(${P})); }catch(e){}
  w.createPreview(r[0],r[1],r[2],r[3],${P});
  var cw=r[2]-r[0], ch=r[3]-r[1];
  function n(x){ return Math.round(x*1e4)/1e4; }
  return JSON.stringify({ rect:r, center:[Math.round(CX),Math.round(CY)], cropWH:[cw,ch],
    cropPctW:Math.round(100*cw/W), frame:[W,H], starxUsed:starxUsed, previewId:${P},
    dynamicCrop:{ centerX:n(CX/W), centerY:n(CY/H), width:n(cw/W), height:n(ch/H) } });
})()`;
}

export const findSubjectRoi: ToolDef = {
  name: 'find_subject_roi',
  description:
    'Auto-frame the main subject ("the spectacular part") of an open view and propose a crop. ' +
    'Strips stars (StarXTerminator, with graceful fallback), finds the signal-weighted ' +
    'centroid + spread, and sizes the crop at max(2.4·sigma, fraction·frame) fitted to ' +
    'aspect. Non-destructive — creates a preview rectangle and returns the rect plus a ' +
    'ready-to-use DynamicCrop block (normalised center/width/height). Omit "view" for the ' +
    'active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    aspect: z.number().positive().optional().describe('Target width/height ratio (default 1.5 = 3:2)'),
    fraction: z
      .number()
      .min(0.05)
      .max(1)
      .optional()
      .describe('Minimum crop width as a fraction of the frame (default 0.42)'),
    previewId: z.string().optional().describe('Preview name to create on the view (default "roi")'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const aspect = (args.aspect as number | undefined) ?? 1.5;
    const fraction = (args.fraction as number | undefined) ?? 0.42;
    const previewId = (args.previewId as string | undefined) ?? 'roi';
    const out = await runScriptJson(backend, roiScript(viewId, aspect, fraction, previewId), 120_000);
    if ('error' in out) {
      return { content: [{ type: 'text', text: `find_subject_roi failed: ${out.error}` }], isError: true };
    }
    return jsonResult(out.data);
  },
};

export const roiTools: ToolDef[] = [findSubjectRoi];
