/* One fixed camera showing both hoops, made up from the two-camera test game: the left half of the left camera and
   the right half of the right camera side by side (both hoops at their own scale), the left video started 1.12 s
   in so both show the same moment (time here = left camera time - 1.12 = right camera time).
     ffmpeg -ss 1.12 -i left.mp4 -i right.mp4 -filter_complex "[0:v]fps=30,crop=736:720:0:0[l];[1:v]fps=30,crop=640:720:640:0[r];[l][r]hstack=inputs=2[v]" -map "[v]" -map 0:a ... both.mp4
   This script cuts the gym-profile hoop pictures from it, the way the app does (rim found near the given points):
     node research/both-hoops/make.js <both.mp4> [--t 10] [--out harness/templates/both.json] */
'use strict';
const fs = require('fs');
const H = require('../../harness/lib');
const RimSnap = require('../../hoopstat/rimsnap.js');
const TW = 84, TH = 70, RIM_DY = 0.30, W = 768;
const a = H.args(), file = a._[0], t = Number(a.t || 10);
const { frames, H: h } = H.grab(file, { t0: t, frames: 1, w: W });
const rgba = frames[0];
// left rim (67,151) of the 1472 px left camera, right rim (623,169) of the 1280 px right camera, in this 1376 px picture
const guess = { 왼쪽: [((67 * 1472) / 768) * (W / 1376), ((151 * 1472) / 768) * (W / 1376)], 오른쪽: [(((623 * 1280) / 768) - 640 + 736) * (W / 1376), ((169 * 1280) / 768) * (W / 1376)] };
const out = {}, rims = {};
for (const [side, [gx, gy]] of Object.entries(guess)) {
  const r = RimSnap.snapRim(rgba, W, h, gx, gy);
  const x = r.x, y = r.y;
  rims[side] = { x, y, snapped: r.snapped, moved: r.moved };
  const x0 = Math.round(Math.min(Math.max(x - TW / 2, 0), W - TW)), y0 = Math.round(Math.min(Math.max(y - RIM_DY * TH - TH / 2, 0), h - TH));
  const data = [];
  for (let yy = y0; yy < y0 + TH; yy++) for (let xx = x0; xx < x0 + TW; xx++) { const j = (yy * W + xx) * 4; data.push((rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14); }
  out[side] = { w: TW, h: TH, data };
}
const dest = a.out || 'harness/templates/both.json';
fs.writeFileSync(H.rel(dest), JSON.stringify(out));
console.log(JSON.stringify(rims), '->', dest);
