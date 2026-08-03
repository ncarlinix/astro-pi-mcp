/**
 * get_metadata — read FITS/XISF header keywords from a view's window and derive acquisition
 * facts: camera, telescope, filter, gain, offset, exposure, pixel size, focal length, and
 * the computed image scale (arcsec/px). Runs via run_script; no watcher handler needed.
 *
 * Image scale = 206.265 · pixelSize(µm) · binning / focalLength(mm).
 */
export function metadataScript(viewId: string): string {
  const id = JSON.stringify(viewId);
  return `(function(){
  var sig = function(x){ return (typeof x === "number" && isFinite(x)) ? Number(x.toPrecision(6)) : x; };
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var win = v.window;
  if (!win || win.isNull) return JSON.stringify({error: "No window for view: " + ${id}});
  var img = v.image;

  // Build a case-insensitive keyword map. FITSKeyword.value is a string, often quoted
  // and/or carrying units; strip surrounding quotes/space.
  var K = {};
  try {
    var kws = win.keywords;
    for (var i = 0; i < kws.length; ++i) {
      var name = String(kws[i].name).toUpperCase().replace(/\\s+/g, "");
      var val = String(kws[i].value).replace(/^\\s*'?|'?\\s*$/g, "").replace(/^\\s+|\\s+$/g, "");
      K[name] = val;
    }
  } catch (e) {}

  var num = function(keys) {
    for (var i = 0; i < keys.length; ++i) {
      var raw = K[keys[i]];
      if (raw !== undefined) { var f = parseFloat(raw); if (isFinite(f)) return f; }
    }
    return null;
  };
  var str = function(keys) {
    for (var i = 0; i < keys.length; ++i) { if (K[keys[i]] !== undefined && K[keys[i]] !== "") return K[keys[i]]; }
    return null;
  };

  var pixelSize = num(["XPIXSZ","PIXSIZE1","PIXSIZE","PIXSZ"]);      // microns
  var focalLen = num(["FOCALLEN","FOCAL"]);                          // mm
  var binning = num(["XBINNING","BINX"]) || 1;
  var scale = (pixelSize && focalLen) ? 206.265 * pixelSize * binning / focalLen : null;

  // Astrometric solution status: PixInsight's own flag, plus a keyword-level check for a
  // real WCS (CTYPE + CD matrix). Pointing coords (RA/DEC/OBJCTRA) alone are NOT a solution.
  var hasSolutionFlag = false;
  try { hasSolutionFlag = win.hasAstrometricSolution; } catch ( e ) {}
  var hasCTYPE = (K["CTYPE1"] !== undefined);
  var hasCD = (K["CD1_1"] !== undefined && K["CD2_2"] !== undefined);
  var astrometry = { hasSolutionFlag: hasSolutionFlag, hasCTYPE: hasCTYPE, hasCDMatrix: hasCD,
                     solved: (hasSolutionFlag || (hasCTYPE && hasCD)) };

  var meta = {
    camera: str(["INSTRUME","CAMERA"]),
    telescope: str(["TELESCOP","TELESCOPE"]),
    filter: str(["FILTER","FILTER1"]),
    object: str(["OBJECT","OBJNAME"]),
    gain: num(["GAIN","EGAIN"]),
    offset: num(["OFFSET","BLKLEVEL"]),
    exposureSec: num(["EXPTIME","EXPOSURE"]),
    pixelSizeUm: pixelSize,
    focalLengthMm: focalLen,
    binning: binning,
    imageScaleArcsecPerPx: sig(scale),
    dateObs: str(["DATE-OBS","DATEOBS"]),
    ra: str(["OBJCTRA","RA"]),
    dec: str(["OBJCTDEC","DEC"]),
    temperature: num(["CCD-TEMP","CCDTEMP"])
  };

  return JSON.stringify({ viewId: ${id},
    geometry: { width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor, bitsPerSample: img.bitsPerSample },
    keywordCount: (function(){ var n=0; for (var k in K) if (K.hasOwnProperty(k)) ++n; return n; })(),
    metadata: meta,
    astrometry: astrometry,
    note: "astrometry.solved=false means only pointing coords are present (no WCS); plate-solve before SPCC. imageScaleArcsecPerPx is null unless pixel size + focal length are present." });
})()`;
}
