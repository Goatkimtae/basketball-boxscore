/* Picture strips for labelling by eye: one row per moment, one picture per offset, optionally cut around a
   point and with circles drawn (e.g. the ball). Read the output image to label (who shot, who rebounded).

     node harness/strips.js <video key> --times 18.1,37.2 [--offsets -0.3,0,0.3] [--x 120,520] [--y 0,376]
                            [--marks "18.0:245,184;37.1:240,229"] [--width 360] [--out file.jpg]

   --x / --y: the part to keep, in the app's 768-px-wide coordinates (default: whole picture).
   --marks: t:x,y points (768-px coordinates) drawn as yellow circles on the picture nearest t.
   Default output: _workspace/strips/<key>-<first time>.jpg                                           */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib');

async function strips(v, o) {
  await H.loadCv(); const cv = global.cv;
  const { W, H: h } = H.probe(v.path), sc = W / 768;
  const times = String(o.times).split(',').map(Number), offs = String(o.offsets ?? '0').split(',').map(Number);
  const [x0, x1] = (o.x || `0,768`).split(',').map((q) => Math.round(Number(q) * sc));
  const [y0, y1] = (o.y || `0,${(h / sc).toFixed(0)}`).split(',').map((q) => Math.round(Number(q) * sc));
  const cw = Math.min(W, x1) - Math.max(0, x0), ch = Math.min(h, y1) - Math.max(0, y0);
  const tw = Number(o.width || 360), th = Math.round((ch * tw) / cw);
  const marks = (o.marks || '').split(';').filter(Boolean).map((m) => { const [t, xy] = m.split(':'); const [x, y] = xy.split(',').map(Number); return [Number(t), x * sc, y * sc]; });
  const sheet = new cv.Mat(times.length * (th + 4), offs.length * (tw + 4), cv.CV_8UC4, new cv.Scalar(20, 20, 20, 255));
  times.forEach((t, r) => offs.forEach((dt, ci) => {
    const tt = Math.max(0, t + dt);
    const [fr] = H.grab(v.path, { t0: tt, frames: 1 }).frames;
    if (!fr) return;
    const m = new cv.Mat(h, W, cv.CV_8UC4); m.data.set(fr);
    for (const [mt, mx, my] of marks) if (Math.abs(mt - tt) < 0.05) cv.circle(m, new cv.Point(mx, my), Math.round(16 * sc / 1.9), new cv.Scalar(255, 255, 0, 255), 2);
    const roi = m.roi(new cv.Rect(Math.max(0, x0), Math.max(0, y0), cw, ch)), tile = new cv.Mat();
    cv.resize(roi, tile, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
    const label = `${v.key} ${tt.toFixed(2)}s (${dt >= 0 ? '+' : ''}${dt})`;
    cv.putText(tile, label, new cv.Point(4, 16), cv.FONT_HERSHEY_SIMPLEX, 0.45, new cv.Scalar(0, 0, 0, 255), 3);
    cv.putText(tile, label, new cv.Point(4, 16), cv.FONT_HERSHEY_SIMPLEX, 0.45, new cv.Scalar(255, 255, 0, 255), 1);
    const dst = sheet.roi(new cv.Rect(ci * (tw + 4), r * (th + 4), tw, th)); tile.copyTo(dst);
    dst.delete(); tile.delete(); roi.delete(); m.delete();
  }));
  const file = o.out ? H.rel(o.out) : H.out('strips', `${v.key}-${times[0]}.jpg`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${sheet.cols}x${sheet.rows}`, '-i', '-', '-q:v', '3', file], { input: Buffer.from(sheet.data) });
  sheet.delete();
  if (r.status) throw new Error(r.stderr.toString());
  return file;
}

if (require.main === module) {
  const a = H.args();
  if (!a._[0] || !a.times) { console.error('usage: node harness/strips.js <video key> --times t1,t2 [--offsets ..] [--x x0,x1] [--y y0,y1] [--marks ..] [--out file]'); process.exit(2); }
  strips(H.video(a._[0]), a).then((f) => console.log(path.relative(H.ROOT, f))).catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { strips };
