/* Score a browser run (e2e.js output) against the hand-labelled shooters: which shots got a number and
   whether it is right. Shots are matched to labels by camera and start time.

     node harness/e2e-score.js <_workspace/e2e/....json>                                          */
'use strict';
const H = require('./lib');
const file = H.args()._[0];
if (!file) { console.error('usage: node harness/e2e-score.js <e2e result json>'); process.exit(2); }
const log = H.load(file), c = H.config(), g = c.games[log.game];
if (!log.players) { console.error('no [players] line in this run (players stage off or failed)'); process.exit(1); }
const ref = H.shooterLabels();
console.log('teams', JSON.stringify(log.players.teams), 'direction votes', JSON.stringify(log.players.direction));
const out = { right: [], wrong: [], blank: [], filledNoLabel: [] };
for (const [cam, start, , number] of log.players.shots) {
  const c2 = cam === 'A' ? 'L' : 'R', s = ref.find((x) => x.cam === c2 && Math.abs(x.start - start) < 0.4);
  const t = start + (cam === 'B' ? Number(log.fields.cam_offset || g.offset || 0) : 0);
  const rec = log.records.find((r) => (r[3] === '야투' || r[3] === '자유투') && Math.abs(Number(r[0]) - t) < 0.3);
  const filled = rec && /\(자동\)/.test(rec[2]) ? rec[2].replace(/\s*\(자동\)/, '') : null;
  const id = s ? `${c2}${s.k}${s.shooter && !s.sure ? '?' : ''}` : `${c2}@${start}`;
  if (s && s.shooter) out[filled === s.shooter ? 'right' : filled ? 'wrong' : 'blank'].push(filled && filled !== s.shooter ? `${id}:${filled}` : id);
  else if (filled) out.filledNoLabel.push(`${id}:${filled}`);
}
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(14), String(v.length).padStart(2), v.join(' '));
console.log(`time: ${log.seconds}s, stages ${JSON.stringify(log.stages)}`);
