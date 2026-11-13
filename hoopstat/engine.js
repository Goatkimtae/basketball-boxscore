/* HoopStat analysis engine (runs inside a Web Worker; needs the global `cv` from OpenCV.js).
   Same method as the Windows prototype:
   hoop tracking (template match) -> ball = orange + moving near the hoop, camera motion removed
   by aligning on the hoop -> shot candidates -> made if the ball drops through the rim centre. */
'use strict';

const HS = {
  PROC_W: 768,
  TW: 84, TH: 70,             // hoop template size at PROC_W
  RIM_DY: 0.30,               // rim centre sits this far (x TH) below the template centre
  SCALES: [0.8, 0.9, 1.0, 1.1, 1.25],
  HOOP_THR: 0.65,
  SEARCH_TOP: 0.65,
  // ball hue is red-orange on compressed phone video; the range wraps through red
  BALL_RANGES: [[[0, 100, 70], [22, 255, 255]], [[176, 100, 70], [180, 255, 255]]],
  BALL_AREA: [12, 160],
  BALL_BLUR: 0,               // Gaussian blur (px) before the colour test; 0 = off
  SIDES: ['왼쪽', '오른쪽'],
};

/* ---------------------------------------------------------------- hoops */
class HoopTracker {
  constructor(templates) {            // {왼쪽: {w, h, data: Uint8Array}, 오른쪽: {...}}
    this.scaled = {};
    for (const side of HS.SIDES) {
      const t = templates[side];
      if (!t) continue;
      const base = new cv.Mat(t.h, t.w, cv.CV_8UC1);
      base.data.set(t.data);
      this.scaled[side] = HS.SCALES.map((sc) => {
        const m = new cv.Mat();
        cv.resize(base, m, new cv.Size(0, 0), sc, sc, cv.INTER_LINEAR);
        return { sc, m };
      });
      base.delete();
    }
    this.res = new cv.Mat();
  }

  /** gray: CV_8UC1 top part of the frame. Returns {L:[score,x,y,scale], R:[...]} */
  match(gray) {
    const out = {};
    for (const side of HS.SIDES) {
      let best = [-1, 0, 0, 1];
      for (const { sc, m } of this.scaled[side] || []) {
        if (m.rows >= gray.rows || m.cols >= gray.cols) continue;
        cv.matchTemplate(gray, m, this.res, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(this.res);
        if (mm.maxVal > best[0]) best = [mm.maxVal, mm.maxLoc.x + m.cols / 2, mm.maxLoc.y + m.rows / 2, sc];
      }
      out[side] = best;
    }
    return out;
  }

  delete() {
    for (const side in this.scaled) for (const { m } of this.scaled[side]) m.delete();
    this.res.delete();
  }
}

/** hoop in view for a resolved sample: [side, x, y, scale] or null (higher score wins) */
function hoopFromSample(s) {
  if (!s) return null;
  const cand = HS.SIDES.filter((side) => s[side] && s[side][0] >= HS.HOOP_THR);
  if (!cand.length) return null;
  const side = cand.reduce((a, b) => (s[b][0] > s[a][0] ? b : a));
  const v = s[side];
  return [side, v[1], v[2], v[3]];
}

function visibility(samples) {
  const out = { 왼쪽: 0, 오른쪽: 0, 없음: 0 };
  for (const s of samples) {
    const l = s['왼쪽'][0] >= HS.HOOP_THR, r = s['오른쪽'][0] >= HS.HOOP_THR;
    out[l && (!r || s['왼쪽'][0] >= s['오른쪽'][0]) ? '왼쪽' : r ? '오른쪽' : '없음'] += 1;
  }
  const n = Math.max(1, samples.length);
  for (const k in out) out[k] /= n;
  return out;
}

/* ---------------------------------------------------------------- ball */
class BallDetector {
  constructor(params = {}) {
    this.blur = params.blur ?? HS.BALL_BLUR;
    this.ranges = params.ranges ?? HS.BALL_RANGES;
    this.k5 = cv.Mat.ones(5, 5, cv.CV_8U);
    this.k2 = cv.Mat.ones(2, 2, cv.CV_8U);
    this.prevAligned = new cv.Mat();
    this.rgb = new cv.Mat(); this.hsv = new cv.Mat();
    this.g1 = new cv.Mat(); this.g2 = new cv.Mat(); this.diff = new cv.Mat();
    this.moving = new cv.Mat(); this.mask = new cv.Mat(); this.opened = new cv.Mat();
    this.labels = new cv.Mat(); this.stats = new cv.Mat(); this.cents = new cv.Mat();
  }

