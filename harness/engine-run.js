/* The app's analysis engine (hoopstat/engine.js) on a whole video, frames from ffmpeg (30 per second,
   768 px wide, as the app processes them).

     node harness/engine-run.js <video key | file> [--template file] [--out file]

   Writes _workspace/engine/<key>.json: {shots, ballFrames, visibility, frames, track, seconds}. */
'use strict';
const path = require('path');
const H = require('./lib');

async function run(v, opt = {}) {
  await H.loadCv();
  const E = require(path.join(H.APP, 'engine.js'));
  const tpl = H.template(opt.template || v.template);
  const an = new E.Analyzer(tpl);
  const t0 = Date.now();
  const { frames } = await H.stream(v.path, { fps: 30, w: E.HS.PROC_W }, (buf, k) => {
    const { W, H: h } = { W: E.HS.PROC_W, H: buf.length / 4 / E.HS.PROC_W };
    const m = new cv.Mat(h, W, cv.CV_8UC4); m.data.set(buf);
    an.push(k / 30, m);
  });
  const r = an.finish();
  r.seconds = Math.round((Date.now() - t0) / 100) / 10;
  delete r.variants; delete r.samples;
  return { ...r, frames };
}

if (require.main === module) {
  const a = H.args();
  if (!a._[0]) { console.error('usage: node harness/engine-run.js <video key | file> [--template file] [--out file]'); process.exit(2); }
  const v = H.video(a._[0]);
  run(v, { template: a.template }).then((r) => {
    const file = H.save(a.out ? H.rel(a.out) : H.out('engine', `${v.key}.json`), r);
    console.log(`${v.key}: ${r.frames} frames, ${r.shots.length} shots (${r.shots.filter((s) => s.made).length} made), ${r.seconds}s -> ${path.relative(H.ROOT, file)}`);
  }).catch((e) => { console.error(e.message || e); process.exit(1); });
}
module.exports = { run };
