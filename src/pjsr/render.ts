/**
 * render_view — render an open view (optionally cropped/downsampled/stretched) to PNG/JPEG.
 * Returned as a PJSR source string to run via the `run_script` bridge tool; it prints a
 * JSON summary as its final expression. Ported from the reference pixinsight-mcp project.
 *
 * Verified API facts: Image.assign() honors the source selectedRect (crop at copy);
 * Image.render() → Bitmap; Bitmap.save(path[, quality]) writes by extension;
 * HistogramTransformation.H rows are [shadows, midtones, highlights, low, high];
 * View.stf rows are [midtones, shadows, highlights, low, high].
 */
export type StfMode = 'auto' | 'asis' | 'view';

export function renderScript(
  viewId: string,
  outputPath: string,
  stf: StfMode,
  rect?: [number, number, number, number],
  downsample?: number,
  quality?: number,
): string {
  const id = JSON.stringify(viewId);
  const out = JSON.stringify(outputPath);
  const rectJs = rect ? JSON.stringify(rect) : 'null';
  const ds = downsample && downsample > 1 ? Math.trunc(downsample) : 0;
  const q = quality && quality > 0 ? Math.min(100, Math.trunc(quality)) : 100;
  return `(function(){
  var sig = function(x){ return (typeof x === "number" && isFinite(x)) ? Number(x.toPrecision(6)) : x; };
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var src = v.image;
  var warnings = [];
  var mode = ${JSON.stringify(stf)};
  var mtf = function(m, x){ if (x <= 0) return 0; if (x >= 1) return 1; return ((m - 1)*x)/(((2*m - 1)*x) - m); };

  var htRows = null;
  if (mode === "auto") {
    var meds = [], mads = [];
    var nch = Math.min(src.numberOfChannels, 3);
    for (var c = 0; c < nch; ++c) { src.selectedChannel = c; meds.push(src.median()); mads.push(src.MAD()); }
    src.resetSelections();
    var med = 0, mad = 0;
    for (var c = 0; c < nch; ++c) { med += meds[c]/nch; mad += mads[c]/nch; }
    if (med < 2*1.4826*mad) {
      warnings.push("degenerate-median (mostly-empty layer): autostretch clamped to a gentle fixed MTF - prefer stf:'asis'");
      htRows = { 3: [0, 0.01, 1] };
    } else {
      var c0 = Math.max(0, Math.min(1, med - 2.8*1.4826*mad));
      var m = mtf(0.25, med - c0);
      htRows = { 3: [c0, m, 1] };
    }
  } else if (mode === "view") {
    var s = v.stf;
    var identity = true;
    for (var c = 0; c < 3; ++c)
      if (Math.abs(s[c][0] - 0.5) > 1e-6 || Math.abs(s[c][1]) > 1e-6 || Math.abs(s[c][2] - 1) > 1e-6) identity = false;
    if (identity) warnings.push("view has no STF set - rendering as-is");
    else htRows = { 0: [s[0][1], s[0][0], s[0][2]], 1: [s[1][1], s[1][0], s[1][2]], 2: [s[2][1], s[2][0], s[2][2]] };
  }

  var r = ${rectJs};
  var x0 = 0, y0 = 0, x1 = src.width, y1 = src.height;
  if (r) {
    x0 = Math.max(0, Math.min(src.width - 1, Math.round(r[0])));
    y0 = Math.max(0, Math.min(src.height - 1, Math.round(r[1])));
    x1 = Math.max(x0 + 1, Math.min(src.width, Math.round(r[2])));
    y1 = Math.max(y0 + 1, Math.min(src.height, Math.round(r[3])));
  }
  var tmpId = "astropilot_render_tmp";
  var ex = ImageWindow.windowById(tmpId);
  if (!ex.isNull) ex.forceClose();
  var tw = new ImageWindow(x1 - x0, y1 - y0, src.numberOfChannels, 32, true, src.isColor, tmpId);
  var tv = tw.mainView;
  tv.beginProcess();
  if (r) src.selectedRect = new Rect(x0, y0, x1, y1);
  tv.image.assign(src);
  src.resetSelections();
  tv.endProcess();

  var ow, oh;
  try {
    if (htRows) {
      var P = new HistogramTransformation;
      var H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1]];
      for (var row in htRows) { var t = htRows[row]; H[row|0] = [t[0], t[1], t[2], 0, 1]; }
      P.H = H;
      P.executeOn(tv, false);
    }
    var dsf = ${ds};
    if (dsf > 1) { var IR = new IntegerResample; IR.zoomFactor = -dsf; IR.executeOn(tv, false); }
    var bmp = tv.image.render();
    bmp.save(${out}, ${q});
    ow = tv.image.width; oh = tv.image.height;
  } finally {
    tw.forceClose();
  }
  return JSON.stringify({ viewId: ${id}, path: ${out}, width: ow, height: oh,
    stfMode: mode, stfApplied: !!htRows, sourceRect: [x0, y0, x1, y1],
    downsample: ${ds} || 1, warnings: warnings });
})()`;
}

/** Return a view's dimensions + color flag (JSON), for computing a downsample factor. */
export function dimsScript(viewId: string): string {
  const id = JSON.stringify(viewId);
  return `(function(){
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var img = v.image;
  return JSON.stringify({ viewId: ${id}, width: img.width, height: img.height, isColor: img.isColor, channels: img.numberOfChannels });
})()`;
}
