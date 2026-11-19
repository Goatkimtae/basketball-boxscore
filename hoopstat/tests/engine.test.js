/* One fixed camera showing both hoops: shots of the two hoops' analyses joined. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

test('both hoops in one picture: the two analyses are joined, a shot seen at both hoops at once counts once', () => {
  const sh = (start, side, frames = 20) => ({ start, end: start + 1, side, frames });
  const { shots, dropped } = E.dedupeShots([sh(10, '왼쪽'), sh(50, '왼쪽', 30)], [sh(30, '오른쪽'), sh(50.4, '오른쪽', 8)]);
  assert.deepStrictEqual(shots.map((s) => [s.start, s.side]), [[10, '왼쪽'], [30, '오른쪽'], [50, '왼쪽']]);
  assert.strictEqual(dropped.length, 1);
});

test('one camera showing both hoops is worked out like two fixed cameras (both hoops covered)', () => {
  const Flow = require('../flow.js');
  const shot = (start, side, made = false) => ({ start, end: start + 1, side, frames: 20, made, made_t: made ? start + 0.4 : null, confidence: '보통' });
  const track = Array.from({ length: 900 }, (_, i) => [i / 10, 1, 300, 40]);
  const r = Flow.infer({ shots: [shot(10, '왼쪽'), shot(30, '오른쪽', true), shot(50, '왼쪽', true)], track, both: true }, { team_left: '흰색', team_right: '남색' });
  assert.strictEqual(r.ctx.mode, 'two');
  assert.deepStrictEqual(r.events.filter((e) => e.type === '야투').map((e) => e.team), ['흰색', '남색', '흰색']);
  assert.ok(r.events.some((e) => e.type === '리바운드'));
});
