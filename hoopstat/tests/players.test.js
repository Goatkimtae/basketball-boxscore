/* Players stage: the parts that need no video. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../players.js');
const Flow = require('../flow.js');
const Stats = require('../stats.js');

function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

test('assignment: the Hungarian method finds the cheapest pairing (checked against trying every pairing)', () => {
  const r = rng(3);
  const perms = (n) => (n === 1 ? [[0]] : perms(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])));
  for (let k = 0; k < 40; k++) {
    const n = 1 + Math.floor(r() * 4), m = 1 + Math.floor(r() * 4);
    const C = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(r() * 100) / 10));
    const got = P.hungarian(C).reduce((s, [i, j]) => s + C[i][j], 0);
    // brute force: every way to give min(n, m) rows distinct columns
    const N = Math.max(n, m); let best = Infinity;
    for (const p of perms(N)) { let s = 0; for (let i = 0; i < n; i++) if (p[i] < m) s += C[i][p[i]]; best = Math.min(best, s); }
    assert.ok(Math.abs(got - best) < 1e-9, `case ${k}: ${got} vs ${best}`);
    assert.strictEqual(P.hungarian(C).length, Math.min(n, m));
  }
});

test('shooter number: the run of reads nearest the gather wins; one stray read does not break a run', () => {
  const reads = [[10.0, '44', 0.99], [10.2, '44', 0.95], [11.0, '11', 0.97], [11.1, '11', 0.98], [11.2, '4', 0.85], [11.3, '11', 0.99], [14.0, '44', 0.99], [14.1, '44', 0.99]];
  assert.deepStrictEqual(P.decideNumber(reads, 11.15), { number: '11', gap: 0, reads: 3 });
  assert.deepStrictEqual(P.decideNumber(reads, 13.5), { number: '44', gap: 0.5, reads: 2 });
  assert.strictEqual(P.decideNumber([[10, '9', 0.99]], 10), null, 'one read is not enough');
  assert.strictEqual(P.decideNumber([[10, '9', 0.7], [10.1, '9', 0.7]], 10), null, 'unsure reads do not count');
});

test('teams: three shirt colours, the two whose numbers are read most are the teams; a digit of "33" is dropped', () => {
  const r = rng(5), people = [];
  const add = (lab, nums, k) => { for (let i = 0; i < k; i++) people.push({ lab: lab.map((v) => v + (r() - 0.5) * 6), reads: r() < 0.6 ? [[nums[i % nums.length], 0.95]] : [] }); };
  add([40, 132, 118], ['11', '16', '28', '44', '77'], 120);           // dark blue
  add([170, 130, 126], ['9', '13', '33', '33', '33', '33', '33', '33', '69', '3'], 140);   // white, "3" is a misread 33
  add([95, 170, 150], ['21'], 25);                                    // red: people watching
  const f = P.findTeams(people);
  const names = f.teams.map((t) => t.numbers.join(' ')).sort();
  assert.deepStrictEqual(names, ['11 16 28 44 77', '9 13 33 69']);
  assert.ok(f.teams.every((t) => !t.numbers.includes('21')));
  assert.strictEqual(f.labOf([41, 131, 119]), f.teams.findIndex((t) => t.numbers.includes('44')));
  assert.strictEqual(P.findTeams(people.slice(0, 10)), null, 'too few people');
});

test('attack direction: most of a team\'s shots at one hoop; the switch time swaps the hoops', () => {
  const found = { teams: [{ numbers: ['11', '44'] }, { numbers: ['13', '33'] }], labOf: () => -1 };
  const shots = [['오른쪽', '44'], ['오른쪽', '11'], ['오른쪽', '44'], ['왼쪽', '33'], ['왼쪽', '13'], ['왼쪽', '11']].map(([side, number], i) => ({ side, number, t: i }));
  assert.strictEqual(P.attackDirection(found, shots, null).left, 1);
  const later = shots.map((s) => ({ ...s, side: s.side === '왼쪽' ? '오른쪽' : '왼쪽', t: 100 + s.t }));
  assert.strictEqual(P.attackDirection(found, [...shots, ...later], 50).left, 1, 'second half at the other ends');
  assert.strictEqual(P.attackDirection(found, shots.slice(0, 1), null), null, 'one shot is not enough');
});

test('attack direction from where the players stand: the defence is nearer the hoop it defends', () => {
  // lab [0] = team 0 (navy), [1] = team 1 (white); navy attacks the right hoop, so navy defends the left one
  const found = { teams: [{ numbers: ['44'] }, { numbers: ['33'] }], labOf: (lab) => lab[0] };
  const hoopL = { x: 60, y: 150 }, hoopR = { x: 620, y: 170 };
  const pic = (t, near, far, hoop) => [0, 1, 2].flatMap((i) => [{ t, lab: [near], x: hoop.x + 40 + 10 * i, y: hoop.y + 40 }, { t, lab: [far], x: hoop.x + 200 + 10 * i, y: hoop.y + 90 }]);
  const left = [0, 4, 8].flatMap((t) => pic(t, 0, 1, hoopL)), right = [12, 16].flatMap((t) => pic(t, 1, 0, hoopR));
  const a = P.defenceScore(found, left, hoopL, '왼쪽', null), b = P.defenceScore(found, right, hoopR, '오른쪽', null);
  assert.deepStrictEqual([a.score, a.pictures, b.score, b.pictures], [-3, 3, -2, 2]);
  const dir = P.attackDirection(found, [], null, [a, b]);
  assert.strictEqual(dir.left, 1);                                   // team 1 (white) attacks the left hoop
  assert.strictEqual(P.attackDirection(found, [], null, [b]), null, 'two pictures are not enough');
  // a picture with fewer than two of each team says nothing
  assert.strictEqual(P.defenceScore(found, pic(0, 0, 1, hoopL).slice(0, 3), hoopL, '왼쪽', null).pictures, 0);
});

test('a video with both halves: the switch time is where the evidence turns round, none when it does not', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ t: i * 10, score: i < 30 ? 1 : -1 }));
  const sw = P.findSwitch(items);
  assert.ok(sw && Math.abs(sw.t - 300) <= 10, JSON.stringify(sw));
  // the same direction all along, with some wrong votes: no switch
  const noisy = Array.from({ length: 60 }, (_, i) => ({ t: i * 10, score: i % 4 === 0 ? -1 : 1 }));
  assert.strictEqual(P.findSwitch(noisy), null);
});

test('a shooter number read automatically goes on the field goal, marked as automatic', () => {
  const shot = { start: 10, end: 11, side: '왼쪽', frames: 20, made: true, made_t: 10.4, confidence: '보통', player: '33', playerAuto: true };
  const r = Flow.infer({ shots: [shot], track: [[0, 1, 300, 40], [20, 1, 300, 40]] }, { team_left: '흰색', team_right: '남색' });
  const fg = r.events.find((e) => e.type === '야투');
  assert.deepStrictEqual([fg.player, fg.playerAuto], ['33', true]);
});

test('re-analysis: a number typed by hand stays, an automatic one gives way to the new reading', () => {
  const old = [{ time: 10, team: 'A', type: '야투', player: '7', source: '자동' }, { time: 20, team: 'A', type: '야투', player: '9', playerAuto: true, source: '자동' }];
  const fresh = [{ time: 10.2, team: 'A', type: '야투', player: '11', playerAuto: true, source: '자동' }, { time: 20.1, team: 'A', type: '야투', player: '13', playerAuto: true, source: '자동' }];
  const m = Stats.mergeReanalysis(old, fresh);
  assert.deepStrictEqual(m.map((e) => [e.player, !!e.playerAuto]), [['7', false], ['13', true]]);
});

test('colour of a group: Lab to sRGB', () => {
  assert.strictEqual(P.labToHex([255, 128, 128]), '#ffffff');
  assert.strictEqual(P.labToHex([0, 128, 128]), '#000000');
  assert.match(P.labToHex([40, 132, 118]), /^#2[0-9a-f]2[0-9a-f]3[0-9a-f]$/);
});

test('best guess: the look nearest a number\'s profile wins, a read of the number weighs in, nothing to go on gives none', () => {
  const look = (shorts) => [40, 132, 118, ...shorts, 60, 128, 128, 30, 128, 128];
  const prof = { 9: { look: look([60, 140, 100]), seen: 5 }, 13: { look: look([30, 128, 128]), seen: 5 } };   // 9: blue shorts, 13: black
  assert.strictEqual(P.guessNumber(look([58, 141, 102]), [], ['9', '13'], prof).number, '9');
  assert.strictEqual(P.guessNumber(look([32, 128, 127]), [], ['9', '13'], prof).number, '13');
  assert.strictEqual(P.guessNumber(look([45, 134, 115]), [[1, '9', 0.95], [2, '9', 0.9]], ['9', '13'], prof).number, '9', 'two reads of 9 tip a look in between');
  assert.strictEqual(P.guessNumber(null, [], ['9', '13'], prof), null);
  assert.strictEqual(P.guessNumber(null, [[1, '3', 0.9]], ['9', '13'], prof).number, '13', 'a single digit of 13 counts a little');
});

test('the rebound gets the number found for the team the play-flow rules give it, marked as a guess when guessed', () => {
  const S = { team_left: '흰색', team_right: '남색' };
  const miss = { start: 10, end: 11, side: '오른쪽', frames: 20, made: false, made_t: null, confidence: '보통', reb: { 흰색: { number: '9', guess: true }, 남색: { number: '44', guess: false } } };
  const later = { start: 40, end: 41, side: '왼쪽', frames: 20, made: false, made_t: null, confidence: '보통' };
  const r = Flow.infer({ shots: [miss, later], track: [[0, 2, 300, 40], [30, 1, 300, 40], [45, 1, 300, 40]] }, S);
  const reb = r.events.find((e) => e.type === '리바운드' && e.time < 20);
  assert.deepStrictEqual([reb.team, reb.detail, reb.player, reb.playerGuess], ['흰색', '수비', '9', true]);
  const quick = { start: 13, end: 14, side: '오른쪽', frames: 20, made: true, made_t: 13.5, confidence: '보통' };
  const r2 = Flow.infer({ shots: [miss, quick], track: [[0, 2, 300, 40], [20, 2, 300, 40]] }, S);
  const oreb = r2.events.find((e) => e.type === '리바운드');
  assert.deepStrictEqual([oreb.team, oreb.detail, oreb.player, oreb.playerGuess], ['남색', '공격', '44', false]);
});
