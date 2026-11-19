/* For each whistle-like sound of the two-camera game: pitch, length, and how much each camera's scene moves
   before (4 s) and after (1-5 s, 1-12 s) it, in 0.2 s slots scaled by the camera's 75th percentile (as
   Flow.splitPractice). The camera where the play is = the one that moved more before the whistle.
     node research/whistles/features.js  -> _workspace/whistles/features.json */
'use strict';
const H = require('../../harness/lib');
const OFF = 1.12;
const scaled = (track, shift) => {
  const slot = new Map();
  for (const r of track) { if (r[3] < 0) continue; const k = Math.floor((r[0] + shift) / 0.2); slot.set(k, Math.max(slot.get(k) ?? 0, r[3])); }
  const sorted = [...slot.values()].sort((a, b) => a - b), sc = Math.max(1, sorted[Math.floor(sorted.length * 0.75)]);
  return (t1, t2) => { let a = 0, n = 0; for (let k = Math.ceil(t1 / 0.2); k * 0.2 < t2; k++) if (slot.has(k)) { a += slot.get(k); n++; } return n ? a / n / sc : null; };
};
const ml = scaled(H.load('_workspace/engine/hvn-left.json').track, 0), mr = scaled(H.load('_workspace/engine/hvn-right.json').track, OFF);
const W = H.load('_workspace/whistles/merged.json');
const out = W.map((w) => {
  const f = (m) => ({ before: m(w.t - 4, w.t), a5: m(w.t + 1, w.t + 5), a12: m(w.t + 1, w.t + 12) });
  const L = f(ml), R = f(mr), act = L.before >= R.before ? 'L' : 'R', A = act === 'L' ? L : R;
  return { ...w, act, L, R, stop5: A.a5 / A.before, stop12: A.a12 / A.before, both5: (L.a5 + R.a5) / (L.before + R.before) };
});
for (const o of out) console.log(`${o.t.toFixed(1).padStart(6)} ${o.dur.toFixed(1)}s ${(o.f / 1000).toFixed(1)}kHz play@${o.act}  before L${o.L.before.toFixed(2)} R${o.R.before.toFixed(2)}  after/before 1-5s ${o.stop5.toFixed(2)} 1-12s ${o.stop12.toFixed(2)} both ${o.both5.toFixed(2)}`);
H.save(H.out('whistles', 'features.json'), out);
