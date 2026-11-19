/* Team colours from the people pictures: all people, or only pictures where the play is in that half
   (enough people in the picture), so waiting players practising at the empty hoop and people at the side weigh less.
     node research/direction/teams-filter.js */
'use strict';
const H = require('../../harness/lib');
const P = require('../../hoopstat/players.js');
const L = H.load('_workspace/players/hvn-left.json').people, R = H.load('_workspace/players/hvn-right.json').people;
const show = (name, people) => {
  const f = P.findTeams(people);
  const de = Math.hypot(...f.teams[0].lab.map((v, i) => v - f.teams[1].lab[i]));
  console.log(`${name}: ${people.length} people -> teams ${f.teams.map((t) => `${P.labToHex(t.lab)} [${t.numbers.join(' ')}] mass ${t.mass}`).join(' | ')}; others ${f.others.map((t) => `${P.labToHex(t.lab)} [${t.numbers.join(' ')}] mass ${t.mass}`).join(' | ')}; team colours apart ${de.toFixed(1)}`);
};
show('all', [...L, ...R]);
for (const k of [4, 6, 8]) {
  const busy = (list) => { const n = new Map(); for (const p of list) n.set(p.t, (n.get(p.t) || 0) + 1); return list.filter((p) => n.get(p.t) >= k); };
  show(`pictures with >= ${k} people`, [...busy(L), ...busy(R)]);
}
