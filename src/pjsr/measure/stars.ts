/**
 * get_star_metrics — hand-rolled star detection + moment-based FWHM/eccentricity, run via
 * run_script (no #include preprocessing in eval'd bridge code, so this is self-contained).
 * Values are COMPARISON-STABLE (before/after), not photometric: moment FWHM reads ~2.3x a
 * PSF-fit FWHM; never mix the two. Ported from the reference pixinsight-mcp project.
 */
export function starMetricsScript(viewId: string, maxStars: number): string {
  const id = JSON.stringify(viewId);
  return `(function(){
  var sig = function(x){ return (typeof x === "number" && isFinite(x)) ? Number(x.toPrecision(6)) : x; };
  var median = function(a){ if (!a.length) return null; var s = a.slice().sort(function(p,q){return p-q;}); var m = s.length >> 1; return (s.length % 2) ? s[m] : (s[m-1]+s[m])/2; };
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var img = v.image;
  var w = img.width, h = img.height;
  var dc = img.isColor ? 1 : 0;

  img.selectedChannel = dc;
  var med = img.median(), mad = img.MAD();
  var nr = img.noiseMRS();
  var sigma = (nr && typeof nr === "object" && nr.length !== undefined) ? nr[0] : nr;
  img.resetSelections();
  if (!isFinite(sigma) || sigma <= 0) sigma = 1.4826*mad;
  var threshold = med + Math.max(10*1.4826*mad, 30*sigma);

  var readRow = function(c, y, buf) {
    img.selectedChannel = c;
    img.selectedRect = new Rect(0, y, w, y+1);
    img.getSamples(buf);
  };

  var cands = [], buf = [], CAP = 50000, escalations = 0;
  for (;;) {
    cands.length = 0;
    var capped = false;
    for (var y = 0; y < h && !capped; y += 2) {
      readRow(dc, y, buf);
      for (var x = 1; x < w-1; ++x) {
        var p = buf[x];
        if (p > threshold && p >= buf[x-1] && p >= buf[x+1]) {
          cands.push({ x: x, y: y, v: p });
          if (cands.length >= CAP) { capped = true; break; }
        }
      }
    }
    if (!capped || escalations >= 8) break;
    threshold *= 4; ++escalations;
  }
  cands.sort(function(a,b){ return b.v - a.v; });

  var minSep = 15, cell = {}, accepted = [];
  var key = function(cx, cy){ return cx + "," + cy; };
  for (var k = 0; k < cands.length; ++k) {
    var s = cands[k], cx = Math.floor(s.x/minSep), cy = Math.floor(s.y/minSep), clash = false;
    for (var dy = -1; dy <= 1 && !clash; ++dy)
      for (var dx = -1; dx <= 1 && !clash; ++dx) {
        var lst = cell[key(cx+dx, cy+dy)];
        if (lst) for (var q = 0; q < lst.length; ++q) {
          var o = lst[q];
          if ((o.x-s.x)*(o.x-s.x) + (o.y-s.y)*(o.y-s.y) < minSep*minSep) { clash = true; break; }
        }
      }
    if (!clash) { (cell[key(cx,cy)] = cell[key(cx,cy)] || []).push(s); accepted.push(s); }
  }

  var win = 12, fwhms = [], eccs = [], brightest = [], measured = 0;
  var readWindow = function(c, x0, y0, x1, y1, out) {
    img.selectedChannel = c;
    img.selectedRect = new Rect(x0, y0, x1, y1);
    img.getSamples(out);
  };
  var nMeasure = Math.min(accepted.length, ${Math.trunc(maxStars)});
  for (var k = 0; k < nMeasure; ++k) {
    var s = accepted[k];
    var x0 = Math.max(0, s.x - win), y0 = Math.max(0, s.y - win);
    var x1 = Math.min(w, s.x + win + 1), y1 = Math.min(h, s.y + win + 1);
    var ww = x1 - x0, wh = y1 - y0;
    var wdata = [];
    readWindow(dc, x0, y0, x1, y1, wdata);
    var peak = -1, px = s.x, py = s.y;
    for (var j = 0; j < wh; ++j)
      for (var i = 0; i < ww; ++i) {
        var p = wdata[j*ww + i];
        if (p > peak) { peak = p; px = x0 + i; py = y0 + j; }
      }
    if (brightest.length < 5) brightest.push({ x: px, y: py, peak: sig(peak) });
    if (peak > 0.998) continue;
    var ring = [];
    for (var i = 0; i < ww; ++i) { ring.push(wdata[i]); ring.push(wdata[(wh-1)*ww + i]); }
    for (var j = 1; j < wh-1; ++j) { ring.push(wdata[j*ww]); ring.push(wdata[j*ww + ww-1]); }
    var bg = median(ring);
    var F = 0, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
    for (var j = 0; j < wh; ++j)
      for (var i = 0; i < ww; ++i) {
        var f = wdata[j*ww + i] - bg;
        if (f <= 0) continue;
        F += f; Sx += f*i; Sy += f*j; Sxx += f*i*i; Syy += f*j*j; Sxy += f*i*j;
      }
    if (F <= 0) continue;
    var mx = Sx/F, my = Sy/F;
    var vx = Sxx/F - mx*mx, vy = Syy/F - my*my, cxy = Sxy/F - mx*my;
    if (vx <= 0 || vy <= 0) continue;
    fwhms.push(2.3548*Math.sqrt((vx+vy)/2));
    var tr2 = (vx+vy)/2, d = Math.sqrt(((vx-vy)/2)*((vx-vy)/2) + cxy*cxy);
    var l1 = tr2 + d, l2 = tr2 - d;
    if (l1 > 0 && l2 > 0) eccs.push(Math.sqrt(1 - l2/l1));
    ++measured;
  }

  var spStride = Math.max(2, Math.floor(Math.sqrt(w*h/250000)));
  var starPix = [], bR = [], bG = [], bB = [];
  for (var y = 0; y < h; y += spStride) {
    if (img.isColor) { readRow(0, y, bR); readRow(1, y, bG); readRow(2, y, bB); }
    else readRow(0, y, bR);
    for (var x = 0; x < w; x += spStride) {
      var val = img.isColor ? Math.max(bR[x], bG[x], bB[x]) : bR[x];
      if (val > 0.005) starPix.push(val);
    }
  }
  img.resetSelections();

  return JSON.stringify({ viewId: ${id},
    starCount: accepted.length, candidatesCapped: cands.length >= CAP, thresholdEscalations: escalations,
    measured: measured, threshold: sig(threshold),
    medianFWHM: sig(median(fwhms)), medianEccentricity: sig(median(eccs)),
    starPixelMedian: sig(median(starPix)), starPixelCount: starPix.length,
    brightestStars: brightest,
    note: "Comparison-stable, not photometric. starCount approximate (2px-row subsampling). starPixelMedian meaningful on a stars-only layer." });
})()`;
}
