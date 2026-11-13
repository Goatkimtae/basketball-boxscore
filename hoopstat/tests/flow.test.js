/* Play-flow rules on made-up games. Run: node --test hoopstat/tests */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Flow = require('../flow.js');
const Stats = require('../stats.js');

const S = { team_left: '빨강', team_right: '남색' };   // 빨강 attacks the left hoop, 남색 the right
const shot = (start, side, made = false, len = 1.0) => ({ start, end: start + len, side, frames: 20, made, made_t: made ? start + 0.4 : null, confidence: '보통' });
// camera looks: [[side, from, to], ...] -> track sampled every 0.1 s
function track(looks, until) {
  const out = [];
  for (let t = 0; t <= until; t = Math.round((t + 0.1) * 10) / 10) {
    const l = looks.find(([, a, b]) => t >= a && t <= b);
    out.push([t, l ? (l[0] === 'L' ? 1 : 2) : 0, 300]);
  }
  return out;
}
const brief = (r) => r.events.map((e) => `${e.time}|${e.team}|${e.type}|${e.detail}|${e.result}`);

test('offensive and defensive rebounds follow the next shot', () => {
  const r = Flow.infer({ shots: [shot(5, '오른쪽'), shot(9, '오른쪽'), shot(25, '왼쪽', true)], track: track([['R', 0, 15], ['L', 18, 30]], 30) }, S);
  assert.deepStrictEqual(brief(r), [
    '5|남색|야투|2점|실패', '6.3|남색|리바운드|공격|', '9|남색|야투|2점|실패', '10.3|빨강|리바운드|수비|', '25|빨강|야투|2점|성공']);
});

test('a shot at the other end 2 s later drops the shot the camera leaves', () => {
  const r = Flow.infer({ shots: [shot(20, '오른쪽'), shot(21.5, '왼쪽')], track: track([['R', 0, 20.5], ['L', 21, 30]], 30) }, S);
  assert.strictEqual(r.summary.dropped, 1);
  assert.deepStrictEqual(r.events.filter((e) => e.type === '야투').map((e) => e.team), ['빨강']);
});

test('ball lost without a shot is a turnover', () => {
  // 빨강 scores, 남색 brings it up (camera to the right), then 빨강 shoots again at the left
  const r = Flow.infer({ shots: [shot(10, '왼쪽', true), shot(30, '왼쪽')], track: track([['L', 5, 12], ['R', 14, 20], ['L', 22, 35]], 35), whistles: [] }, S);
  const to = r.events.find((e) => e.type === '턴오버');
  assert.ok(to, 'turnover expected');
  assert.strictEqual(to.team, '남색');
  assert.ok(to.time >= 18 && to.time <= 22, `turnover time ${to.time}`);
});

test('whistle at a missed shot then one shot after a pause: 2-point shooting foul, one free throw worth 2', () => {
  const r = Flow.infer({ shots: [shot(40, '오른쪽'), shot(60, '오른쪽', true), shot(75, '왼쪽')], track: track([['R', 30, 62], ['L', 66, 80]], 80),
    whistles: [{ t: 40.6, dur: 0.6, f: 3000 }] }, S);
  assert.deepStrictEqual(brief(r).slice(0, 3), ['40.6|빨강|파울|슈팅파울|', '60|남색|자유투|2점슛 파울 1구|성공', '75|빨강|야투|2점|실패']);
  const box = Object.fromEntries(Stats.boxScore(r.events, ['빨강', '남색']).teams);
  assert.strictEqual(box['남색'].PTS, 2);
  assert.strictEqual(box['남색'].FGA, 0, 'the fouled miss is not a field goal attempt');
  assert.strictEqual(box['빨강'].PF, 1);
});

test('two shots after the whistle: 3-point shooting foul (2 + 1 points)', () => {
  const r = Flow.infer({ shots: [shot(40, '오른쪽'), shot(60, '오른쪽', true), shot(68, '오른쪽', true)], track: track([['R', 30, 80]], 80),
    whistles: [{ t: 40.5, dur: 0.8, f: 3000 }] }, S);
  const ft = r.events.filter((e) => e.type === '자유투');
  assert.deepStrictEqual(ft.map((e) => e.detail), ['3점슛 파울 1구', '3점슛 파울 2구']);
  assert.strictEqual(Object.fromEntries(Stats.boxScore(r.events, ['빨강', '남색']).teams)['남색'].PTS, 3);
});

test('made shot with a whistle: and-one, one free throw worth 1', () => {
  const r = Flow.infer({ shots: [shot(40, '왼쪽', true), shot(55, '왼쪽', true)], track: track([['L', 30, 60]], 60), whistles: [{ t: 40.9, dur: 0.5, f: 3000 }] }, S);
  assert.deepStrictEqual(brief(r), ['40|빨강|야투|2점|성공', '40.9|남색|파울|슈팅파울|', '55|빨강|자유투|앤드원|성공']);
  assert.strictEqual(Object.fromEntries(Stats.boxScore(r.events, ['빨강', '남색']).teams)['빨강'].PTS, 3);
});

test('a whistle away from any shot is listed for review and not counted', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽')], track: track([['L', 0, 20]], 20), whistles: [{ t: 15, dur: 0.6, f: 3000 }] }, S);
  const w = r.events.find((e) => e.type === '휘슬');
  assert.ok(w && w.team === '');
  const box = Object.fromEntries(Stats.boxScore(r.events, ['빨강', '남색']).teams);
  assert.strictEqual(box['빨강'].PF + box['남색'].PF, 0);
});

test('re-analysis keeps jersey numbers typed on automatic records', () => {
  const old = [{ time: 9.9, team: '남색', player: '1', type: '리바운드', detail: '공격', source: '자동' },
    { time: 30, team: '빨강', player: '', type: '스틸', source: '수동' }];
  const auto = [{ time: 10.0, team: '남색', player: '', type: '리바운드', detail: '공격', source: '자동' }];
  const m = Stats.mergeReanalysis(old, auto);
  assert.deepStrictEqual(m.map((e) => [e.time, e.player, e.source]), [[10, '1', '자동'], [30, '', '수동']]);
});
