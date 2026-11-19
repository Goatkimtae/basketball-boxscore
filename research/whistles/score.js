/* Score the app's two-camera foul judgement (Flow.infer, the same code the app runs) against the hand labels
   (research/whistles/data/labels-*.json): which whistle-like sounds became fouls, and the free throws.
     node research/whistles/score.js     (needs _workspace/engine/hvn-*.json and _workspace/whistles/merged.json)
   Sounds labelled during_dead_ball (inside a stop already called) are left out of the stop counts. */
'use strict';
const fs = require('fs'), path = require('path');
const H = require('../../harness/lib');
const Flow = require('../../hoopstat/flow.js');
const dir = path.join(H.ROOT, 'research/whistles/data');
const labels = fs.readdirSync(dir).filter((f) => /^labels-.*\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const OFF = 1.12;   // camera B time + OFF = game clock (this game)
const L = H.load('_workspace/engine/hvn-left.json'), R = H.load('_workspace/engine/hvn-right.json');
const cams = [{ id: 'A', side: '왼쪽', track: L.track, offset: 0, shots: L.shots }, { id: 'B', side: '오른쪽', track: R.track, offset: OFF, shots: R.shots }];
const split = Flow.splitPractice(cams);
const shift = (sh, o) => ({ ...sh, start: sh.start + o, end: sh.end + o, made_t: sh.made_t == null ? null : sh.made_t + o });
const result = {
  shots: [...split[0].game.map((sh) => ({ ...sh, cam: 'A' })), ...split[1].game.map((sh) => ({ ...shift(sh, OFF), cam: 'B' }))],
  cams: cams.map(({ shots, ...c }) => c),
  whistles: H.load('_workspace/whistles/merged.json'),
};
const S = { team_left: '흰색', team_right: '남색' };   // white attacks the left hoop, navy the right
const TEAM = { white: '흰색', navy: '남색' };
const { events } = Flow.infer(result, S);
const near = (t, type) => events.find((e) => e.type === type && Math.abs(e.time - t) < 0.3);
const r = { fouls: 0, found: 0, teamRight: 0, falseFoul: 0, notFoul: 0, deadAsFoul: 0, deadOk: 0 };
for (const w of result.whistles) {
  const l = labels.find((q) => Math.abs(q.t - w.t) < 1), foul = near(w.t, '파울');
  const call = foul ? `FOUL ${foul.team}${foul.player ? ' #' + foul.player : ''}` : near(w.t, '휘슬') ? 'closed' : '-';
  console.log(`${w.t.toFixed(1).padStart(6)} ${call.padEnd(14)} label ${l ? `${l.verdict}/${l.reason || ''}${l.during_dead_ball ? '/dead ball' : ''}${l.fouling_team ? '/' + l.fouling_team : ''}` : 'none'}`);
  if (!l) continue;
  if (l.during_dead_ball) { if (foul) r.deadAsFoul++; else r.deadOk++; continue; }
  if (l.reason === 'foul') { r.fouls++; if (foul) { r.found++; if (foul.team === TEAM[l.fouling_team]) r.teamRight++; } } else if (foul) r.falseFoul++; else r.notFoul++;
}
const fts = events.filter((e) => e.type === '자유투');
console.log(`free throws: ${fts.map((e) => `${e.time}(${e.team}, ${e.result})`).join(', ') || 'none'}`);
console.log(`fouls found ${r.found}/${r.fouls} (team right ${r.teamRight}), false fouls ${r.falseFoul}/${r.falseFoul + r.notFoul} (other sounds), dead-ball sounds called fouls ${r.deadAsFoul}/${r.deadAsFoul + r.deadOk}`);
