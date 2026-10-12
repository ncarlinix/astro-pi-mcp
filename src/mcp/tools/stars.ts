import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, resolveViewId, jsonResult, noViewResult } from './util.js';
import type { ProcessingBackend } from '../../backend/types.js';

/**
 * PJSR: extract stars with StarXTerminator. Clones the view into "<view>_starless" (the source
 * view is never touched), runs StarX with star generation on, then locates the star image StarX
 * created by diffing the window set before/after and renames it to "<view>_stars". Both outputs
 * are left open. unscreen=true gives linearly-recombinable stars (screen blend); leave off for a
 * simple additive/overlay recombine.
 */
function extractStarsScript(viewId: string, unscreen: boolean): string {
  const V = JSON.stringify(viewId);
  const starlessId = JSON.stringify(`${viewId}_starless`);
  const starsId = JSON.stringify(`${viewId}_stars`);
  return `(function(){
  var w=ImageWindow.windowById(${V});
  if(w.isNull) return JSON.stringify({error:"view not found: "+${V}});
  var src=w.mainView.image, W=src.width, H=src.height, nch=src.numberOfChannels;
  var ex=ImageWindow.windowById(${starlessId}); if(ex && !ex.isNull) ex.forceClose();
  var es=ImageWindow.windowById(${starsId}); if(es && !es.isNull) es.forceClose();
  var cw=new ImageWindow(W,H,nch,32,true,nch>1,${starlessId});
  cw.mainView.beginProcess(); cw.mainView.image.assign(src); cw.mainView.endProcess();
  // snapshot window ids AFTER creating the starless clone, so the only new window is the stars image
  var before={}, ws=ImageWindow.windows, i;
  for(i=0;i<ws.length;i++) before[ws[i].mainView.id]=true;
  var sx;
  try{ sx=new StarXTerminator; }catch(e){ cw.forceClose(); return JSON.stringify({error:"StarXTerminator unavailable: "+(e.message||String(e))}); }
  try{ sx.stars=true; }catch(e){}
  try{ sx.unscreen=${unscreen ? 'true' : 'false'}; }catch(e){}
  var err="";
  try{ sx.executeOn(cw.mainView,false); }catch(e){ err=e.message||String(e); }
  var starsFound=""; ws=ImageWindow.windows;
  for(i=0;i<ws.length;i++){ var id=ws[i].mainView.id; if(!before[id]){ starsFound=id; break; } }
  if(starsFound){ var sw=ImageWindow.windowById(starsFound);
    if(sw && !sw.isNull){ try{ sw.mainView.id=${starsId}; }catch(e){} } }
  if(err && !starsFound){ cw.forceClose(); return JSON.stringify({error:"StarXTerminator failed: "+err}); }
  return JSON.stringify({ starlessId:cw.mainView.id, starsId:(ImageWindow.windowById(${starsId}).isNull?starsFound:${starsId}), unscreen:${unscreen ? 'true' : 'false'} });
})()`;
}

/**
 * PJSR: screen- or add-recombine a starless image with a star image, scaling the star
 * contribution by "strength" (1 = full stars back, <1 = reduced stars). screen is the correct
 * blend for unscreened stars: ~(~starless * ~(strength*stars)); add is starless + strength*stars.
 */
function recombineScript(starlessId: string, starsId: string, strength: number, mode: string, newId: string): string {
  const SL = JSON.stringify(starlessId), ST = JSON.stringify(starsId), OUT = JSON.stringify(newId);
  const expr =
    mode === 'add'
      ? `${SL} + ${strength}*${ST}`
      : `~(~${SL} * ~(${strength}*${ST}))`;
  return `(function(){
  var a=ImageWindow.windowById(${SL}); if(a.isNull) return JSON.stringify({error:"starless not found: "+${SL}});
  var b=ImageWindow.windowById(${ST}); if(b.isNull) return JSON.stringify({error:"stars not found: "+${ST}});
  var ex=ImageWindow.windowById(${OUT}); if(ex && !ex.isNull) ex.forceClose();
  var P=new PixelMath; P.expression=${JSON.stringify(expr)}; P.useSingleExpression=true; P.rescale=false; P.truncate=true;
  P.createNewImage=true; P.newImageId=${OUT}; P.showNewImage=true; P.executeOn(a.mainView,false);
  return JSON.stringify({ resultId:${OUT}, expression:${JSON.stringify(expr)} });
})()`;
}

