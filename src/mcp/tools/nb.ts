import { z } from 'zod';
import type { ToolDef, ToolResult } from './types.js';
import { runScriptJson, jsonResult } from './util.js';
import type { ProcessingBackend } from '../../backend/types.js';

/**
 * Continuum subtraction (Phase 3.1): pull the pure line signal (e.g. Ha) out of a channel that
 * also carries broadband continuum (stars + reflected/continuum light). The continuum is first
 * LinearFit-matched to the line channel so their shared content (stars, continuum) is on the same
 * scale, then subtracted — what's left is the line emission. For OSC dual-band, "line" is usually
 * the extracted Ha and "continuum" a broadband/luminance or the OIII channel; tune strength so
 * stars just disappear without eating nebulosity.
 */
function continuumSubtractScript(lineId: string, continuumId: string, strength: number, outId: string): string {
  const L = JSON.stringify(lineId), C = JSON.stringify(continuumId), OUT = JSON.stringify(outId);
  const expr = `max(0, ${lineId} - ${strength}*__cs_cont)`;
  return `(function(){
  var L=ImageWindow.windowById(${L}); if(L.isNull) return JSON.stringify({error:"line not found: "+${L}});
  var C=ImageWindow.windowById(${C}); if(C.isNull) return JSON.stringify({error:"continuum not found: "+${C}});
  var ec=ImageWindow.windowById("__cs_cont"); if(ec && !ec.isNull) ec.forceClose();
  var ci=C.mainView.image;
  var cw=new ImageWindow(ci.width,ci.height,ci.numberOfChannels,32,true,ci.isColor,"__cs_cont");
  cw.mainView.beginProcess(); cw.mainView.image.assign(ci); cw.mainView.endProcess();
  try{ var LF=new LinearFit; LF.referenceViewId=${L}; LF.executeOn(cw.mainView,false); }catch(e){ cw.forceClose(); return JSON.stringify({error:"LinearFit failed: "+(e.message||String(e))}); }
  var eo=ImageWindow.windowById(${OUT}); if(eo && !eo.isNull) eo.forceClose();
  var P=new PixelMath; P.expression=${JSON.stringify(expr)}; P.useSingleExpression=true; P.rescale=false; P.truncate=true;
  P.createNewImage=true; P.newImageId=${OUT}; P.newImageColorSpace=2; P.showNewImage=true;
  var err=""; try{ P.executeOn(L.mainView,false); }catch(e){ err=e.message||String(e); }
  cw.forceClose();
  var r=ImageWindow.windowById(${OUT});
  if(err && (!r||r.isNull)) return JSON.stringify({error:"PixelMath failed: "+err});
  return JSON.stringify({ resultId:${OUT}, created:(r&&!r.isNull), ch:(r&&!r.isNull?r.mainView.image.numberOfChannels:0),
                          lineMedian:Math.round(L.mainView.image.median()*1e5)/1e5,
                          resultMedian:(r&&!r.isNull?Math.round(r.mainView.image.median()*1e5)/1e5:0), strength:${strength} });
})()`;
}

export const continuumSubtract: ToolDef = {
  name: 'continuum_subtract',
  description:
    'Continuum-subtract a line channel (e.g. Ha) using a continuum/broadband reference, to remove ' +
    'stars + continuum and keep pure line emission. LinearFit-matches the continuum to the line, ' +
    'then subtracts strength×continuum (clipped at 0) into a new mono image "<line>_cs". For OSC ' +
    'dual-band: line = extracted Ha, continuum = a broadband/luminance or OIII. Raise strength ' +
    'until stars just vanish without eating nebulosity (default 1.0; LinearFit already scales).',
  inputSchema: {
    line: z.string().describe('Line-emission view id (e.g. "<view>_Ha")'),
    continuum: z.string().describe('Continuum / broadband reference view id'),
    strength: z.number().min(0).max(2).optional().describe('Subtraction strength after LinearFit (default 1.0)'),
    newImageId: z.string().optional().describe('Output id (default "<line>_cs")'),
  },
  handler: async (backend: ProcessingBackend, args): Promise<ToolResult> => {
    const line = args.line as string;
    const continuum = args.continuum as string;
    const strength = (args.strength as number | undefined) ?? 1.0;
    const outId = (args.newImageId as string | undefined) ?? `${line}_cs`;
    const res = await runScriptJson(backend, continuumSubtractScript(line, continuum, strength, outId), 60_000);
    if ('error' in res) return { content: [{ type: 'text', text: `continuum_subtract failed: ${res.error}` }], isError: true };
    return jsonResult(res.data);
  },
};

export const nbTools: ToolDef[] = [continuumSubtract];
