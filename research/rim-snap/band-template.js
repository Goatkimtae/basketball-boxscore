/* Rebuild the band gym's hoop pictures from snapped rims and compare the engine's shots with the hand labels
   of the foul video (hoopstat/tests/data/foul-video-1-labels.json: 29 clear attempts).
     node research/rim-snap/band-template.js make      -> _workspace/snap/band-snap.json
     node research/rim-snap/band-template.js score <engine result.json> [...] */
'use strict';
const H = require('../../harness/lib');
const R = require('../../hoopstat/rimsnap.js');
const TW = 84, TH = 70, RIM_DY = 0.3;
const a = H.args();
if (a._[0] === 'make') {
  const v = H.video('band-foul'), out = {};
  for (const [side, t, x, y] of [['왼쪽', 54.6, 361, 151], ['오른쪽', 63.7, 474, 153]]) {
    const g = H.grab(v.path, { t0: t, frames: 1, w: 768 }), d = g.frames[0];
    const s = R.snapRim(d, g.W, g.H, x, y);
    const x0 = Math.round(Math.min(Math.max(s.x - TW / 2, 0), g.W - TW)), y0 = Math.round(Math.min(Math.max(s.y - RIM_DY * TH - TH / 2, 0), g.H - TH));
    const data = [];
    for (let yy = y0; yy < y0 + TH; yy++) for (let xx = x0; xx < x0 + TW; xx++) { const j = (yy * g.W + xx) * 4; data.push((d[j] * 4899 + d[j + 1] * 9617 + d[j + 2] * 1868 + 8192) >> 14); }
    out[side] = { w: TW, h: TH, data };
    console.log(side, 'snap', JSON.stringify(s));
  }
  console.log('->', H.save(H.out('snap', 'band-snap.json'), out));
} else {
  const lab = H.load('hoopstat/tests/data/foul-video-1-labels.json');
  const clear = lab.shots_clear.map(([t, s]) => ({ t, side: s === 'L' ? '왼쪽' : '오른쪽' })), unsure = lab.shots_unsure.map(([t, s]) => ({ t, side: s === 'L' ? '왼쪽' : '오른쪽' }));
  for (const f of a._.slice(1)) {
    const shots = H.load(f).shots;
    const hit = (l) => shots.some((s) => s.side === l.side && Math.abs(s.start - l.t) < 1.5);
    const found = clear.filter(hit).length;
    const falseShots = shots.filter((s) => !clear.some((l) => l.side === s.side && Math.abs(s.start - l.t) < 1.5) && !unsure.some((l) => l.side === s.side && Math.abs(s.start - l.t) < 1.5)).length;
    console.log(`${f}: shots ${shots.length}, clear attempts found ${found}/${clear.length}, not a labelled attempt ${falseShots}`);
  }
}