  /** cur, prev: RGBA Mats (prev = 2 frames earlier). hp, php: [side,x,y,scale]. Returns detections. */
  detect(t, cur, prev, hp, php) {
    const [side, hx, hy, hs] = hp;
    const w = HS.TW * hs, hh = HS.TH * hs, rimY = hy + HS.RIM_DY * hh;
    const W = cur.cols, H = cur.rows;
    const x0 = Math.max(0, Math.trunc(hx - 2.2 * w)), x1 = Math.min(W, Math.trunc(hx + 2.2 * w));
    const y0 = 0, y1 = Math.min(H, Math.trunc(rimY + 1.4 * hh));
    if (x1 - x0 < 8 || y1 - y0 < 8) return [];
    const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, hx - php[1], 0, 1, hy - php[2]]);
    cv.warpAffine(prev, this.prevAligned, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    M.delete();
    const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
    const c = cur.roi(rect), p = this.prevAligned.roi(rect);
    cv.cvtColor(c, this.rgb, cv.COLOR_RGBA2RGB);
    if (this.blur) cv.GaussianBlur(this.rgb, this.rgb, new cv.Size(this.blur, this.blur), 0, 0, cv.BORDER_DEFAULT);
    cv.cvtColor(this.rgb, this.hsv, cv.COLOR_RGB2HSV);
    cv.cvtColor(c, this.g1, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(p, this.g2, cv.COLOR_RGBA2GRAY);
    c.delete(); p.delete();
    cv.absdiff(this.g1, this.g2, this.diff);
    cv.threshold(this.diff, this.diff, 20, 255, cv.THRESH_BINARY);
    cv.dilate(this.diff, this.moving, this.k5, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    // orange AND moving
    const hsv = this.hsv.data, mov = this.moving.data, n = rect.width * rect.height;
    if (this.mask.rows !== rect.height || this.mask.cols !== rect.width) {
      this.mask.delete(); this.mask = new cv.Mat(rect.height, rect.width, cv.CV_8UC1);
    }
    const mk = this.mask.data;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      let on = 0;
      if (mov[i]) {
        const h = hsv[j], s = hsv[j + 1], v = hsv[j + 2];
        for (const [lo, hi] of this.ranges) {
          if (h >= lo[0] && h <= hi[0] && s >= lo[1] && s <= hi[1] && v >= lo[2] && v <= hi[2]) { on = 255; break; }
        }
      }
      mk[i] = on;
    }
    cv.morphologyEx(this.mask, this.opened, cv.MORPH_OPEN, this.k2, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const nl = cv.connectedComponentsWithStats(this.opened, this.labels, this.stats, this.cents, 8, cv.CV_32S);
    const st = this.stats.data32S, ce = this.cents.data64F, out = [];
    for (let k = 1; k < nl; k++) {
      const bw = st[k * 5 + 2], bh = st[k * 5 + 3], area = st[k * 5 + 4];
      if (area < HS.BALL_AREA[0] || area > HS.BALL_AREA[1]) continue;
      const ar = bw / Math.max(bh, 1);
      if (ar < 0.5 || ar > 2.0) continue;
      const fill = area / (bw * bh);
      if (fill < 0.45) continue;
      out.push({ t: Math.round(t * 1000) / 1000, side, fill: Math.round(fill * 100) / 100, bx: x0 + ce[k * 2], by: y0 + ce[k * 2 + 1],
        bw, hx, hy, rim_y: rimY, w, hh });
    }
    return out;
  }

  delete() {
    for (const m of [this.k5, this.k2, this.prevAligned, this.rgb, this.hsv, this.g1, this.g2, this.diff, this.moving, this.mask,
      this.opened, this.labels, this.stats, this.cents]) m.delete();
  }
}

/* Keep detections that form a moving chain over consecutive frames. Decoder colour noise (jersey
   edges, the red rim) appears as isolated or static blobs; a ball in flight moves smoothly. */
function trackFilter(dets, opt = {}) {
  const maxGap = opt.maxGap ?? 0.12, stepPx = opt.stepPx ?? 20, minLen = opt.minLen ?? 4, minMove = opt.minMove ?? 10;
  const ds = [...dets].sort((a, b) => a.t - b.t);
  const byT = new Map();
  for (const d of ds) { if (!byT.has(d.t)) byT.set(d.t, []); byT.get(d.t).push(d); }
  const times = [...byT.keys()].sort((a, b) => a - b);
  const prev = new Map(), used = new Set();
  times.forEach((t, ti) => {
    const cands = [];
    for (let k = Math.max(0, ti - 4); k < ti; k++) {
      const t2 = times[k];
      if (t - t2 > maxGap) continue;
      const frames = Math.max(1, Math.round((t - t2) * 30));
      for (const a of byT.get(t2)) for (const b of byT.get(t)) {
        if (a.side !== b.side) continue;
        const dist = Math.hypot(a.bx - b.bx, a.by - b.by);
        if (dist <= stepPx * frames) cands.push([dist / frames, a, b]);
      }
    }
    cands.sort((x, y) => x[0] - y[0]);
    const takenA = new Set(), takenB = new Set();
    for (const [, a, b] of cands) {
      if (takenA.has(a) || takenB.has(b) || used.has(a)) continue;
      prev.set(b, a); takenA.add(a); takenB.add(b); used.add(a);
    }
  });
  const keep = [];
  for (const h of ds) {
    if (used.has(h)) continue;                 // not a chain end
    const chain = [];
    for (let d = h; d; d = prev.get(d)) chain.push(d);
    if (chain.length < minLen) continue;
    const xs = chain.map((c) => c.bx), ys = chain.map((c) => c.by);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < minMove) continue;
    keep.push(...chain);
  }
  return keep;
}

/* ---------------------------------------------------------------- shots */
function groupShots(dets, opt = {}) {
  const gap = opt.gap ?? 0.7, split = opt.split ?? 20, mergeGap = opt.mergeGap ?? 0.5;
  const minFrames = opt.minFrames ?? 4, maxDx = opt.maxDx ?? 1.0;
  const z = new Map();
  for (const d of dets) {
    if (d.by < d.rim_y + 0.15 * d.hh && Math.abs(d.bx - d.hx) <= 1.6 * d.w) {
      const o = z.get(d.t);
      if (!o || d.fill > o.fill) z.set(d.t, d);
    }
  }
  const pts = [...z.values()].sort((a, b) => a.t - b.t);
  const groups = [];
  for (const d of pts) {
    const g = groups[groups.length - 1];
    if (g && g[g.length - 1].side === d.side && d.t - g[g.length - 1].t <= gap) g.push(d); else groups.push([d]);
  }
  const events = [];
  for (const g of groups) {
    let cur = [g[0]], apex = g[0].by - g[0].rim_y, fell = false, bottom = null;
    for (const d of g.slice(1)) {
      const y = d.by - d.rim_y;
      if (!fell) {
        apex = Math.min(apex, y);
        if (y - apex >= split) { fell = true; bottom = y; }
      } else if (y > bottom) {
        bottom = y;
      } else if (bottom - y >= split) {
        events.push(cur); cur = []; apex = y; fell = false;
      }
      cur.push(d);
    }
    events.push(cur);
  }
  const merged = [];
  for (const e of events.filter((x) => x.length)) {
    const prev = merged[merged.length - 1], first = e[0];
    if (prev && prev[prev.length - 1].side === first.side && first.t - prev[prev.length - 1].t <= mergeGap
      && Math.abs(first.bx - first.hx) <= 0.6 * first.w && Math.abs(first.by - first.rim_y) <= 0.8 * first.hh) prev.push(...e);
    else merged.push([...e]);
  }
  const out = [];
  for (const e of merged) {
    const minDx = Math.min(...e.map((d) => Math.abs(d.bx - d.hx) / d.w));
    if (e.length < minFrames || minDx > maxDx) continue;
    out.push({ start: e[0].t, end: e[e.length - 1].t, side: e[0].side, frames: e.length, made: false, made_t: null, confidence: '낮음' });
  }
  return out;
}

function judgeMade(shots, dets, windowSec = 2.5) {
  const bySide = {};
  for (const s of HS.SIDES) bySide[s] = dets.filter((d) => d.side === s).sort((a, b) => a.t - b.t);
  shots.forEach((sh, i) => {
    const next = i + 1 < shots.length && shots[i + 1].side === sh.side ? shots[i + 1].start : Infinity;
    const tEnd = Math.min(sh.end + windowSec, next + 0.2);
    const ds = bySide[sh.side].filter((d) => d.t >= sh.start - 0.1 && d.t <= tEnd);
    const above = ds.filter((d) => d.by < d.rim_y - 0.05 * d.hh && Math.abs(d.bx - d.hx) <= 0.35 * d.w);
    const below = ds.filter((d) => d.by >= d.rim_y + 0.08 * d.hh && d.by <= d.rim_y + 1.1 * d.hh && Math.abs(d.bx - d.hx) <= 0.22 * d.w);
    const hit = below.find((b) => above.some((a) => b.t - a.t > 0 && b.t - a.t <= 0.6)) || null;
    sh.made = !!hit;
    sh.made_t = hit ? hit.t : null;
    sh.confidence = hit && below.filter((b) => Math.abs(b.t - hit.t) <= 0.3).length >= 2 ? '보통' : '낮음';
  });
  return shots;
}

/* ---------------------------------------------------------------- streaming pipeline
   Frames arrive one by one. Hoops are matched on every 2nd frame; a frame's hoop is the nearest
   matched frame in time, so odd frames wait for the next even one. Ball detection compares a frame
   with the frame 2 earlier. */
class Analyzer {
  constructor(templates, variants) {
    this.tracker = new HoopTracker(templates);
    this.variants = (variants && variants.length ? variants : [{}]).map((p) => ({ params: p, ball: new BallDetector(p), dets: [] }));
    this.gray = new cv.Mat();
    this.samples = [];          // {i, t, 왼쪽:[..], 오른쪽:[..]}
    this.frames = new Map();    // i -> {t, mat, hp}
    this.next = 0;              // next frame index waiting for ball detection
    this.last = -1;
  }

