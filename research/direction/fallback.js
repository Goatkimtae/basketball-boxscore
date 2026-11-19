/* How often the fallback guesses are right, on the labelled two-camera game:
   - "the team's most often seen number" (used for fouls and turnovers when nobody's number was seen)
   - against the shooters and rebounders labelled by eye.
     node research/direction/fallback.js */
'use strict';
const H = require('../../harness/lib');
const P = require('../../hoopstat/players.js');
const people = [...H.load('_workspace/players/hvn-left.json').people, ...H.load('_workspace/players/hvn-right.json').people];
const found = P.findTeams(people);
const prof = P.lookProfiles(people, found.teams.flatMap((t) => t.numbers));
const most = found.teams.map((t) => [...t.numbers].sort((a, b) => ((prof[b] && prof[b].seen) || 0) - ((prof[a] && prof[a].seen) || 0))[0]);
console.log('most often seen per team:', found.teams.map((t, i) => `${t.numbers.join(' ')} -> ${most[i]} (${(prof[most[i]] || {}).seen} pictures)`).join(' | '));
const teamOf = (n) => found.teams.findIndex((t) => t.numbers.includes(n));
const shooters = H.shooterLabels().filter((s) => s.shooter && teamOf(String(s.shooter)) >= 0);
const sRight = shooters.filter((s) => most[teamOf(String(s.shooter))] === String(s.shooter)).length;
console.log(`shooters labelled (team known): ${shooters.length}; most-seen number right ${sRight} (${Math.round((100 * sRight) / shooters.length)}%)`);
const reb = H.load('research/rebounds/data/rebounds.json').rebounds.filter((r) => r.rebounder && teamOf(String(r.rebounder)) >= 0);
const rRight = reb.filter((r) => most[teamOf(String(r.rebounder))] === String(r.rebounder)).length;
console.log(`rebounders labelled (team known): ${reb.length}; most-seen number right ${rRight}`);
// chance level: one player of the team at random
const chance = shooters.reduce((a, s) => a + 1 / found.teams[teamOf(String(s.shooter))].numbers.length, 0) / shooters.length;
console.log(`chance (a random player of the right team): ${Math.round(100 * chance)}%`);
