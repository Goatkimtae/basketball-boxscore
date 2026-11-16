/* Did a change to the engine change what it finds? Compares two engine results (or a result with a baseline).

     node harness/engine-compare.js <before.json> <after.json>

   Prints shots only in one of them (side | start | made), which hoop the camera shows (samples that differ),
   and the records play-flow makes from each (rebounds, turnovers...). Exit code 1 when the shots differ. */
'use strict';
const path = require('path');
const H = require('./lib');

const key = (s) => `${s.side}|${s.start.toFixed(1)}|${s.made ? 'made' : 'miss'}`;
/** camera sides as change points [[t, side], ...] (what baselines keep) */
function sideRuns(track) {
  const runs = [];
  for (const [t, side] of track || []) if (!runs.length || runs[runs.length - 1][1] !== side) runs.push([t, side]);
  return runs;
}
const sideAt = (runs, t) => { let s = 0; for (const [rt, side] of runs) { if (rt > t + 1e-9) break; s = side; } return s; };

function compare(a, b) {
  const ka = a.shots.map(key), kb = b.shots.map(key);
  const onlyA = ka.filter((k) => !kb.includes(k)), onlyB = kb.filter((k) => !ka.includes(k));
  const ra = a.sideRuns || sideRuns(a.track), rb = b.sideRuns || sideRuns(b.track);
  const times = (a.track || b.track || []).map((r) => r[0]);
  let differ = 0;
  for (const t of times) if (sideAt(ra, t) !== sideAt(rb, t)) differ++;
  let flow = null;
  if (a.track && b.track) {
    const Flow = require(path.join(H.APP, 'flow.js'));
    const S = { team_left: 'A', team_right: 'B' };
    const ev = (r) => Flow.infer({ shots: r.shots, track: r.track, whistles: [] }, S).events.map((e) => `${e.time.toFixed(0)}|${e.team}|${e.type}|${e.detail || ''}|${e.result || ''}`);
    const ea = ev(a), eb = ev(b);
    flow = { onlyA: ea.filter((x) => !eb.includes(x)), onlyB: eb.filter((x) => !ea.includes(x)), n: [ea.length, eb.length] };
  }
  return { shots: [a.shots.length, b.shots.length], made: [a.shots.filter((s) => s.made).length, b.shots.filter((s) => s.made).length], onlyA, onlyB,
    sideSamples: times.length, sideDiffer: differ, flow, same: !onlyA.length && !onlyB.length };
}

if (require.main === module) {
  const [fa, fb] = H.args()._;
  if (!fb) { console.error('usage: node harness/engine-compare.js <before.json> <after.json>'); process.exit(2); }
  const c = compare(H.load(fa), H.load(fb));
  console.log(`shots ${c.shots[0]} -> ${c.shots[1]}, made ${c.made[0]} -> ${c.made[1]}`);
  if (c.onlyA.length) console.log('  only before:', c.onlyA.join('  '));
  if (c.onlyB.length) console.log('  only after: ', c.onlyB.join('  '));
  console.log(`camera side differs on ${c.sideDiffer} of ${c.sideSamples} samples`);
  if (c.flow && (c.flow.onlyA.length || c.flow.onlyB.length)) console.log(`records ${c.flow.n[0]} -> ${c.flow.n[1]}; only before: ${c.flow.onlyA.join('  ')}; only after: ${c.flow.onlyB.join('  ')}`);
  process.exit(c.same ? 0 : 1);
}
module.exports = { compare, sideRuns };
