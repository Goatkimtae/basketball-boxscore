/* Hoop tracking with the local search: same answers as searching the whole picture. Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

let ready = null;
function load() {
  if (!ready) {
    ready = (async () => {
      let cv = require('../vendor/opencv.js');
      if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
      global.cv = cv;
      return require('../engine.js');
    })();
  }
  return ready;
}

// repeatable noise
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const W = 768, H = 244, TW = 84, TH = 70;
function template() {
  const r = rng(7), data = new Uint8Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) data[y * TW + x] = ((x >> 3) + (y >> 3)) % 2 ? 200 + r() * 40 : 30 + r() * 40;
  return { w: TW, h: TH, data };
}
/** a grey wall with the hoop picture at (x, y) (its top-left corner), or without it when x is null */
function frame(tpl, x, y, seed) {
  const r = rng(seed), m = new cv.Mat(H, W, cv.CV_8UC1), d = m.data;
  for (let i = 0; i < d.length; i++) d[i] = 110 + r() * 30;
  if (x != null) for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) d[(y + j) * W + x + i] = tpl.data[j * TW + i];
  return m;
}

test('a hoop that drifts is followed by the local search exactly as by the full search', async () => {
  const E = await load(), tpl = template();
  const fast = new E.HoopTracker({ 왼쪽: tpl }), full = new E.HoopTracker({ 왼쪽: tpl });
  for (let k = 0; k < 40; k++) {
    const x = 100 + k * 6, y = 60 + Math.round(8 * Math.sin(k / 5));       // 6 px per sample to the right, bobbing
    const m = frame(tpl, x, y, k + 1);
    const a = fast.match(m)['왼쪽'], b = full._full(m, '왼쪽');
    m.delete();
    assert.ok(a[0] >= E.HS.HOOP_THR, `sample ${k}: hoop lost (score ${a[0]})`);
    assert.deepStrictEqual([a[1], a[2], a[3]], [b[1], b[2], b[3]], `sample ${k}`);
    assert.deepStrictEqual([a[1], a[2]], [x + TW / 2, y + TH / 2]);
  }
  fast.delete(); full.delete();
});

test('a hoop that leaves the picture is found again at once while it was seen a moment ago, and within a few samples later', async () => {
  const E = await load(), tpl = template();
  const tr = new E.HoopTracker({ 왼쪽: tpl });
  const seen = (m) => { const v = tr.match(m)['왼쪽']; m.delete(); return v[0] >= E.HS.HOOP_THR; };
  for (let k = 0; k < 5; k++) assert.ok(seen(frame(tpl, 300, 80, k + 1)));
  for (let k = 0; k < 3; k++) assert.ok(!seen(frame(tpl, null, 0, 10 + k)), 'no hoop in the picture');
  assert.ok(seen(frame(tpl, 520, 40, 20)), 'back after 3 samples, somewhere else: found on the first sample');
  for (let k = 0; k < 5; k++) assert.ok(seen(frame(tpl, 520, 40, 30 + k)));
  for (let k = 0; k < 40; k++) assert.ok(!seen(frame(tpl, null, 0, 40 + k)), 'gone for a long time');
  let found = -1;
  for (let k = 0; k < E.HS.FULL_EVERY && found < 0; k++) if (seen(frame(tpl, 150, 100, 90 + k))) found = k;
  assert.ok(found >= 0, `found again within ${E.HS.FULL_EVERY} samples`);
  tr.delete();
});

test('a jump of the hoop beyond the local window (a cut in the video) falls back to the full search', async () => {
  const E = await load(), tpl = template();
  const tr = new E.HoopTracker({ 왼쪽: tpl });
  for (let k = 0; k < 4; k++) { const m = frame(tpl, 100, 60, k + 1); tr.match(m); m.delete(); }
  const m = frame(tpl, 600, 150, 9), v = tr.match(m)['왼쪽'];
  m.delete();
  assert.deepStrictEqual([v[1], v[2]], [600 + TW / 2, 150 + TH / 2]);
  tr.delete();
});
