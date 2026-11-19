/* Free throws on two fixed cameras: for every game shot (after the practice split) the motion before it, and for
   every whistle the first shot 4-40 s later at any hoop. A free throw is taken while everyone stands on the lane.
     node research/whistles/ft.js        (needs _workspace/engine/hvn-*.json and _workspace/whistles/merged.json) */
'use strict';
const fs = require('fs'), path = require('path');
const H = require('../../harness/lib');
const Flow = require('../../hoopstat/flow.js');
const dir = path.join(H.ROOT, 'research/whistles/data');
const labels = fs.readdirSync(dir).filter((f) => /^labels-.*\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const OFF = 1.12;
const L = H.load('_workspace/engine/hvn-left.json'), R = H.load('_workspace/engine/hvn-right.json');
const cams = [{ shots: L.shots, track: L.track, offset: 0 }, { shots: R.shots, track: R.track, offset: OFF }];
const split = Flow.splitPractice(cams);
const slots = cams.map((c) => Flow.slotMotion(c.track, c.offset));
const shots = [];
split.forEach((s, i) => {
  for (const sh of s.game) shots.push({ t: sh.start + cams[i].offset, cam: i, side: sh.side, made: sh.made, ratio: sh.motionRatio, practice: false });
  for (const sh of s.practice) shots.push({ t: sh.start + cams[i].offset, cam: i, side: sh.side, made: sh.made, ratio: sh.motionRatio, practice: true });
});
shots.sort((a, b) => a.t - b.t);
const f2 = (x) => (x == null ? '  -  ' : x.toFixed(2).padStart(5));
for (const sh of shots) {
  const own = slots[sh.cam].mean(sh.t - 3, sh.t - 0.7), oth = slots[1 - sh.cam].mean(sh.t - 3, sh.t - 0.7);
  sh.own = own; sh.oth = oth;
}
console.log('shots: time cam side made practice ratio own(-3..-0.7) other');
for (const sh of shots) console.log(`${sh.t.toFixed(1).padStart(6)} ${'LR'[sh.cam]} ${sh.made ? 'made' : '----'} ${sh.practice ? 'PRACTICE' : '        '} ${f2(sh.ratio)} ${f2(sh.own)} ${f2(sh.oth)}`);
const W = H.load('_workspace/whistles/merged.json');
console.log('\nwhistles: time dur label -> shots 4-40 s later (time cam own)');
for (const w of W) {
  const l = labels.find((q) => Math.abs(q.t - w.t) < 1);
  const next = shots.filter((sh) => !sh.practice && sh.t > w.t + 4 && sh.t < w.t + 40).slice(0, 3);
  console.log(`${w.t.toFixed(1).padStart(6)} ${w.dur.toFixed(1)}s ${(l ? `${l.verdict}/${l.reason || ''}${l.during_dead_ball ? '/dead' : ''}` : 'none').padEnd(24)} -> ${next.map((sh) => `${sh.t.toFixed(1)}${'LR'[sh.cam]} ${f2(sh.own)}`).join(' | ')}`);
}
