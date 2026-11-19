/* The app's attack-direction decision (Players.attackDirection with defenceScore, and findSwitch) on the
   two-camera test game, whole and in short pieces: shooters only vs shooters + where the defence stands.
     node research/direction/score.js    (needs _workspace/players/hvn-*.json with people x, y and _workspace/engine/hvn-*.json)
   Truth for this game: navy (11 16 28 44 77) attacks the right hoop, white (9 13 33 69) the left one. */
'use strict';
const H = require('../../harness/lib');
const P = require('../../hoopstat/players.js');
const OFF = 1.12;
const cams = [['hvn-left', '왼쪽', 0], ['hvn-right', '오른쪽', OFF]].map(([key, side, off]) => {
  const pl = H.load(`_workspace/players/${key}.json`), en = H.load(`_workspace/engine/${key}.json`);
  // the players-stage shots of these files come from the labelled moments the shooter holds the ball (ids like L3)
  const lab = Object.fromEntries(H.shooterLabels(side === '왼쪽' ? 'L' : 'R').map((x) => [`${x.cam}${x.k}`, x.ball[x.gather][0]]));
  const shots = pl.shots.map((r) => (lab[r.id] != null ? { t: lab[r.id] + off, side, number: r.number, lab: r.lab } : null)).filter(Boolean);
  const hs = en.shots.map((s) => s.hoop).filter(Boolean), medOf = (k) => hs.map((h) => h[k]).sort((a, b) => a - b)[Math.floor(hs.length / 2)];
  return { side, shots, hoop: { x: medOf('x'), y: medOf('y') }, people: pl.people.map((p) => ({ ...p, t: p.t + off })) };
});
const all = [...cams[0].people, ...cams[1].people];
const navyLeft = (found, dir) => found.teams[dir.left].numbers.includes('44');   // wrong if navy is said to attack the left hoop
function decide(t0, t1, withDefence) {
  const inT = (x) => x.t >= t0 && x.t < t1;
  const found = P.findTeams(all.filter(inT));
  if (!found) return 'no teams';
  const shots = cams.flatMap((c) => c.shots.filter(inT));
  const more = withDefence ? cams.map((c) => P.defenceScore(found, c.people.filter(inT), c.hoop, c.side, null)) : [];
  const dir = P.attackDirection(found, shots, null, more);
  if (!dir) return 'undecided';
  return navyLeft(found, dir) ? 'wrong' : 'right';
}
const whole = P.findTeams(all);
const items = P.directionItems(whole, cams.flatMap((c) => c.shots), cams);
console.log('whole game: shooters only ->', decide(0, 1e9, false), '| with defence ->', decide(0, 1e9, true), '| switch found:', JSON.stringify(P.findSwitch(items)));
for (const len of [60, 150, 300]) {
  for (const withD of [false, true]) {
    const n = { right: 0, wrong: 0, undecided: 0, 'no teams': 0 };
    for (let t0 = 0; t0 + len <= 500; t0 += 30) n[decide(t0, t0 + len, withD)]++;
    console.log(`pieces of ${len} s, ${withD ? 'shooters + defence' : 'shooters only   '}: right ${n.right}, wrong ${n.wrong}, undecided ${n.undecided}, teams not found ${n['no teams']}`);
  }
}
// a made-up video with both halves: the same game twice, the second time with the teams at the other ends
const flipped = items.map((e) => ({ t: e.t + 500, score: -e.score }));
console.log('made-up two halves (switch at 500 s): switch found', JSON.stringify(P.findSwitch([...items, ...flipped])));
if (H.args().detail) {
  for (const len of [60, 90, 150]) {
    const rows = [];
    for (let t0 = 0; t0 + len <= 500; t0 += 30) {
      const inT = (x) => x.t >= t0 && x.t < t0 + len, found = P.findTeams(all.filter(inT));
      if (!found) { rows.push(`${t0}:no teams`); continue; }
      const more = cams.map((c) => P.defenceScore(found, c.people.filter(inT), c.hoop, c.side, null));
      const sc = more.reduce((a, m) => a + m.score, 0), pics = more.reduce((a, m) => a + m.pictures, 0);
      const navy = found.teams.findIndex((t) => ['11', '16', '28', '44', '77'].some((n) => t.numbers.includes(n)));
      const ok = navy < 0 ? '?' : (navy === 0 ? sc < 0 : sc > 0) ? 'R' : 'W';
      rows.push(`${t0}:${sc}/${pics}${ok}`);
    }
    console.log(`${len} s pieces (start: defence score / pictures, R right W wrong):`, rows.join(' '));
  }
}
