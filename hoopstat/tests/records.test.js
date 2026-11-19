/* What the user did to the record survives re-analysis and rebuilding. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Stats = require('../stats.js');
const Flow = require('../flow.js');

const S = { team_left: '흰색', team_right: '남색' };
const auto = (time, team, result, extra = {}) => ({ time, end: time + 1, team, type: '야투', detail: '2점', result, source: '자동', side: team === '흰색' ? '왼쪽' : '오른쪽', cam: team === '흰색' ? 'A' : 'B', ...extra });
const pts = (ev, team) => Stats.boxScore(ev, ['흰색', '남색']).teams.find(([t]) => t === team)[1].PTS;

test('an automatic 2-point shot changed by hand to a 3-pointer is not counted twice after re-analysis', () => {
  const first = Stats.mergeReanalysis([], [auto(10, '흰색', '성공')], 1);
  assert.ok(first[0].origin, 'an automatic record keeps where it came from');
  // the event dialog: the user makes it a 3-pointer (the record becomes manual, its origin stays)
  const edited = first.map((e) => ({ ...e, detail: '3점', source: '수동', edited: true, checked: true }));
  assert.strictEqual(pts(edited, '흰색'), 3);
  const again = Stats.mergeReanalysis(edited, [auto(10.1, '흰색', '성공')], 1);
  assert.strictEqual(again.filter((e) => e.type === '야투').length, 1);
  assert.strictEqual(pts(again, '흰색'), 3);
});

test('an automatic shot the user deleted does not come back with re-analysis', () => {
  const first = Stats.mergeReanalysis([], [auto(10, '흰색', '성공'), auto(30, '남색', '실패')], 1);
  const gone = first.find((e) => e.time === 30);
  const removed = [Stats.tombstone(gone)];
  const again = Stats.mergeReanalysis(first.filter((e) => e !== gone), [auto(10, '흰색', '성공'), auto(30.2, '남색', '실패')], 1, removed);
  assert.deepStrictEqual(again.map((e) => e.time), [10]);
});

test('an automatic rebound the user deleted is not made again when the record is rebuilt', () => {
  const shots = [{ ...auto(10, '흰색', '실패'), id: 's1' }, { ...auto(30, '남색', '성공'), id: 's2' }];
  const out = Flow.derive(shots, S, { mode: 'two', segs: [] });
  const reb = out.find((e) => e.type === '리바운드');
  assert.ok(reb && reb.of === 's1', 'a rebound knows the missed shot it follows');
  const removed = [Stats.tombstone(reb)];
  const again = Flow.derive(out.filter((e) => e !== reb), S, { mode: 'two', segs: [], removed });
  assert.ok(!again.some((e) => e.type === '리바운드'));
  // without that rebound nobody is known to have the ball: no made-up turnover either
  assert.ok(!again.some((e) => e.type === '턴오버'));
});

test('review state: a shot with a number read is still open while its result is not confirmed; states stay apart', () => {
  const read = { ...auto(10, '흰색', '성공'), player: '33', playerAuto: true, playerGuess: false };
  assert.deepStrictEqual(Stats.openItems(read), ['결과 미확인']);
  assert.deepStrictEqual(Stats.openItems({ ...read, checked: true }), []);
  const guessed = { ...read, playerGuess: true, checked: true };
  assert.deepStrictEqual(Stats.openItems(guessed), ['번호 추정']);
  assert.deepStrictEqual(Stats.openItems({ time: 5, type: '휘슬', source: '자동' }), ['휘슬 미판정']);
  assert.strictEqual(Stats.playerState(read), '읽음'); assert.strictEqual(Stats.playerState(guessed), '추정');
  assert.strictEqual(Stats.playerState({ player: '9' }), '사람'); assert.strictEqual(Stats.resultState(read), '자동(미확인)');
});

test('box score: guessed numbers can be left out of the players (the team keeps the points)', () => {
  const ev = [{ ...auto(10, '흰색', '성공'), player: '33', playerAuto: true, playerGuess: true }, { ...auto(20, '흰색', '성공'), player: '9', playerAuto: true }];
  const a = Stats.boxScore(ev, ['흰색', '남색'], { guess: false });
  assert.deepStrictEqual(a.players['흰색'].map(([p, st]) => [p, st.PTS]), [['9', 2], ['미상', 2]]);
  assert.strictEqual(a.teams[0][1].PTS, 4);
});

test('a kind set in the quick review (3-pointer) survives re-analysis', () => {
  const first = Stats.mergeReanalysis([], [auto(10, '흰색', '성공')], 1).map((e) => ({ ...e, detail: '3점', userKind: true }));
  const again = Stats.mergeReanalysis(first, [auto(10, '흰색', '성공')], 1);
  assert.strictEqual(again.length, 1); assert.strictEqual(again[0].detail, '3점');
});
