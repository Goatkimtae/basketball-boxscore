/* Can the scene motion the first stage already measures (engine track, 4th value) tell where the play is?
   For each shot: mean motion of each camera around it (share of that camera's median). Compared with the
   person counts of analyse.js (shots.json). */
'use strict';
const H = require('../../harness/lib');
const OFF = 1.12;
const mo = (key, shift) => {
  const tr = H.load(`_workspace/engine/${key}.json`).track.filter((r) => r[3] >= 0).map((r) => [r[0] + shift, r[3]]);
  const med = tr.map((r) => r[1]).sort((a, b) => a - b)[tr.length >> 1];
  return (t1, t2) => { let s = 0, n = 0; for (const [t, m] of tr) if (t >= t1 && t < t2) { s += m; n++; } return n ? s / n / med : null; };
};
const ml = mo('hvn-left', 0), mr = mo('hvn-right', OFF);
const rows = H.load('_workspace/oncourt/shots.json');
const out = [];
for (const r of rows) {
  const [a, b] = [ml(r.t - 3, r.t + 1), mr(r.t - 3, r.t + 1)];
  const here = r.side === '왼쪽' ? a : b, there = r.side === '왼쪽' ? b : a;
  out.push({ ...r, mHere: here, mThere: there, ratio: here / there, people: r.here - r.there });
}
const fmt = (x) => (x == null ? '  -  ' : x.toFixed(2));
for (const r of out.sort((x, y) => x.ratio - y.ratio)) console.log(`${r.who.padEnd(4)} ${r.t.toFixed(1).padStart(6)} ${r.side} ${r.ours ? 'ours' : 'user'} motion here ${fmt(r.mHere)} there ${fmt(r.mThere)} ratio ${fmt(r.ratio)} | people ${r.here}-${r.there}`);
