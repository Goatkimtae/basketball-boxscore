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
