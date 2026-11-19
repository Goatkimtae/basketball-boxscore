/* Play-flow rules on made-up games. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Flow = require('../flow.js');
const Stats = require('../stats.js');

const S = { team_left: '빨강', team_right: '남색' };   // 빨강 attacks the left hoop, 남색 the right
const shot = (start, side, made = false, len = 1.0) => ({ start, end: start + len, side, frames: 20, made, made_t: made ? start + 0.4 : null, confidence: '보통' });
// camera looks [[side, from, to], ...] and still periods [[from, to, level]] -> track sampled every 0.1 s.
// Scene motion is 40 (x1000) while players move, `level` while they stand.
function track(looks, until, still = []) {
  const out = [];
  for (let t = 0; t <= until; t = Math.round((t + 0.1) * 10) / 10) {
    const l = looks.find(([, a, b]) => t >= a && t <= b);
    const st = still.find(([a, b]) => t >= a && t < b);
    out.push([t, l ? (l[0] === 'L' ? 1 : 2) : 0, 300, st ? st[2] : 40]);
  }
  return out;
}
const brief = (r) => r.events.map((e) => `${e.time}|${e.team}|${e.type}|${e.detail}|${e.result}`);
const box = (r) => Object.fromEntries(Stats.boxScore(r.events, ['빨강', '남색']).teams);
const whistle = (t) => ({ t, dur: 0.5, f: 3300 });

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

test('whistle at a missed shot, play stops, one still shot at the same hoop: shooting foul and one free throw worth 2', () => {
  const r = Flow.infer({ shots: [shot(40, '오른쪽'), shot(60, '오른쪽', true), shot(75, '왼쪽')],
    track: track([['R', 30, 62], ['L', 66, 80]], 80, [[41, 60, 12]]), whistles: [whistle(40.6)] }, S);
  assert.deepStrictEqual(brief(r).slice(0, 3), ['40.6|빨강|파울|슈팅파울|', '60|남색|자유투|2점슛 파울|성공', '75|빨강|야투|2점|실패']);
  assert.strictEqual(box(r)['남색'].PTS, 2);
  assert.strictEqual(box(r)['남색'].FGA, 0, 'the fouled miss is not a field goal attempt');
  assert.strictEqual(box(r)['빨강'].PF, 1);
});

test('the fouled shot need not be seen: whistle, stoppage, then a still shot is still a free throw', () => {
  const r = Flow.infer({ shots: [shot(60, '오른쪽')], track: track([['L', 0, 10], ['R', 30, 70]], 70, [[37, 60, 10]]), whistles: [whistle(36)] }, S);
  assert.deepStrictEqual(brief(r).slice(0, 2), ['36|빨강|파울|슈팅파울|', '60|남색|자유투|2점슛 파울|실패']);
});

test('team rule: only one free throw per foul; a later shot at the same hoop is a field goal', () => {
  // missed free throw at 60, offensive rebound, put-back at 64
  const r = Flow.infer({ shots: [shot(40, '오른쪽'), shot(60, '오른쪽'), shot(64, '오른쪽', true)],
    track: track([['L', 0, 10], ['R', 30, 80]], 80, [[41, 60, 12]]), whistles: [whistle(40.5)] }, S);
  assert.deepStrictEqual(brief(r), ['40.5|빨강|파울|슈팅파울|', '60|남색|자유투|2점슛 파울|실패', '61.3|남색|리바운드|공격|', '64|남색|야투|2점|성공']);
});

test('a free throw for a 3-point foul counts 3 points when made', () => {
  const ev = [{ time: 60, team: '남색', type: '자유투', detail: '3점슛 파울', result: '성공' },
    { time: 70, team: '남색', type: '자유투', detail: '2점슛 파울', result: '성공' },
    { time: 80, team: '남색', type: '자유투', detail: '앤드원', result: '성공' }];
  const s = Object.fromEntries(Stats.boxScore(ev, ['빨강', '남색']).teams)['남색'];
  assert.deepStrictEqual([s.PTS, s.FTM, s.FTA], [6, 3, 3]);
});

test('made shot with a whistle: and-one, one free throw worth 1', () => {
  const r = Flow.infer({ shots: [shot(40, '왼쪽', true), shot(55, '왼쪽', true)], track: track([['R', 0, 10], ['L', 30, 60]], 60, [[41.5, 55, 10]]),
    whistles: [whistle(40.9)] }, S);
  assert.deepStrictEqual(brief(r), ['40|빨강|야투|2점|성공', '40.9|남색|파울|슈팅파울|', '55|빨강|자유투|앤드원|성공']);
  assert.strictEqual(box(r)['빨강'].PTS, 3);
});

test('a whistle-like sound after which play goes on is ignored', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(30, '오른쪽')], track: track([['L', 0, 20], ['R', 22, 40]], 40), whistles: [whistle(15)] }, S);
  assert.strictEqual(r.summary.fouls, 0);
  assert.ok(!r.events.some((e) => e.type === '파울' || e.type === '휘슬'));
});

test('a stoppage whistle with play going on by inbound (no still shot) is a foul on the team without the ball', () => {
  // 남색 rebounds at the left (빨강 miss), whistle at 20 while 남색 has the ball, inbound, live shot at 30 (players moving)
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(30, '오른쪽')], track: track([['L', 0, 22], ['R', 24, 40]], 40, [[21, 27, 12]]),
    whistles: [whistle(20)] }, S);
  const f = r.events.filter((e) => e.type === '파울');
  assert.deepStrictEqual(f.map((e) => [e.time, e.team, e.detail]), [[20, '빨강', '개인파울']]);
  assert.strictEqual(r.summary.ft, 0);
});

test('a stoppage whistle right after a missed shot: foul on the defence, no rebound, same team keeps the ball', () => {
  const r = Flow.infer({ shots: [shot(72, '오른쪽', false, 0.3), shot(132, '왼쪽')], track: track([['R', 60, 90], ['L', 100, 140]], 140, [[75.5, 86, 15]]),
    whistles: [whistle(74.6)] }, S);
  assert.deepStrictEqual(brief(r).slice(0, 2), ['72|남색|야투|2점|실패', '74.6|빨강|파울|개인파울|']);
  assert.ok(!r.events.some((e) => e.type === '리바운드' && e.time < 100), 'no rebound after the fouled shot');
});

test('one-hoop video (fixed camera): quick second shot = offensive rebound, late one = defensive; no turnovers guessed', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(14, '왼쪽'), shot(40, '왼쪽')], track: track([['L', 0, 60]], 60) }, S);
  assert.strictEqual(r.summary.mode, 'one');
  assert.deepStrictEqual(r.events.filter((e) => e.type === '리바운드').map((e) => [e.team, e.detail]),
    [['빨강', '공격'], ['남색', '수비'], ['남색', '수비']]);
  assert.strictEqual(r.summary.to, 0, 'the other hoop is not seen, so a lost ball cannot be told from a shot there');
});

test('re-analysis keeps jersey numbers typed on automatic records', () => {
  const old = [{ time: 9.9, team: '남색', player: '1', type: '리바운드', detail: '공격', source: '자동' },
    { time: 30, team: '빨강', player: '', type: '스틸', source: '수동' }];
  const auto = [{ time: 10.0, team: '남색', player: '', type: '리바운드', detail: '공격', source: '자동' }];
  const m = Stats.mergeReanalysis(old, auto);
  assert.deepStrictEqual(m.map((e) => [e.time, e.player, e.source]), [[10, '1', '자동'], [30, '', '수동']]);
});

test('two fixed cameras: a shot at the empty hoop while the players are at the other end is practice', () => {
  // motion per camera: [t, side, x, motion x1000]; the play is at the left end 0-60 s, then at the right end
  const tr = (busy) => Array.from({ length: 1200 }, (_, i) => { const t = i / 10; return [t, 1, 0, busy(t) ? 40 : 2]; });
  const left = tr((t) => t < 60), right = tr((t) => t >= 60);
  const cams = [{ shots: [shot(20, '왼쪽'), shot(90, '왼쪽')], track: left, offset: 0 },
    { shots: [shot(30, '오른쪽'), shot(100, '오른쪽')], track: right, offset: 0.5 }];
  const [a, b] = Flow.splitPractice(cams);
  assert.deepStrictEqual(a.game.map((s) => s.start), [20]);
  assert.deepStrictEqual(a.practice.map((s) => s.start), [90]);      // left hoop while the play is at the right end
  assert.deepStrictEqual(b.game.map((s) => s.start), [100]);
  assert.deepStrictEqual(b.practice.map((s) => s.start), [30]);
  // both ends quiet (a dead ball, a free throw): nothing is called practice
  const quiet = tr(() => false);
  const [c] = Flow.splitPractice([{ shots: [shot(20, '왼쪽')], track: quiet, offset: 0 }, { shots: [], track: quiet, offset: 0 }]);
  assert.strictEqual(c.practice.length, 0);
});

test('whistle rows get a guessed team: the defending team of a shot right before, else the opponent of the team with the ball', () => {
  const s = { team_left: '흰색', team_right: '남색' };
  const ev = [
    { time: 10, end: 11, team: '흰색', side: '왼쪽', type: '야투', detail: '2점', result: '실패', source: '자동', player: '33' },
    { time: 12, team: '', type: '휘슬', source: '자동', note: 'w1' },       // 2 s after a 흰색 shot: 남색's shooting foul
    { time: 40, end: 41, team: '남색', side: '오른쪽', type: '야투', detail: '2점', result: '성공', source: '자동' },
    { time: 50, team: '', type: '휘슬', source: '자동', note: 'w2' },       // after 남색 scored, 흰색 has the ball: 남색 fouled
    { time: 60, team: '남색', type: '휘슬', source: '수동', note: 'w3' },   // set by hand: left alone
  ];
  const out = Flow.derive(ev, s, { mode: 'two', segs: [] });
  const w = (n) => out.find((e) => e.type === '휘슬' && (e.note || '').startsWith(n));
  assert.strictEqual(w('w1').team, '남색'); assert.ok(w('w1').teamGuess); assert.strictEqual(w('w1').guessDetail, '슈팅파울');
  assert.match(w('w1').note, /33번/);
  assert.strictEqual(w('w2').team, '남색'); assert.strictEqual(w('w2').guessDetail, '개인파울');
  assert.strictEqual(w('w3').team, '남색'); assert.ok(!w('w3').teamGuess);
  // a guessed team does not count in the box score
  const box = Stats.boxScore(out, ['흰색', '남색']);
  assert.strictEqual(Object.fromEntries(box.teams)['남색'].PF, 0);
  // running it again does not stack the explanation
  const again = Flow.derive(out, s, { mode: 'two', segs: [] });
  assert.strictEqual((again.find((e) => (e.note || '').startsWith('w1')).note.match(/팀 추정/g) || []).length, 1);
});

test('two fixed cameras: a whistle at a shot, then the next shot at the same hoop 8-40 s later, is a shooting foul with a number; other whistles are closed', () => {
  const tr = Array.from({ length: 1500 }, (_, i) => [i / 10, 1, 0, 40]);
  const sh = { ...shot(28.5, '왼쪽'), def: { team: '남색', number: '44', guess: false } };
  const result = {
    shots: [sh, shot(42, '왼쪽', true),                  // 28.8 whistle at 빨강's shot, 42 s: the free throw
      shot(60, '오른쪽'), shot(61, '왼쪽'),              // 59.6 whistle at 남색's shot, but the next shot is at the other hoop
      shot(80.9, '왼쪽'), shot(92, '왼쪽')],             // 80 whistle 0.9 s before a shot: not for that shot
    cams: [{ id: 'A', side: '왼쪽', track: tr, offset: 0 }, { id: 'B', side: '오른쪽', track: tr, offset: 0 }],
    whistles: [{ t: 28.8, dur: 1.2, f: 3300 }, { t: 59.6, dur: 1.0, f: 3300 }, { t: 70, dur: 1.0, f: 3300 }, { t: 80, dur: 1.0, f: 3300 }],
    mostSeen: { 빨강: '9', 남색: '28' },
  };
  const { events } = Flow.infer(result, S);
  const fouls = events.filter((e) => e.type === '파울'), wh = events.filter((e) => e.type === '휘슬');
  assert.strictEqual(fouls.length, 1);
  assert.strictEqual(fouls[0].team, '남색'); assert.strictEqual(fouls[0].detail, '슈팅파울');
  assert.strictEqual(fouls[0].player, '44');            // the shooter's nearest opponent
  const ft = events.filter((e) => e.type === '자유투');
  assert.strictEqual(ft.length, 1); assert.strictEqual(ft[0].time, 42); assert.strictEqual(ft[0].team, '빨강');
  assert.ok(!events.some((e) => e.type === '야투' && e.time === 28.5));   // the missed fouled shot is not a field goal attempt
  assert.deepStrictEqual(wh.map((e) => e.time), [59.6, 70, 80]);
  assert.ok(wh.every((e) => e.checked));                // closed automatically, nothing to review
  // no number seen: the fouling team's most often seen number, marked as a guess
  const r2 = Flow.infer({ ...result, shots: [shot(28.5, '왼쪽'), shot(42, '왼쪽', true)] }, S);
  const f2 = r2.events.find((e) => e.type === '파울');
  assert.strictEqual(f2.player, '28'); assert.ok(f2.playerGuess);
});

test('a turnover gets the number of the rebounder who started that possession, else the team\'s most often seen number', () => {
  const ev = [
    { time: 10, end: 11, team: '빨강', side: '왼쪽', type: '야투', detail: '2점', result: '실패', source: '자동' },
    { time: 11.3, team: '남색', type: '리바운드', detail: '수비', source: '수동', player: '28' },
    { time: 30, end: 31, team: '빨강', side: '왼쪽', type: '야투', detail: '2점', result: '실패', source: '자동' },   // 남색 never shot: turnover
  ];
  const out = Flow.derive(ev, S, { mode: 'two', segs: [], mostSeen: { 빨강: '9', 남색: '44' } });
  const to = out.find((e) => e.type === '턴오버');
  assert.ok(to); assert.strictEqual(to.team, '남색'); assert.strictEqual(to.player, '28'); assert.ok(to.playerGuess);
});
