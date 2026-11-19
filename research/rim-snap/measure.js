/* How well does RimSnap.snapRim (hoopstat/rimsnap.js) put a careless click back on the rim?
   References: the rim points the harness clicks for the two-camera game (config rim/rimTime, checked by eye),
   and for the panning band videos the rim the engine followed at shot starts (_workspace/engine/<key>.json).
   Each reference picture gets clicks moved by up to 20 px; the error is the distance of the snapped point
   from the reference.   node research/rim-snap/measure.js */
'use strict';
const H = require('../../harness/lib');
const R = require('../../hoopstat/rimsnap.js');
const c = H.config();
const refs = [];
for (const key of ['hvn-left', 'hvn-right']) {
  const v = c.videos[key];
  for (const t of [v.rimTime, 30, 100, 200, 300, 400]) refs.push({ key, t, x: v.rim[0], y: v.rim[1] });
}
for (const key of ['band-sample', 'band-foul']) {
  const e = H.load(`_workspace/engine/${key}.json`);
  for (const s of e.shots.filter((s) => s.hoop).slice(0, 8)) refs.push({ key, t: s.start - 0.5, x: s.hoop.x, y: s.hoop.y });
}
const offs = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12], [8, 8], [-8, 8], [8, -8], [-8, -8], [20, 0], [-20, 0], [0, 16], [0, -16]];
const out = {};
for (const r of refs) {
  const v = H.video(r.key), g = H.grab(v.path, { t0: r.t, frames: 1, w: 768 });
  const fr = g.frames[0];
  const row = offs.map(([dx, dy]) => {
    const s = R.snapRim(fr, g.W, g.H, r.x + dx, r.y + dy);
    return { dx, dy, err: Math.round(Math.hypot(s.x - r.x, s.y - r.y) * 10) / 10, snapped: s.snapped, w: s.w };
  });
  (out[r.key] = out[r.key] || []).push({ t: r.t, ref: [r.x, r.y], row });
  const bad = row.filter((x) => x.err > 3);
  // band references come from the engine (its gym profile may be off): also how far the snaps spread
  const s0 = R.snapRim(fr, g.W, g.H, r.x, r.y);
  const spread = Math.max(...offs.filter(([dx, dy]) => Math.hypot(dx, dy) <= 12).map(([dx, dy]) => { const s = R.snapRim(fr, g.W, g.H, r.x + dx, r.y + dy); return Math.hypot(s.x - s0.x, s.y - s0.y); }));
  console.log(`   spread of snaps (offsets <=12) around the exact-click snap ${s0.x},${s0.y}: ${spread.toFixed(1)} px`);
  console.log(`${r.key.padEnd(11)} t=${r.t.toFixed(1).padStart(6)} ref ${r.x},${r.y}  exact click -> err ${row[0].err} (${row[0].snapped ? 'snapped' : 'kept'} w ${row[0].w})  off by <=12: max err ${Math.max(...row.filter((x) => Math.hypot(x.dx, x.dy) <= 12).map((x) => x.err))}  bad ${bad.map((b) => `${b.dx},${b.dy}:${b.err}`).join(' ')}`);
}
H.save(H.out('snap', 'measure.json'), out);
