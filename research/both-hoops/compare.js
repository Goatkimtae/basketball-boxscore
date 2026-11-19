/* One-camera (both hoops) shots vs the two-camera shots of the same game.
     node research/both-hoops/compare.js [_workspace/engine/both.json]
   Times: here = left camera - 1.12 = right camera. */
'use strict';
const H = require('../../harness/lib');
const both = H.load(H.args()._[0] || '_workspace/engine/both.json');
const L = H.load('_workspace/engine/hvn-left.json'), R = H.load('_workspace/engine/hvn-right.json');
const ref = [...L.shots.map((s) => ({ ...s, t: s.start - 1.12 })), ...R.shots.map((s) => ({ ...s, t: s.start }))];
const mine = both.shots.map((s) => ({ ...s, t: s.start }));
const used = new Set(), pairs = [];
for (const m of mine) {
  const r = ref.filter((x) => !used.has(x) && x.side === m.side && Math.abs(x.t - m.t) <= 1.0).sort((x, y) => Math.abs(x.t - m.t) - Math.abs(y.t - m.t))[0];
  if (r) { used.add(r); pairs.push([m, r]); }
}
const onlyMine = mine.filter((m) => !pairs.some(([x]) => x === m)), onlyRef = ref.filter((r) => !used.has(r));
const madeSame = pairs.filter(([m, r]) => !!m.made === !!r.made).length;
for (const side of ['왼쪽', '오른쪽']) {
  const pm = pairs.filter(([m]) => m.side === side).length;
  console.log(`${side}: one camera ${mine.filter((s) => s.side === side).length}, two cameras ${ref.filter((s) => s.side === side).length}, same ${pm}`);
}
console.log(`same shots ${pairs.length}; made/missed agree ${madeSame}/${pairs.length}; only one camera: ${onlyMine.map((s) => `${s.side[0]}${s.t.toFixed(1)}`).join(' ') || '-'}; only two cameras: ${onlyRef.map((s) => `${s.side[0]}${s.t.toFixed(1)}`).join(' ') || '-'}`);
console.log(`hoops seen: ${JSON.stringify(both.hoops || both.visibility)}, dropped as the same shot at both hoops: ${both.dualDropped ?? '-'}, ${both.seconds}s`);
