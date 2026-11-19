/* Attack direction from where the players stand (two fixed cameras): in the pictures taken every few seconds,
   when both teams are in a camera's half, is the defending team nearer that hoop?
     node research/direction/defence.js     (needs _workspace/players/hvn-*.json with people x, y and engine results) */
'use strict';
const H = require('../../harness/lib');
const P = require('../../hoopstat/players.js');
const L = H.load('_workspace/players/hvn-left.json'), R = H.load('_workspace/players/hvn-right.json');
const EL = H.load('_workspace/engine/hvn-left.json'), ER = H.load('_workspace/engine/hvn-right.json');
const found = P.findTeams([...L.people, ...R.people]);
console.log('teams', found.teams.map((t, i) => `team${i}: ${t.numbers.join(' ')}`).join(' | '));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const [name, d, e] of [['left', L, EL], ['right', R, ER]]) {
  const hoop = e.shots[0].hoop;
  const byT = new Map();
  for (const p of d.people) { if (p.x == null) continue; const g = found.labOf(p.lab); if (!byT.has(p.t)) byT.set(p.t, []); byT.get(p.t).push({ ...p, g }); }
  const stats = [[], []], votes = [0, 0];
  let frames = 0;
  for (const [, list] of byT) {
    const tm = list.filter((p) => p.g < 2);
    const n0 = tm.filter((p) => p.g === 0).length, n1 = tm.filter((p) => p.g === 1).length;
    if (n0 < 2 || n1 < 2) continue;      // play is in this half: both teams seen
    const dist = (p) => Math.hypot(p.x - hoop.x, p.y - hoop.y);
    const m0 = med(tm.filter((p) => p.g === 0).map(dist)), m1 = med(tm.filter((p) => p.g === 1).map(dist));
    stats[0].push(m0); stats[1].push(m1); votes[m0 < m1 ? 0 : 1]++; frames++;
  }
  console.log(`${name} camera, hoop (${hoop.x},${hoop.y}): pictures with both teams ${frames}; median distance to the hoop team0 ${Math.round(med(stats[0]))} px, team1 ${Math.round(med(stats[1]))} px; nearer in: team0 ${votes[0]}, team1 ${votes[1]}`);
}

// the same on short pieces of the game (a short video, where the shooters' shirts decide nothing)
const vote = (people, hoop, t0, t1) => {
  const byT = new Map();
  for (const p of people) { if (p.x == null || p.t < t0 || p.t >= t1) continue; const g = found.labOf(p.lab); if (g > 1) continue; if (!byT.has(p.t)) byT.set(p.t, []); byT.get(p.t).push({ ...p, g }); }
  const v = [0, 0];
  for (const [, list] of byT) {
    const a = list.filter((p) => p.g === 0), b = list.filter((p) => p.g === 1);
    if (a.length < 2 || b.length < 2) continue;
    const dist = (p) => Math.hypot(p.x - hoop.x, p.y - hoop.y);
    v[med(a.map(dist)) < med(b.map(dist)) ? 0 : 1]++;
  }
  return v;   // pictures where team0 / team1 was nearer this hoop
};
for (const len of [60, 150, 300]) {
  let right = 0, wrong = 0, none = 0;
  for (let t0 = 0; t0 + len <= 500; t0 += 30) {
    const l = vote(L.people, EL.shots[0].hoop, t0, t0 + len), r = vote(R.people, ER.shots[0].hoop, t0, t0 + len);
    // team0 defends the left hoop when it is nearer there and team1 is nearer the right hoop
    const score = (l[0] - l[1]) + (r[1] - r[0]);
    if (Math.abs(score) < 3) none++; else if (score > 0) right++; else wrong++;   // truth: team0 (navy) defends the left hoop
  }
  console.log(`pieces of ${len} s (every 30 s): right ${right}, wrong ${wrong}, undecided ${none}`);
}
