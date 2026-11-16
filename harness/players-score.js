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
  console.log(`time per shot window: ${r.secsPerShot}s (Node, wasm, one thread)`);
}
module.exports = { score };
