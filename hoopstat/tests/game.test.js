/* Two fixed cameras, the quick-review edits, the made rule and the sound sync. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Flow = require('../flow.js');
const Stats = require('../stats.js');
const Sync = require('../sync.js');
const E = require('../engine.js');

const S = { team_left: 'H', team_right: 'N', cam_mode: 'two' };
const shot = (start, side, made = false, cam = side === '왼쪽' ? 'A' : 'B') => ({ start, end: start + 1, side, frames: 20, made, made_t: made ? start + 0.5 : null, confidence: '보통', cam });
const cams = () => [{ id: 'A', side: '왼쪽', track: [], offset: 0 }, { id: 'B', side: '오른쪽', track: [], offset: 1.1 }];
const brief = (ev) => ev.map((e) => `${e.time}|${e.team}|${e.type}|${e.detail}|${e.result}`);
const only = (ev, type) => ev.filter((e) => e.type === type);

test('two fixed cameras: rebounds from the order of shots, each shot keeps its camera', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(14, '왼쪽'), shot(30, '오른쪽', true), shot(50, '왼쪽')], cams: cams(), whistles: [] }, S);
  assert.strictEqual(r.summary.mode, 'two');
  assert.deepStrictEqual(brief(r.events), [
    '10|H|야투|2점|실패', '11.3|H|리바운드|공격|', '14|H|야투|2점|실패', '15.3|N|리바운드|수비|', '30|N|야투|2점|성공', '50|H|야투|2점|실패', '51.3|N|리바운드|수비|']);
  assert.deepStrictEqual(only(r.events, '야투').map((e) => e.cam), ['A', 'A', 'B', 'A']);
});

test('two fixed cameras: same team again after more than 10 s = defensive rebound, then a guessed turnover', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(40, '왼쪽')], cams: cams(), whistles: [] }, S);
  assert.deepStrictEqual(brief(r.events), ['10|H|야투|2점|실패', '11.3|N|리바운드|수비|', '35|N|턴오버||', '40|H|야투|2점|실패', '41.3|N|리바운드|수비|']);
});

test('fixed cameras: whistle-like sounds are listed for review, never counted as fouls by the app', () => {
  const r = Flow.infer({ shots: [shot(10, '왼쪽')], cams: cams(), whistles: [{ t: 20, dur: 1.2, f: 3300 }, { t: 30, dur: 0.3, f: 2200 }] }, S);
  assert.deepStrictEqual(only(r.events, '휘슬').map((e) => e.time), [20]);
  assert.strictEqual(r.summary.pf, 0);
  const box = Object.fromEntries(Stats.boxScore(r.events, ['H', 'N']).teams);
  assert.strictEqual(box.H.PF + box.N.PF, 0);
});

test('quick review: changing a made shot to missed adds its rebound; deleting a shot removes its rebound', () => {
  const ctx = { mode: 'two', segs: [] };
  let ev = Flow.infer({ shots: [shot(10, '왼쪽', true), shot(30, '오른쪽'), shot(50, '왼쪽')], cams: cams(), whistles: [] }, S).events;
  assert.strictEqual(only(ev, '리바운드').length, 2);
  ev.find((e) => e.time === 10).result = '실패';                       // the user says it missed
  ev = Flow.derive(ev, S, ctx);
  assert.deepStrictEqual(only(ev, '리바운드').map((e) => [e.time, e.team, e.detail]), [[11.3, 'N', '수비'], [31.3, 'H', '수비'], [51.3, 'N', '수비']]);
  ev = Flow.derive(ev.filter((e) => e.time !== 30), S, ctx);           // "not a shot"
  assert.deepStrictEqual(brief(ev), ['10|H|야투|2점|실패', '11.3|N|리바운드|수비|', '45|N|턴오버||', '50|H|야투|2점|실패', '51.3|N|리바운드|수비|']);
});

test('quick review: jersey numbers on automatic rebounds survive a recalculation; a rebound the user typed stands', () => {
  const ctx = { mode: 'two', segs: [] };
  let ev = Flow.infer({ shots: [shot(10, '왼쪽'), shot(30, '오른쪽')], cams: cams(), whistles: [] }, S).events;
  only(ev, '리바운드')[0].player = '7';
  ev = Flow.derive(ev, S, ctx);
  assert.strictEqual(only(ev, '리바운드')[0].player, '7');
  // the user decides the first rebound was offensive
  ev = ev.filter((e) => !(e.type === '리바운드' && e.time < 20));
  ev.push({ time: 12, team: 'H', player: '9', type: '리바운드', detail: '공격', result: '', source: '수동', note: '' });
  ev = Flow.derive(ev, S, ctx);
  assert.deepStrictEqual(only(ev, '리바운드').map((e) => [e.time, e.team, e.detail, e.source]), [[12, 'H', '공격', '수동'], [31.3, 'H', '수비', '자동']]);
  assert.strictEqual(only(ev, '턴오버').length, 1, 'H kept the ball at 12 s but N shot at 30 s');
});

test('fouls and free throws entered by the user: no rebound after a fouled miss, no turnover before a free throw', () => {
  const ctx = { mode: 'two', segs: [] };
  const ev = Flow.derive([
    { time: 10, team: 'H', type: '야투', detail: '2점', result: '실패', source: '자동', side: '왼쪽' },
    { time: 11, team: 'N', type: '파울', detail: '슈팅파울', result: '', source: '수동' },
    { time: 25, team: 'H', type: '자유투', detail: '2점슛 파울', result: '성공', source: '수동' },
    { time: 40, team: 'N', type: '야투', detail: '2점', result: '성공', source: '자동', side: '오른쪽' },
    { time: 41, team: 'H', type: '파울', detail: '슈팅파울', result: '', source: '수동' },
    { time: 55, team: 'N', type: '자유투', detail: '앤드원', result: '실패', source: '수동' },
  ], S, ctx);
  assert.deepStrictEqual(only(ev, '리바운드').map((e) => [e.time, e.team]), [[56.3, 'H']], 'only the missed free throw is rebounded');
  assert.strictEqual(only(ev, '턴오버').length, 0);
  const box = Object.fromEntries(Stats.boxScore(ev, ['H', 'N']).teams);
  assert.deepStrictEqual([box.H.PTS, box.N.PTS, box.H.PF, box.N.PF], [2, 2, 1, 1]);
});

test('re-analysis keeps what the user confirmed on automatic shots (result, 3-point, number)', () => {
  const old = [{ time: 10, team: 'H', player: '9', type: '야투', detail: '3점', result: '성공', source: '자동', checked: true, confidence: '확인' },
    { time: 30, team: 'N', player: '', type: '야투', detail: '2점', result: '성공', source: '자동' }];
  const auto = [{ time: 10.3, team: 'H', player: '', type: '야투', detail: '2점', result: '실패', source: '자동', confidence: '낮음' },
    { time: 30.2, team: 'N', player: '', type: '야투', detail: '2점', result: '실패', source: '자동', confidence: '낮음' }];
  const m = Stats.mergeReanalysis(old, auto);
  assert.deepStrictEqual(m.map((e) => [e.time, e.player, e.detail, e.result, !!e.checked]), [[10.3, '9', '3점', '성공', true], [30.2, '', '2점', '실패', false]]);
});

/* ---- made / missed: the ball above the rim, then falling inside the net ---- */
// hoop at (500, 120) scale 1: rim y = 141; one rim width R = 22 px
const det = (t, x, y, bw = 10) => ({ t: Math.round(t * 1000) / 1000, side: '오른쪽', fill: 0.8, bx: x, by: y, bw, hx: 500, hy: 120, rim_y: 141, w: 84, hh: 70 });
function judge(dets) {
  const kept = E.trackFilter(dets.filter((d) => !E.onRim(d)));
  return E.judgeMade(E.groupShots(kept), kept);
}
const arcIn = (t0) => Array.from({ length: 10 }, (_, i) => det(t0 + i / 30, 470 + i * 3, 80 + i * 4));        // comes down toward the rim from the left

