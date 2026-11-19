/* Rim snap on made-up pictures. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { snapRim } = require('../rimsnap.js');

// a grey 200 x 120 picture; fill(x0, y0, x1, y1, rgb) paints a box
function picture() {
  const W = 200, H = 120, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) d.set([170, 172, 178, 255], i * 4);
  const fill = (x0, y0, x1, y1, rgb) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([...rgb, 255], (y * W + x) * 4); };
  return { W, H, d, fill };
}

test('a click beside the rim moves to the rim centre; a dull far rim with a bright near end is found', () => {
  const p = picture();
  p.fill(90, 60, 111, 60, [110, 70, 70]);        // the rim's thin part: dull red, 22 px wide at y = 60
  p.fill(104, 58, 112, 63, [190, 40, 30]);       // its near end: bright red
  p.fill(60, 70, 84, 74, [120, 85, 70]);         // a brown wall below-left (weak red, should not win)
  for (const [dx, dy] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12], [8, 8]]) {
    const s = snapRim(p.d, p.W, p.H, 100 + dx, 60 + dy);
    assert.ok(s.snapped, `snapped from ${dx},${dy}`);
    assert.ok(Math.abs(s.x - 101) <= 2 && Math.abs(s.y - 60) <= 2, `from ${dx},${dy}: got ${s.x},${s.y}`);
  }
});

test('nothing rim-like near the click: the click is kept', () => {
  const p = picture();
  p.fill(20, 20, 40, 22, [200, 40, 30]);          // a red bar far away
  const s = snapRim(p.d, p.W, p.H, 150, 90);
  assert.deepStrictEqual([s.x, s.y, s.snapped], [150, 90, false]);
});
