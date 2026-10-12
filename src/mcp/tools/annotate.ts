import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import { metadataScript } from '../../pjsr/measure/metadata.js';
import { resolveDistance, formatLightYears } from '../../astro/simbad.js';

/** Small distance table for common targets (overridable). Keyed by a normalised designation
 *  (letters+digits, upper-case). Extend as needed. */
const DISTANCES: Record<string, string> = {
  M16: '~5,700 ly',
  M42: '~1,344 ly',
  M8: '~4,100 ly',
  M20: '~5,200 ly',
  M83: '~15 Mly',
  M31: '~2.5 Mly',
  M45: '~440 ly',
  NGC6188: '~4,000 ly',
  NGC2237: '~5,200 ly',
  IC2944: '~6,500 ly',
  IC2118: '~900 ly',
};

/** TNG-flavoured stardate from an ISO date (base year 1985 so recent dates land in the ~41xxx
 *  range, matching the show's era). Pure flavour. */
function stardate(dateObs: string | null): string {
  const d = dateObs ? new Date(dateObs) : new Date();
  if (isNaN(d.getTime())) return '00000.0';
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (d.getTime() - start) / 86_400_000;
  const sd = (d.getUTCFullYear() - 1985 + doy / 365.25) * 1000;
  return sd.toFixed(1);
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
function slugify(s: string): string {
  return String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'image';
}

/** PJSR compositor: ROI auto-frame -> export hero crop -> draw the landscape LCARS card ->
 *  save PNG. Self-contained and non-destructive (throwaway clones/previews are closed). The
 *  text is all precomputed in TS and passed as `fields`. */
export function cardScript(
  viewId: string,
  aspect: number,
  fraction: number,
  fieldsJson: string,
): string {
  const V = JSON.stringify(viewId);
  return `(function(){
  var F = ${fieldsJson};
  var ASPECT=${aspect}, FRACTION=${fraction};
  var w = ImageWindow.windowById(${V});
  if (w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var W=w.mainView.image.width, H=w.mainView.image.height, nch=w.mainView.image.numberOfChannels;

  // ---- ROI (signal-weighted centroid; StarX with fallback) ----
  var ex=ImageWindow.windowById("__ann_work"); if(!ex.isNull) ex.forceClose();
  var work=new ImageWindow(W,H,nch,32,true,nch>1,"__ann_work");
  work.mainView.beginProcess(); work.mainView.image.assign(w.mainView.image); work.mainView.endProcess();
  var ds=Math.max(1,Math.round(Math.max(W,H)/1024));
  var ir=new IntegerResample; ir.zoomFactor=-ds; ir.executeOn(work.mainView,false);
  try{var sx=new StarXTerminator; try{sx.stars=false;}catch(e){} sx.executeOn(work.mainView,false);}catch(e){}
  var gi=work.mainView.image, gw=gi.width, gh=gi.height;
  gi.selectedChannel=nch>1?1:0; gi.selectedRect=new Rect(0,0,gw,gh); var bg=gi.median();
  var Nx=48,Ny=32,sw=0,swx=0,swy=0,swxx=0,swyy=0;
  for(var j=0;j<Ny;j++)for(var i=0;i<Nx;i++){var x0=(i*gw/Nx)|0,x1=((i+1)*gw/Nx)|0,y0=(j*gh/Ny)|0,y1=((j+1)*gh/Ny)|0;if(x1<=x0)x1=x0+1;if(y1<=y0)y1=y0+1;gi.selectedRect=new Rect(x0,y0,x1,y1);var wv=gi.median()-bg;if(wv<0)wv=0;wv*=wv;var xc=(x0+x1)/2,yc=(y0+y1)/2;sw+=wv;swx+=wv*xc;swy+=wv*yc;swxx+=wv*xc*xc;swyy+=wv*yc*yc;}
  gi.resetSelections();
  var sb=W/gw,ccx,ccy,sgx,sgy;
  if(sw<=0){ccx=gw/2;ccy=gh/2;sgx=gw/4;sgy=gh/4;}else{ccx=swx/sw;ccy=swy/sw;sgx=Math.sqrt(Math.max(swxx/sw-ccx*ccx,1));sgy=Math.sqrt(Math.max(swyy/sw-ccy*ccy,1));}
  work.forceClose();
  var K=2.4, hw=K*sgx*sb, hh=K*sgy*sb;
  if(hw/hh<ASPECT)hw=hh*ASPECT;else hh=hw/ASPECT;
  var mhw=FRACTION*W/2; if(hw<mhw){hw=mhw;hh=hw/ASPECT;}
  if(hh>H/2){hh=H/2;hw=hh*ASPECT;}if(hw>W/2){hw=W/2;hh=hw/ASPECT;}
  var CX=Math.min(Math.max(ccx*sb,hw),W-hw),CY=Math.min(Math.max(ccy*sb,hh),H-hh);
  var rx0=Math.round(CX-hw),ry0=Math.round(CY-hh),rx1=Math.round(CX+hw),ry1=Math.round(CY+hh);

  // ---- export hero crop to a temp jpg ----
  var pid="__ann_crop"; var pex=w.previewById(pid); if(pex && !pex.isNull) w.deletePreview(pex);
  var pv=w.createPreview(rx0,ry0,rx1,ry1,pid);
  var cw=new ImageWindow(pv.image.width,pv.image.height,pv.image.numberOfChannels,32,true,pv.image.numberOfChannels>1,"__ann_cropimg");
  cw.mainView.beginProcess(); cw.mainView.image.assign(pv.image); cw.mainView.endProcess();
  var dsc=Math.max(1,Math.round(pv.image.width/1600)); if(dsc>1){var ir2=new IntegerResample;ir2.zoomFactor=-dsc;ir2.executeOn(cw.mainView,false);}
  var tmp=File.homeDirectory+"/.astropilot/__ann_crop.jpg";
  cw.saveAs(tmp,false,false,false,false); cw.forceClose();
  var pdel=w.previewById(pid); if(pdel && !pdel.isNull) w.deletePreview(pdel);

  // ---- draw landscape LCARS card (1640x1360) ----
  var CWd=1640,CHd=1360;
  var bmp=new Bitmap(CWd,CHd); bmp.fill(0xFF0A0A0C);
  var g=new Graphics(bmp); g.antialiasing=true;
  var ORANGE=0xFFFF9966,WHITE=0xFFF0F0F0,GRAY=0xFFAAAAAA,DIM=0xFF8A8A8A,VAL=0xFFCFCFCF,DIV=0xFF242428;
  function FT(s,b,f){var o=new Font(f||"Arial Narrow",s);o.bold=!!b;return o;}
  var MONO="DejaVu Sans Mono";
  function rect(x0,y0,x1,y1,c){g.brush=new Brush(c);g.fillRect(x0,y0,x1,y1);}
  function tL(x,yt,s,f,c){g.font=f;g.pen=new Pen(c);g.drawText(x,yt+f.ascent,s);}
  function tR(xr,yt,s,f,c){g.font=f;g.pen=new Pen(c);g.drawText(xr-f.width(s),yt+f.ascent,s);}
  function tB(x,yb,s,f,c){g.font=f;g.pen=new Pen(c);g.drawText(x,yb,s);}
  var fT=FT(46,true),fE=FT(24,false); var yb=30+fT.ascent;
  tB(40,yb,F.title,fT,WHITE); if(F.subtitle) tB(40+fT.width(F.title)+22,yb,F.subtitle,fE,GRAY);
  tR(1600,26,"STELLAR CARTOGRAPHY",FT(12,false),DIM); tR(1600,42,"STARDATE "+F.stardate,FT(21,true,MONO),ORANGE);
  rect(40,108,1600,111,ORANGE);
  var IX0=40,IY0=128,IX1=1600,IY1=1168;
  var art=null; try{art=new Bitmap(tmp);}catch(e){}
  if(art) g.drawScaledBitmap(IX0,IY0,IX1,IY1,art); else rect(IX0,IY0,IX1,IY1,0xFF0A0508);
  var LL=46,TT=3;
  rect(IX0,IY0,IX0+LL,IY0+TT,ORANGE);rect(IX0,IY0,IX0+TT,IY0+LL,ORANGE);
  rect(IX1-LL,IY0,IX1,IY0+TT,ORANGE);rect(IX1-TT,IY0,IX1,IY0+LL,ORANGE);
  rect(IX0,IY1-TT,IX0+LL,IY1,ORANGE);rect(IX0,IY1-LL,IX0+TT,IY1,ORANGE);
  rect(IX1-LL,IY1-TT,IX1,IY1,ORANGE);rect(IX1-TT,IY1-LL,IX1,IY1,ORANGE);
  var fH=FT(14,true),fV=FT(15,false);
  var cols=F.groups, colW=367, gap=30, gy=1204;
  for(var c=0;c<cols.length;c++){ var gx=40+c*(colW+gap); if(c>0) rect(gx-16,1204,gx-15,1330,DIV);
    tL(gx,gy,cols[c][0],fH,ORANGE);
    var rows=cols[c][1]; for(var rr=0;rr<rows.length;rr++) tL(gx,gy+30+rr*28,String(rows[rr]),fV,VAL); }
  rect(40,1344,1600,1345,0xFF33200F);
  g.end();

  var out=F.output;
  if(!out){ var fp=w.filePath||""; var dir=fp?fp.substring(0,fp.lastIndexOf("/")):File.homeDirectory; out=dir+"/"+F.slug+"_LCARS_card.png"; }
  bmp.save(out);
  try{ File.remove(tmp); }catch(e){}
  return JSON.stringify({ saved:out, artLoaded:art!=null, cropRect:[rx0,ry0,rx1,ry1],
    cropPctW:Math.round(100*(rx1-rx0)/W), center:[Math.round(CX),Math.round(CY)], starxUsed:false });
})()`;
}

export const annotateImage: ToolDef = {
  name: 'annotate_image',
  description:
    'Generate the LCARS acquisition card (landscape 1640x1360, image-dominant) for a ' +
    'processed view: auto-frames the subject (find_subject_roi), exports the hero crop, and ' +
    'composites the card with real acquisition metadata, saving a PNG next to the source ' +
    '(<object>_LCARS_card.png) or at "output". Header fields are read from the FITS/XISF ' +
    'keywords; pass "overrides" for anything the header lacks (telescope, aperture for ' +
    'f-ratio, sub count, filter name, distance, designation/class/constellation, site). ' +
    'Non-destructive. Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    output: z.string().optional().describe('Output PNG path; default <source-dir>/<object>_LCARS_card.png'),
    fraction: z.number().min(0.1).max(1).optional().describe('Hero crop width fraction (default 0.40)'),
    aspect: z.number().positive().optional().describe('Hero crop aspect (default 1.5 = 3:2)'),
    overrides: z
      .object({
        commonName: z.string().optional(),
        designation: z.string().optional(),
        objectClass: z.string().optional(),
        constellation: z.string().optional(),
        distance: z.string().optional(),
        telescope: z.string().optional(),
        aperture: z.number().optional().describe('Aperture in mm, to compute f-ratio'),
        filterName: z.string().optional(),
        filterNote: z.string().optional(),
        subs: z.number().optional().describe('Number of sub-exposures'),
        siteName: z.string().optional(),
        latitude: z.string().optional(),
      })
      .partial()
      .optional(),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const o = (args.overrides as Record<string, unknown> | undefined) ?? {};

    const metaRes = await runScriptJson(backend, metadataScript(viewId));
    if ('error' in metaRes) {
      return { content: [{ type: 'text', text: `annotate_image: metadata failed: ${metaRes.error}` }], isError: true };
    }
    const m = (metaRes.data.metadata ?? {}) as Record<string, unknown>;

    const obj = (o.designation as string) ?? (m.object as string) ?? viewId;
    const key = norm(m.object as string);
    // Distance: explicit override → curated table → SIMBAD TAP fallback (fail-safe to '—').
    let distance = (o.distance as string | undefined) ?? DISTANCES[key];
    if (!distance) {
      const d = await resolveDistance(String(m.object ?? obj));
      distance = formatLightYears(d.ly);
    }
    const focal = m.focalLengthMm as number | undefined;
    const aperture = o.aperture as number | undefined;
    const fRatio = focal && aperture ? ` f/${(focal / aperture).toFixed(1)}` : '';
    const scale = m.imageScaleArcsecPerPx as number | undefined;
    const px = m.pixelSizeUm as number | undefined;
    const exp = m.exposureSec as number | undefined;
    const subs = o.subs as number | undefined;
    const integ = subs && exp ? `${Math.round((subs * exp) / 60)} min integration` : '';
    const camera = String(m.camera ?? '').replace(/^ZWO\s+/i, '').trim();

    const fields = {
      title: String(m.object ?? viewId),
      subtitle: ((o.commonName as string) ?? '').toUpperCase(),
      stardate: stardate(m.dateObs as string | null),
      slug: slugify((m.object as string) ?? viewId),
      output: (args.output as string | undefined) ?? '',
      groups: [
        ['TARGET', [obj, (o.objectClass as string) ?? '', (o.constellation as string) ?? '', distance].filter(Boolean)],
        [
          'OPTICS',
          [
            (o.telescope as string) ?? '',
            focal ? `${Math.round(focal)} mm${fRatio}` : '',
            camera ? `${camera} (OSC)` : '',
            [scale ? `${scale.toFixed(2)}"/px` : '', px ? `${px} um` : ''].filter(Boolean).join('  '),
          ].filter(Boolean),
        ],
        [
          'EXPOSURE',
          [
            subs && exp ? `${subs} x ${Math.round(exp)} s` : exp ? `${Math.round(exp)} s subs` : '',
            integ,
            (o.filterName as string) ?? (m.filter ? `Filter ${m.filter}` : ''),
            (o.filterNote as string) ?? '',
          ].filter(Boolean),
        ],
        [
          'OBSERVER',
          [
            (o.siteName as string) ?? 'Roldán, AR',
            (o.latitude as string) ?? '',
            m.dateObs ? `${String(m.dateObs).slice(0, 10)} UT` : '',
            'SPCC natural color',
          ].filter(Boolean),
        ],
      ],
    };

    const aspect = (args.aspect as number | undefined) ?? 1.5;
    const fraction = (args.fraction as number | undefined) ?? 0.4;
    const out = await runScriptJson(backend, cardScript(viewId, aspect, fraction, JSON.stringify(fields)), 120_000);
    if ('error' in out) {
      return { content: [{ type: 'text', text: `annotate_image failed: ${out.error}` }], isError: true };
    }
    return jsonResult(out.data);
  },
};

export const annotateTools: ToolDef[] = [annotateImage];