test('made: ball above the rim, then falling through the net', () => {
  const dets = [...arcIn(1), ...Array.from({ length: 5 }, (_, i) => det(1.4 + i / 30, 501, 154 + i * 7))];
  const sh = judge(dets);
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].made, true);
});

test('missed: the ball falls beside the rim (more than 0.45 rim widths off centre)', () => {
  const dets = [...arcIn(1), ...Array.from({ length: 5 }, (_, i) => det(1.4 + i / 30, 484, 154 + i * 7))];   // 16 px left of centre
  assert.strictEqual(judge(dets)[0].made, false);
});

test('missed: small blobs moving under the rim (the swaying net) are not the ball', () => {
  const dets = [...arcIn(1), ...Array.from({ length: 5 }, (_, i) => det(1.4 + i / 30, 501, 154 + i * 7, 4))];
  assert.strictEqual(judge(dets)[0].made, false);
});

test('missed: the ball goes up past the net on a lay-up and comes down outside', () => {
  const up = Array.from({ length: 6 }, (_, i) => det(1 + i / 30, 500, 180 - i * 9));                       // rising under the rim
  const over = Array.from({ length: 8 }, (_, i) => det(1.25 + i / 30, 505 + i * 6, 120 - i * 2));          // over the rim, away to the right
  assert.strictEqual(judge([...up, ...over])[0].made, false);
});

/* ---- lining up two recordings by sound ---- */
test('sound sync: finds how much later the second recording started', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = 100 * 120, base = new Float32Array(n + 500);
  for (let i = 0; i < base.length; i++) base[i] = -8 + rnd() * 0.3;
  for (let k = 0; k < 150; k++) { const p = Math.floor(rnd() * (base.length - 20)); for (let j = 0; j < 8; j++) base[p + j] += 4 * Math.exp(-j / 3); }   // claps
  const a = base.subarray(0, n), b = base.subarray(237, 237 + n);        // B started 2.37 s after A
  const noisy = Float32Array.from(b, (v) => v + rnd() * 0.3);
  const r = Sync.offset(a, noisy, 100);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.offset, 2.37);
  const r2 = Sync.offset(noisy, a, 100);
  assert.strictEqual(r2.offset, -2.37);
});

test('sound sync: unrelated sound is not trusted', () => {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const a = Float32Array.from({ length: 6000 }, () => rnd()), b = Float32Array.from({ length: 6000 }, () => rnd());
  assert.strictEqual(Sync.offset(a, b, 100).ok, false);
});
