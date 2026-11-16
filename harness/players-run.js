/* The app's players stage (hoopstat/players.js) in Node on one camera's video, full resolution.

     node harness/players-run.js <video key> [--gathers labels|engine] [--no-people] [--no-shots] [--limit N]

   --gathers labels  shot moments from the hand-labelled shots (research/jersey-numbers/data/shots.json, the
                     video's "camera" L/R in config) - compares like with like across changes (default when labelled)
   --gathers engine  shot moments the engine found (_workspace/engine/<key>.json, run engine-run.js first)
   Writes _workspace/players/<key>.json: {shots: [{id, label, number, gap, runReads, reads, lab, secs}], people: [...]}. */
'use strict';
const path = require('path');
const H = require('./lib');

async function run(v, opt = {}) {
  const { P, detector, reader } = await H.playersModels();
  const { W, H: h, duration } = H.probe(v.path);
  const toMat = (buf) => { const m = new cv.Mat(h, W, cv.CV_8UC4); m.data.set(buf); return m; };
  const out = { video: v.key, shots: [], people: [] };
  if (opt.shots !== false) {
    let list;
    if ((opt.gathers || (v.camera ? 'labels' : 'engine')) === 'labels') {
      list = H.shooterLabels(v.camera).map((s) => {
        const g = s.ball[s.gather];
        return { id: `${s.cam}${s.k}`, label: s.shooter, sure: s.sure, t: g[0], x: g[1], y: g[2], rimW: 22, ball: s.ball.filter((b) => b[0] >= g[0] - 0.25 && b[0] <= g[0] + 0.3) };
      });
    } else {
      list = H.load(H.out('engine', `${v.key}.json`)).shots.filter((s) => s.gather)
        .map((s, k) => ({ id: `${v.key}:${k}`, label: null, start: s.start, t: s.gather.t, x: s.gather.x, y: s.gather.y, rimW: s.gather.rimW, ball: s.ball || [] }));
    }
    if (opt.limit) list = list.slice(0, Number(opt.limit));
    for (const s of list) {
      const t0 = Date.now(), w = new P.ShotWindow(s, W, h, 768);
      for (const fr of H.grab(v.path, { t0: w.t0, dur: w.t1 - w.t0, fps: P.PL.FPS }).frames) { const m = toMat(fr); await w.push(m, detector); m.delete(); }
      const r = await w.finish(reader);
      out.shots.push({ ...r, label: s.label, sure: s.sure, start: s.start, secs: Math.round((Date.now() - t0) / 100) / 10 });
      if (opt.log) opt.log(`${r.id} label ${s.label ?? '-'} -> ${r.number ?? '-'} (gap ${r.gap ?? '-'}, ${r.reads.length} reads, ${out.shots[out.shots.length - 1].secs}s)`);
    }
  }
  if (opt.people !== false) {
    for (let t = 0; t < duration; t += P.PL.PEOPLE_EVERY) {
      const [fr] = H.grab(v.path, { t0: t, frames: 1 }).frames;
      if (!fr) continue;
      const m = toMat(fr);
      for (const p of await P.peopleIn(m, detector, reader)) out.people.push({ t: Math.round(t * 10) / 10, ...p });
      m.delete();
    }
    if (opt.log) opt.log(`people pictures every ${P.PL.PEOPLE_EVERY}s: ${out.people.length} people`);
  }
  return out;
}

if (require.main === module) {
  const a = H.args();
  if (!a._[0]) { console.error('usage: node harness/players-run.js <video key> [--gathers labels|engine] [--no-people] [--no-shots]'); process.exit(2); }
  const v = H.video(a._[0]), t0 = Date.now();
  run(v, { gathers: a.gathers, people: !a['no-people'], shots: !a['no-shots'], limit: a.limit, log: (m) => console.log(m) }).then((r) => {
    const file = H.save(H.out('players', `${v.key}.json`), r);
    console.log(`${v.key}: ${r.shots.length} shots, ${r.people.length} people, ${Math.round((Date.now() - t0) / 1000)}s -> ${path.relative(H.ROOT, file)}`);
  }).catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { run };