  /** rgba: cv.Mat (RGBA, PROC_W wide). Ownership passes to the analyzer. */
  push(t, rgba) {
    const i = ++this.last;
    this.frames.set(i, { t, mat: rgba, hp: undefined });
    if (i % 2 === 0) {
      cv.cvtColor(rgba, this.gray, cv.COLOR_RGBA2GRAY);
      const top = Math.trunc(rgba.rows * HS.SEARCH_TOP);
      const roi = this.gray.roi(new cv.Rect(0, 0, rgba.cols, top));
      const m = this.tracker.match(roi);
      roi.delete();
      this.samples.push({ i, t, ...m });
    }
    this._drain(false);
  }

  finish() {
    this._drain(true);
    for (const f of this.frames.values()) f.mat.delete();
    this.frames.clear();
    this.tracker.delete(); this.gray.delete();
    const results = this.variants.map((v) => {
      v.ball.delete();
      const kept = trackFilter(v.dets);
      return { params: v.params, shots: judgeMade(groupShots(kept), kept), ballFrames: kept.length, dets: this.debug ? v.dets : undefined };
    });
    const main = results[0];
    return { shots: main.shots, ballFrames: main.ballFrames, visibility: visibility(this.samples), frames: this.last + 1,
      variants: results.length > 1 || this.debug ? results : undefined, samples: this.debug ? this.samples : undefined };
  }

