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
