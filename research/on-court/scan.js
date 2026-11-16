/* Where everybody is, every second, in one camera: person boxes (the app's YOLOX-nano detector), shirt colour,
   and the look (shirt/shorts/shoes/head colours). No number reading (fast). For the on-court study:
   who is playing (moves with the play) and who is not (benches, people practising at the empty hoop).

     node research/on-court/scan.js <video key> [--fps 1]
   Writes _workspace/oncourt/<key>.json: {W, H, fps, frames: [{t, people: [{box, score, lab, look}]}]} */
'use strict';
const H = require('../../harness/lib');

(async () => {
  const a = H.args(), v = H.video(a._[0]), fps = Number(a.fps || 1);
  await H.loadCv(); const ort = H.loadOrt();
  const fs = require('fs'), path = require('path');
  const P = require(path.join(H.APP, 'players.js'));
  const det = new P.PersonDetector(await ort.InferenceSession.create(fs.readFileSync(path.join(H.APP, 'vendor/models/person.onnx')), { executionProviders: ['wasm'] }));
  const { W, H: h, duration } = H.probe(v.path);
  const out = { video: v.key, W, H: h, fps, frames: [] };
  const t0 = Date.now();
  await H.stream(v.path, { fps }, async (buf, i) => {
    const m = new cv.Mat(h, W, cv.CV_8UC4); m.data.set(buf);
    const top = Math.round(P.PL.TOP * h);
    const found = await det.detect(m, 0, W, top, 2), people = [];
    for (const b of found) {
      if (b.score <= P.PL.KEEP_SCORE || b.box[3] - b.box[1] < P.PL.MIN_H * h) continue;
      const { lab } = P.shirtOf(m, b.box);
      people.push({ box: b.box.map((x) => Math.round(x)), score: Math.round(b.score * 100) / 100, lab: lab ? lab.map((x) => Math.round(x)) : null, look: P.lookOf(m, b.box) });
    }
    m.delete();
    out.frames.push({ t: i / fps, people });
    if (i % 60 === 0) console.log(`${v.key} ${i / fps}s / ${Math.round(duration)}s (${Math.round((Date.now() - t0) / 1000)}s)`);
  });
  console.log('->', H.save(H.out('oncourt', `${v.key}.json`), out));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
