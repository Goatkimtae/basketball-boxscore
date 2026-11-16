/* Score a two-camera game's players-stage run against the hand labels: teams and their numbers, attack
   direction, and the shooter numbers the app would fill in (number read near the gather AND on the list of
   the team attacking that hoop).

     node harness/players-score.js <game key>        (after players-run.js on both of its videos)

   Labels are by eye (research/jersey-numbers/data/shots.json); "?" marks a label that was probable, not sure. */
'use strict';
const H = require('./lib');
global.cv = global.cv || {}; global.ort = global.ort || {};
const P = require(require('path').join(H.APP, 'players.js'));

function score(game) {
  const c = H.config(), g = c.games[game];
  const L = H.load(H.out('players', `${g.left}.json`)), R = H.load(H.out('players', `${g.right}.json`));
  const found = P.findTeams([...L.people, ...R.people]);
  const shots = [...L.shots.map((s) => ({ ...s, side: '왼쪽' })), ...R.shots.map((s) => ({ ...s, side: '오른쪽' }))];
  const dir = found && P.attackDirection(found, shots, null);
  const res = { teams: found && found.teams.map((t) => ({ colour: t.colour, numbers: t.numbers })), others: found && found.others.map((t) => t.numbers),
    direction: dir && dir.votes, right: [], wrong: [], blank: [], filledNoLabel: [], rejected: [] };
  for (const s of shots) {
    const team = dir ? found.teams[s.side === '왼쪽' ? dir.left : 1 - dir.left] : null;
    const n = team && s.number && team.numbers.includes(s.number) ? s.number : null;
    if (s.number && !n) res.rejected.push(`${s.id}:${s.number}`);
    const tag = s.id + (s.label && !s.sure ? '?' : '');
    if (s.label) res[n === s.label ? 'right' : n ? 'wrong' : 'blank'].push(n && n !== s.label ? `${tag}:${n}` : tag);
    else if (n) res.filledNoLabel.push(`${s.id}:${n}`);
  }
  // best guess where nothing was filled in: look profiles from the people pictures + unsure reads, within the attacking team's list
  res.guess = { right: [], wrong: [], none: [], noLabel: [] };
  if (found && dir) {
    const people = [...L.people, ...R.people];
    const prof = P.lookProfiles(people, [...found.teams[0].numbers, ...found.teams[1].numbers]);
    res.profiles = Object.fromEntries(Object.entries(prof).map(([n, v]) => [n, v.seen]));
    for (const s of shots) {
      const team = found.teams[s.side === '왼쪽' ? dir.left : 1 - dir.left];
      if (s.number && team.numbers.includes(s.number)) continue;           // filled in surely
      const g = P.guessNumber(s.look, s.reads, team.numbers, prof);
      const tag = s.id + (s.label && !s.sure ? '?' : '');
      if (!g) { (s.label ? res.guess.none : res.guess.noLabel).push(tag); continue; }
      if (s.label) res.guess[g.number === s.label ? 'right' : 'wrong'].push(`${tag}:${g.number}(${g.p})`);
      else res.guess.noLabel.push(`${tag}:${g.number}(${g.p})`);
    }
  }
  // rebounds: (1) the next shot at the same hoop within 3 s is a put-back: its shooter rebounded; (2) a number read surely on the
  // picked person; (3) best guess over both teams' lists (the look includes the shirt, so the team comes with it)
  res.reb = { right: [], wrong: [], none: [], teamRight: 0, teamWrong: 0, teamNone: 0, how: {} };
  if (found && dir) {
    const people = [...L.people, ...R.people], both = [...found.teams[0].numbers, ...found.teams[1].numbers];
    const prof = P.lookProfiles(people, both);
    const teamOfNum = (n) => found.teams.findIndex((t) => t.numbers.includes(n));
    const finalShot = (s) => {        // the shooter number the app would end up with (sure, else guessed)
      const team = found.teams[s.side === '왼쪽' ? dir.left : 1 - dir.left];
      if (s.number && team.numbers.includes(s.number)) return s.number;
      const g = P.guessNumber(s.look, s.reads, team.numbers, prof);
      return g ? g.number : null;
    };
    const labelTeam = (name) => (name === 'navy' ? teamOfNum('44') : name === 'white' ? teamOfNum('33') : -1);
    for (const [cam, data] of [['L', L], ['R', R]]) {
      for (const r of data.rebounds || []) {
        const side = cam === 'L' ? '왼쪽' : '오른쪽';
        const next = shots.filter((s) => s.side === side && s.start != null ? s.start > r.end && s.start <= r.end + 3 : false)[0]
          || (data.shots || []).map((s) => ({ ...s, side })).find((s) => { const lab = H.shooterLabels(cam).find((x) => `${x.cam}${x.k}` === s.id); return lab && lab.start > r.end && lab.start <= r.end + 3; });
        let n = null, how = '';
        if (next) { n = finalShot(next); how = 'put-back'; }
        if (!n && r.number && teamOfNum(r.number) >= 0) { n = r.number; how = 'read'; }
        if (!n) { const g = P.guessNumber(r.look, r.reads, both, prof); if (g) { n = g.number; how = `guess(${g.p})`; } }
        res.reb.how[r.id] = how;
        const tag = `${r.id}${r.label && !r.sure ? '?' : ''}`;
        if (r.label) res.reb[n === r.label ? 'right' : n ? 'wrong' : 'none'].push(`${tag}:${n || '-'}[${how}]`);
        const lt = labelTeam(r.team);
        if (lt < 0) continue;
        const pt = n ? teamOfNum(n) : -1;
        if (pt < 0) res.reb.teamNone++; else if (pt === lt) res.reb.teamRight++; else res.reb.teamWrong++;
      }
    }
  }
  res.labelled = shots.filter((s) => s.label).length; res.shots = shots.length;
  res.secsPerShot = Math.round((shots.reduce((a, s) => a + (s.secs || 0), 0) / Math.max(1, shots.length)) * 10) / 10;
  return res;
}

