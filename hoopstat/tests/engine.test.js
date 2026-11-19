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
