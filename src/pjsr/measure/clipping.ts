/**
 * get_clipping — per-channel clipped-black / saturated-white fractions and coarse
 * percentiles, from a stride-grid sample. Exact min/max come from the native image;
 * fractions/percentiles are estimated from ~targetSamples samples (fast, size-independent).
 */
export function clippingScript(viewId: string, targetSamples: number): string {
  const id = JSON.stringify(viewId);
  return `(function(){
  var sig = function(x){ return (typeof x === "number" && isFinite(x)) ? Number(x.toPrecision(6)) : x; };
  var pct = function(sorted, p){ if (!sorted.length) return null; var i = Math.min(sorted.length-1, Math.max(0, Math.round(p*(sorted.length-1)))); return sorted[i]; };
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var img = v.image;
  var w = img.width, h = img.height;
  var nch = Math.min(img.numberOfChannels, 3);
  var names = img.isColor ? ["R","G","B"] : ["K"];
  var stride = Math.max(1, Math.floor(Math.sqrt(w*h/${Math.trunc(targetSamples)})));
  var BLACK = 1e-5, WHITE = 1 - 1e-5;

  var channels = [];
  var buf = [];
  for (var c = 0; c < nch; ++c) {
    var samples = [], black = 0, white = 0, count = 0;
    for (var y = 0; y < h; y += stride) {
      img.selectedChannel = c;
      img.selectedRect = new Rect(0, y, w, y+1);
      img.getSamples(buf);
      for (var x = 0; x < w; x += stride) {
        var p = buf[x];
        samples.push(p);
        if (p <= BLACK) ++black;
        if (p >= WHITE) ++white;
        ++count;
      }
    }
    samples.sort(function(a,b){ return a - b; });
    // Reset the rect selection before exact min/max — otherwise minimum()/maximum() run
    // over the last sampled 1-row strip (selectedRect is still set from the loop above).
    img.resetRectSelection();
    img.selectedChannel = c;
    var exactMin = img.minimum(), exactMax = img.maximum();
    channels.push({
      channel: c, name: names[c] || ("C"+c),
      min: sig(exactMin), max: sig(exactMax),
      clippedBlackPct: sig(100*black/count), saturatedWhitePct: sig(100*white/count),
      p01: sig(pct(samples, 0.001)), p1: sig(pct(samples, 0.01)),
      p50: sig(pct(samples, 0.5)), p99: sig(pct(samples, 0.99)), p999: sig(pct(samples, 0.999)),
      sampleCount: count
    });
  }
  img.resetSelections();
  return JSON.stringify({ viewId: ${id}, stride: stride, channels: channels,
    note: "clippedBlackPct/saturatedWhitePct estimated from stride samples; min/max are exact. High saturatedWhitePct on stars is normal; high on nebula/background signals clipping." });
})()`;
}
