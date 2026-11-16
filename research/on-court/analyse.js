/* On-court study from the per-second person scans (scan.js) of the two fixed cameras of one game.
   - shirt groups: white / navy / other (red bibs of the waiting team, others) by nearest colour centre
   - moving vs still: each person linked to the nearest person of the frame before (feet within a radius);
     still = moved less than STILL px in WIN s
   - where the play is: white+navy people that move, per camera
   - the user's shots (export of their run) and ours: players in that hoop's half at the shot
     node research/on-court/analyse.js [--user _workspace/user-export-events.json] */
'use strict';
const H = require('../../harness/lib');
const a = H.args();
const L = H.load('_workspace/oncourt/hvn-left.json'), R = H.load('_workspace/oncourt/hvn-right.json');
const OFF = 1.12;                                  // right video started 1.12 s after the left one
const P = require('../../hoopstat/players.js');

// shirt colour groups from all people (k-means, 4 groups), named by colour
const labs = [...L.frames, ...R.frames].flatMap((f) => f.people.filter((p) => p.lab).map((p) => p.lab));
const km = P.kmeans(labs, 4);
const centres = km.cen;
const name = (c) => (c[1] > 145 ? 'red' : c[0] > 150 ? 'white' : c[0] < 90 ? 'navy' : 'other');
const groups = centres.map((c) => ({ c, name: name(c) }));
console.log('colour groups', groups.map((g) => `${g.name}[${g.c.map(Math.round)}]`).join(' '));
const groupOf = (lab) => { if (!lab) return 'none'; let b = null, bd = 1e9; for (const g of groups) { const d = (g.c[0] - lab[0]) ** 2 + (g.c[1] - lab[1]) ** 2 + (g.c[2] - lab[2]) ** 2; if (d < bd) { bd = d; b = g; } } return b.name; };

// motion: per person, distance of the feet from where the nearest person was WIN s ago
const WIN = Number(a.win || 4), STILL = Number(a.still || 25), RAD = 60;
function mark(cam) {
  const fps = cam.fps, k = Math.round(WIN * fps);
  cam.frames.forEach((f, i) => {
    for (const p of f.people) {
      p.g = groupOf(p.lab);
      p.foot = [(p.box[0] + p.box[2]) / 2, p.box[3]];
      const h = p.box[3] - p.box[1];
      // the same person k frames ago: nearest feet of the same colour group within RAD + a running distance
      let moved = null;
      const back = cam.frames[i - k];
      if (back) {
        let best = 1e9;
        for (const q of back.people) { if (groupOf(q.lab) !== p.g) continue; const d = Math.hypot(q.box[0] / 2 + q.box[2] / 2 - p.foot[0], q.box[3] - p.foot[1]); if (d < best) best = d; }
        moved = best;
      }
      p.moved = moved; p.h = h;
    }
  });
}
mark(L); mark(R);
const at = (cam, t) => cam.frames[Math.max(0, Math.min(cam.frames.length - 1, Math.round(t * cam.fps)))];
const players = (f) => f.people.filter((p) => (p.g === 'white' || p.g === 'navy'));
const count = (f, moving) => { const pl = players(f); return { white: pl.filter((p) => p.g === 'white' && (!moving || p.moved == null || p.moved > STILL)).length, navy: pl.filter((p) => p.g === 'navy' && (!moving || p.moved == null || p.moved > STILL)).length, all: f.people.length }; };

// timeline every 5 s: players seen in each camera
console.log('\n t   | left cam: white navy (all)  | right cam: white navy (all)');
for (let t = 0; t < 500; t += 10) {
  const l = count(at(L, t)), r = count(at(R, t - OFF));
  console.log(`${String(t).padStart(4)} | ${String(l.white).padStart(5)} ${String(l.navy).padStart(4)} (${String(l.all).padStart(2)})        | ${String(r.white).padStart(5)} ${String(r.navy).padStart(4)} (${String(r.all).padStart(2)})`);
}
// average around a moment (±1 s) for robustness
function around(cam, t) {
  const fr = []; for (let d = -1; d <= 1; d += 0.5) fr.push(count(at(cam, t + d)));
  const m = (k) => fr.map((x) => x[k]).sort((x, y) => x - y)[2];
  return { white: m('white'), navy: m('navy'), all: m('all') };
}
module.exports = { L, R, OFF, at, around, count, groupOf, groups };
if (require.main === module) {
  const bl = H.load('harness/baselines/hvn-left.json').shots, br = H.load('harness/baselines/hvn-right.json').shots;
  const ours = [...bl.map((s) => ({ t: s.start, side: '왼쪽' })), ...br.map((s) => ({ t: s.start + OFF, side: '오른쪽' }))];
  const real = (t, side) => ours.some((o) => o.side === side && Math.abs(o.t - t) < 1.5);
  const rows = [];
  if (a.user) {
    for (const c of H.load(a.user)) {
      if (c[3] !== '야투') continue;
      const t = Number(c[0]), side = c[1] === '화이트' ? '왼쪽' : '오른쪽';
      rows.push({ who: 'user', t, side, ours: real(t, side) });
    }
  }
  for (const o of ours) rows.push({ who: 'ours', t: o.t, side: o.side, ours: true });
  console.log('\nshots: players (white+navy) in that hoop\'s half vs the other half, median of 5 pictures in ±1 s');
  const out = [];
  for (const r of rows) {
    const here = r.side === '왼쪽' ? around(L, r.t) : around(R, r.t - OFF), there = r.side === '왼쪽' ? around(R, r.t - OFF) : around(L, r.t);
    r.here = here.white + here.navy; r.there = there.white + there.navy;
    out.push(r);
  }
  for (const who of ['ours', 'user']) {
    const list = out.filter((r) => r.who === who);
    if (!list.length) continue;
    console.log(`\n${who}: ${list.length} shots`);
    for (const r of list.sort((x, y) => x.t - y.t)) console.log(`  ${r.t.toFixed(1).padStart(6)} ${r.side} ${r.ours ? 'also-ours' : 'only-user'}  here ${r.here}  there ${r.there}`);
  }
  H.save(H.out('oncourt', 'shots.json'), out);
}