  _sampleFor(j, ended) {
    const f = this.frames.get(j);
    const s = this.samples;
    // samples are sorted by i; candidates are the matched frames right before/after j
    let lo = 0, hi = s.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].i <= j) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const before = k >= 0 ? s[k] : null, after = k + 1 < s.length ? s[k + 1] : null;
    if (before && before.i === j) return before;
    if (!after && !ended) return undefined;                 // wait for the next matched frame
    if (!before) return after;
    if (!after) return before;
    return Math.abs(after.t - f.t) < Math.abs(before.t - f.t) ? after : before;   // tie -> earlier, like argmin
  }

  _drain(ended) {
    while (this.next <= this.last) {
      const j = this.next, f = this.frames.get(j);
      const s = this._sampleFor(j, ended);
      if (s === undefined) break;
      f.hp = hoopFromSample(s);
      const p = this.frames.get(j - 2);
      if (f.hp && p && p.hp && p.hp[0] === f.hp[0]) {
        for (const v of this.variants) for (const d of v.ball.detect(f.t, f.mat, p.mat, f.hp, p.hp)) v.dets.push(d);
      }
      const old = this.frames.get(j - 3);
      if (old) { old.mat.delete(); this.frames.delete(j - 3); }
      this.next++;
    }
  }
}

if (typeof self !== 'undefined') Object.assign(self, { HS, HoopTracker, BallDetector, Analyzer, trackFilter, groupShots, judgeMade, hoopFromSample, visibility });
if (typeof module !== 'undefined') module.exports = { HS, HoopTracker, BallDetector, Analyzer, trackFilter, groupShots, judgeMade, hoopFromSample, visibility };