if (require.main === module) {
  const game = H.args()._[0];
  if (!game) { console.error('usage: node harness/players-score.js <game key>'); process.exit(2); }
  const r = score(game);
  console.log('teams:', (r.teams || []).map((t) => `${t.colour} ${t.numbers.join('·')}`).join('  |  '), ' others:', JSON.stringify(r.others));
  console.log('attack direction votes [team][left, right]:', JSON.stringify(r.direction));
  console.log(`shooter numbers filled in, of ${r.labelled} labelled shots: right ${r.right.length}, wrong ${r.wrong.length}, blank ${r.blank.length}`);
  for (const k of ['right', 'wrong', 'blank', 'filledNoLabel', 'rejected']) console.log(`  ${k.padEnd(14)} ${r[k].join(' ')}`);
  if (r.guess) {
    console.log('look profiles (pictures per number):', JSON.stringify(r.profiles));
    console.log(`best guess where nothing was filled in: right ${r.guess.right.length}, wrong ${r.guess.wrong.length}, no guess ${r.guess.none.length} (labelled); ${r.guess.noLabel.length} without a label`);
    for (const k of ['right', 'wrong', 'none', 'noLabel']) console.log(`  guess ${k.padEnd(8)} ${r.guess[k].join(' ')}`);
  }
  if (r.reb && (r.reb.right.length + r.reb.wrong.length + r.reb.none.length)) {
    console.log(`rebounder number (labelled rebounds): right ${r.reb.right.length}, wrong ${r.reb.wrong.length}, none ${r.reb.none.length}; team right ${r.reb.teamRight}, wrong ${r.reb.teamWrong}, none ${r.reb.teamNone}`);
    for (const k of ['right', 'wrong', 'none']) console.log(`  rebound ${k.padEnd(6)} ${r.reb[k].join(' ')}`);
  }
  console.log(`time per shot window: ${r.secsPerShot}s (Node, wasm, one thread)`);
}
module.exports = { score };
