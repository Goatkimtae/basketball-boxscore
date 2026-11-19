/* Quarters: each analysis is one quarter; records keep q. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Stats = require('../stats.js');
const Flow = require('../flow.js');

const S = { team_left: '흰색', team_right: '남색' };
const fg = (time, team, result, q, extra = {}) => ({ time, end: time + 1, team, type: '야투', detail: '2점', result, source: '자동', side: team === '흰색' ? '왼쪽' : '오른쪽', q, ...extra });

test('linescore: points per quarter and in all', () => {
  const ev = [fg(10, '흰색', '성공', 1), fg(20, '남색', '성공', 1), fg(30, '남색', '성공', 1), fg(5, '흰색', '성공', 2),
    { time: 8, team: '흰색', type: '자유투', detail: '2점슛 파울', result: '성공', q: 2 }, fg(40, '남색', '실패', 2)];
  const ls = Stats.linescore(ev, ['흰색', '남색']);
  assert.deepStrictEqual(ls.qs, [1, 2]);
  assert.deepStrictEqual(ls.rows.map((r) => [r.team, r.pts, r.total]), [['흰색', [2, 4], 6], ['남색', [4, 0], 4]]);
  // a record from before quarters counts as the 1st
  assert.deepStrictEqual(Stats.quartersIn([{ time: 1, team: '흰색', type: '야투', result: '성공' }]), [1]);
  assert.strictEqual(Stats.quarterName(2), '2쿼터'); assert.strictEqual(Stats.quarterName(5), '연장 1');
});

test('re-analysing a quarter replaces only that quarter', () => {
  const old = [fg(10, '흰색', '성공', 1, { player: '33' }), fg(50, '남색', '실패', 1), { time: 70, team: '남색', type: '어시스트', source: '수동', q: 1 },
    fg(12, '흰색', '실패', 2)];
  const out = Stats.mergeReanalysis(old, [fg(10.4, '흰색', '성공'), fg(30, '남색', '성공')], 1);
  const q1 = out.filter((e) => Stats.qOf(e) === 1), q2 = out.filter((e) => Stats.qOf(e) === 2);
  assert.deepStrictEqual(q1.map((e) => e.time), [10.4, 30, 70]);   // the 50 s shot is gone, the manual record stays
  assert.strictEqual(q1[0].player, '33');                          // the number carried over
  assert.deepStrictEqual(q2.map((e) => e.time), [12]);             // the 2nd quarter untouched
  assert.ok(out.every((e) => e.q));
});

test('rebounds and turnovers are worked out inside each quarter, not across them', () => {
  // the 1st quarter ends with a 흰색 miss at 100 s; the 2nd starts with a 흰색 shot at 101 s of its own video
  const ev = [fg(100, '흰색', '실패', 1), fg(101.5, '흰색', '실패', 2), fg(130, '남색', '성공', 2)];
  const out = Flow.deriveQuarters(ev, S, () => ({ mode: 'two', segs: [] }));
  const reb = out.filter((e) => e.type === '리바운드');
  // not an offensive rebound from one quarter to the next
  assert.ok(!reb.some((e) => Stats.qOf(e) === 1 && e.detail === '공격'));
  assert.ok(out.every((e) => e.q === 1 || e.q === 2));
  const q2 = out.filter((e) => e.q === 2).map((e) => e.time);
  assert.deepStrictEqual(q2, [...q2].sort((a, b) => a - b));
});

test('attack direction per quarter: saved, else the nearest quarter with the half-time switch, else A on the left', () => {
  const qs = { 1: { dir: { left: 'B', source: '자동' } } };
  assert.strictEqual(Stats.dirOf(qs, 1).left, 'B');
  assert.strictEqual(Stats.dirOf(qs, 2).left, 'B');                    // same half
  assert.strictEqual(Stats.dirOf(qs, 3).left, 'A');                    // the other half: other ends
  assert.strictEqual(Stats.dirOf(qs, 5).left, 'A');                    // overtime like the 4th
  assert.strictEqual(Stats.dirOf({}, 1).source, '기본');
  // a quarter only guessed by default does not lead the others
  assert.strictEqual(Stats.dirOf({ 1: { dir: { left: 'B', source: '기본' } } }, 3).source, '기본');
});

test('one video with several quarters: the quarter of a moment, unsure near an edge or in a break', () => {
  const spans = [{ q: 1, start: 30, end: 700 }, { q: 2, start: 820, end: 1500 }];
  assert.deepStrictEqual(Stats.qAt(spans, 300), { q: 1, unsure: false });
  assert.deepStrictEqual(Stats.qAt(spans, 690), { q: 1, unsure: true });     // 10 s before the end
  assert.deepStrictEqual(Stats.qAt(spans, 900), { q: 2, unsure: false });
  assert.strictEqual(Stats.qAt(spans, 760).unsure, true);                      // in the break
  assert.strictEqual(Stats.qAt([], 5), null);
});

test('quarter breaks suggested from long quiet stretches without shots, never from the length alone', () => {
  // four quarters of about 12 min of video each, breaks of 2-3 min; one long quiet free-throw-less stretch inside Q2 (70 s)
  const shots = [];
  const play = (a, b) => { for (let t = a; t < b; t += 25) shots.push(t); };
  play(20, 700); play(860, 1300); play(1370, 1560); play(2000, 2700); play(2850, 3500);
  const quiet = (t1, t2) => ([[700, 860], [1560, 2000], [2700, 2850]].some(([a, b]) => t1 >= a - 10 && t2 <= b + 10) ? 0.3 : 1);
  const r = Stats.suggestQuarters({ shots, duration: 3560, nQ: 4, qLen: 600, motion: quiet });
  assert.ok(r, 'a suggestion');
  assert.deepStrictEqual(r.spans.map((x) => x.q), [1, 2, 3, 4]);
  const cuts = r.spans.slice(1).map((x) => x.start);
  assert.ok(Math.abs(cuts[0] - 780) < 30 && Math.abs(cuts[1] - 1780) < 30 && Math.abs(cuts[2] - 2775) < 30, JSON.stringify(cuts));
  assert.match(r.why, /슛 없음/);
  // too few breaks for the quarters asked: no suggestion rather than equal pieces
  assert.strictEqual(Stats.suggestQuarters({ shots: [10, 20, 30, 40], duration: 3000, nQ: 4, qLen: 600 }), null);
});

test('quarter totals add up to the whole game; percentages come from the counts, not averaged', () => {
  const sh = (q, team, made, kind = '2점') => ({ q, time: 10, team, type: '야투', detail: kind, result: made ? '성공' : '실패' });
  const ev = [sh(1, 'A', true), sh(1, 'A', false), sh(1, 'A', false), sh(2, 'A', true, '3점'), { q: 2, time: 5, team: 'A', type: '자유투', detail: '2점슛 파울', result: '성공' },
    { q: 1, time: 9, team: 'A', type: '리바운드', detail: '공격' }, { q: 2, time: 9, team: 'A', type: '턴오버' }, { q: 5, time: 1, team: 'A', type: '파울' }];
  const whole = Stats.boxScore(ev, ['A', 'B']).teams[0][1];
  const per = Stats.quartersIn(ev).map((q) => Stats.boxScore(ev.filter((e) => Stats.qOf(e) === q), ['A', 'B']).teams[0][1]);
  for (const k of Stats.COLS.filter((c) => !c.endsWith('%'))) assert.strictEqual(per.reduce((a, t) => a + t[k], 0), whole[k], k);
  assert.strictEqual(whole['FG%'], 50);              // 2 of 4, not the mean of 33.3 and 100
});
