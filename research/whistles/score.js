/* Score the two-camera whistle rule (Flow.stoppedTwo) against the hand labels (research/whistles/data/labels-*.json).
     node research/whistles/score.js [--grid]   (needs _workspace/engine/hvn-*.json and _workspace/whistles/merged.json) */
'use strict';
const fs = require('fs'), path = require('path');
const H = require('../../harness/lib');
const Flow = require('../../hoopstat/flow.js');
const dir = path.join(H.ROOT, 'research/whistles/data');
const labels = fs.readdirSync(dir).filter((f) => /^labels-.*\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const W = H.load('_workspace/whistles/merged.json');
const slots = [Flow.slotMotion(H.load('_workspace/engine/hvn-left.json').track, 0), Flow.slotMotion(H.load('_workspace/engine/hvn-right.json').track, 1.12)];
const lab = (t) => labels.find((l) => Math.abs(l.t - t) < 1);
function score(P) {
  Object.assign(Flow.P, P);
  const r = { stopRight: 0, stopMissed: 0, falseStop: 0, contRight: 0, unclear: 0, fouls: 0, foulsFound: 0, rows: [] };
  for (const w of W) {
    const l = lab(w.t), call = w.dur >= Flow.P.MARK_DUR && Flow.stoppedTwo(slots, w);
    r.rows.push(`${w.t.toFixed(1).padStart(6)} ${(w.f / 1000).toFixed(1)}kHz ${call ? 'STOP' : '----'}  label ${l ? `${l.verdict}/${l.reason || ''}/${l.confidence}` : 'none'}`);
    if (!l || l.verdict === 'unclear') { r.unclear++; continue; }
    if (l.verdict === 'stopped') { if (call) r.stopRight++; else r.stopMissed++; } else if (call) r.falseStop++; else r.contRight++;
    if (l.reason === 'foul') { r.fouls++; if (call) r.foulsFound++; }
  }
  return r;
}
const a = H.args();
const base = { ...Flow.P };
const r = score({});
console.log(r.rows.join('\n'));
console.log(`current (STOP2_5 ${base.STOP2_5}, STOP2_12 ${base.STOP2_12}, STOP2_MIN ${base.STOP2_MIN}): stops found ${r.stopRight}/${r.stopRight + r.stopMissed}, false stops ${r.falseStop}/${r.falseStop + r.contRight}, fouls found ${r.foulsFound}/${r.fouls}, unclear ${r.unclear}`);
if (a.grid) {
  const out = [];
  for (const s5 of [0.4, 0.5, 0.6, 0.7, 0.8]) for (const s12 of [0.6, 0.8, 1.0, 1.2]) for (const mn of [0.3, 0.5, 0.8, 1.2]) {
    const q = score({ STOP2_5: s5, STOP2_12: s12, STOP2_MIN: mn });
    out.push({ s5, s12, mn, found: q.stopRight, of: q.stopRight + q.stopMissed, fals: q.falseStop, cont: q.falseStop + q.contRight, fouls: q.foulsFound, foulsOf: q.fouls });
  }
  out.sort((x, y) => (y.found - y.fals * 1.5) - (x.found - x.fals * 1.5));
  for (const o of out.slice(0, 10)) console.log(`STOP2_5 ${o.s5} STOP2_12 ${o.s12} MIN ${o.mn}: stops ${o.found}/${o.of}, false ${o.fals}/${o.cont}, fouls ${o.fouls}/${o.foulsOf}`);
  Object.assign(Flow.P, base);
}