async function runExtract(backend: ProcessingBackend, viewId: string, unscreen: boolean) {
  return runScriptJson(backend, extractStarsScript(viewId, unscreen), 300_000);
}

export const extractStars: ToolDef = {
  name: 'extract_stars',
  description:
    'Extract stars from an open view with StarXTerminator. Clones the view to "<view>_starless" ' +
    '(source untouched) and produces "<view>_stars"; both stay open. Set unscreen=true for ' +
    'screen-blend recombination (the usual choice). Omit "view" for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    unscreen: z.boolean().optional().describe('Unscreen the star image for screen-blend recombine (default true)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const unscreen = (args.unscreen as boolean | undefined) ?? true;
    const res = await runExtract(backend, viewId, unscreen);
    if ('error' in res) return { content: [{ type: 'text', text: `extract_stars failed: ${res.error}` }], isError: true };
    return jsonResult(res.data);
  },
};

export const recombineStars: ToolDef = {
  name: 'recombine_stars',
  description:
    'Recombine a starless image with a star image at a given strength (1 = full stars, <1 = ' +
    'reduced). mode "screen" (default) suits unscreened stars; "add" is a linear sum. Writes a ' +
    'new image. Use with the ids returned by extract_stars.',
  inputSchema: {
    starless: z.string().describe('Starless view id (e.g. "<view>_starless")'),
    stars: z.string().describe('Star view id (e.g. "<view>_stars")'),
    strength: z.number().min(0).max(2).optional().describe('Star contribution (default 1)'),
    mode: z.enum(['screen', 'add']).optional().describe('Blend mode (default screen)'),
    newImageId: z.string().optional().describe('Output id (default "<starless>_recombined")'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const starless = args.starless as string;
    const stars = args.stars as string;
    const strength = (args.strength as number | undefined) ?? 1;
    const mode = (args.mode as string | undefined) ?? 'screen';
    const newId = (args.newImageId as string | undefined) ?? `${starless}_recombined`;
    const res = await runScriptJson(backend, recombineScript(starless, stars, strength, mode, newId), 60_000);
    if ('error' in res) return { content: [{ type: 'text', text: `recombine_stars failed: ${res.error}` }], isError: true };
    return jsonResult(res.data);
  },
};

export const reduceStars: ToolDef = {
  name: 'reduce_stars',
  description:
    'Reduce star prominence in one call: extract stars (StarXTerminator), then screen-recombine ' +
    'with a reduced star strength. amount is how much to pull stars down (0.4 = stars at 60%). ' +
    'Writes "<view>_starsreduced"; leaves the starless and star images open too. Omit "view" ' +
    'for the active image.',
  inputSchema: {
    view: z.string().optional().describe('View id; omit for the active image'),
    amount: z.number().min(0).max(1).optional().describe('Reduction amount, 0..1 (default 0.5)'),
  },
  handler: async (backend, args): Promise<ToolResult> => {
    const viewId = await resolveViewId(backend, args.view as string | undefined);
    if (!viewId) return noViewResult();
    const amount = (args.amount as number | undefined) ?? 0.5;
    const ext = await runExtract(backend, viewId, true);
    if ('error' in ext) return { content: [{ type: 'text', text: `reduce_stars (extract) failed: ${ext.error}` }], isError: true };
    const starless = (ext.data as { starlessId?: string }).starlessId ?? `${viewId}_starless`;
    const stars = (ext.data as { starsId?: string }).starsId ?? `${viewId}_stars`;
    const newId = `${viewId}_starsreduced`;
    const rec = await runScriptJson(backend, recombineScript(starless, stars, 1 - amount, 'screen', newId), 60_000);
    if ('error' in rec) return { content: [{ type: 'text', text: `reduce_stars (recombine) failed: ${rec.error}` }], isError: true };
    return jsonResult({ view: viewId, amount, starStrength: 1 - amount, starlessId: starless, starsId: stars, resultId: newId });
  },
};

export const starTools: ToolDef[] = [extractStars, recombineStars, reduceStars];
