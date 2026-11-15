/* HoopStat players stage: people (YOLOX-nano), followed over time (shirt colour + overlap), numbers read
   on their shirts (PP-OCRv4). Two jobs per video:
     shots  - for each shot, people near the ball are followed from 6 s before the moment the shooter holds
              the ball (the gather, found by the engine) to 1.5 s after it; the person holding the ball is the
              shooter; the numbers read on that person, nearest the gather, give the shooter's number.
     people - every few seconds, everybody's shirt colour and number: teams and their numbers come from these.
   Runs as a Web Worker (entry at the bottom; reads the file and decodes only the frames it needs) and in
   Node for tests. Needs globals `cv` (OpenCV.js) and `ort` (ONNX Runtime Web). Checked against the Python
   version in research/jersey-numbers/tracking on the 2026-11-14 two-camera game. */
'use strict';

const PL = {
  FPS: 10, BEFORE: 6.0, AFTER: 1.5,    // shot window around the gather, frames per second in it
  CROP_R: 10,                          // people are looked for within 10 rim widths of the gather, left and right
  TOP: 60 / 720,                       // ... below this part of the picture (as a share of its height)
  DET_SIZE: 416, DET_SCORE: 0.25, NMS_SCORE: 0.3, NMS_IOU: 0.5,
  KEEP_SCORE: 0.4, MIN_H: 40 / 720,    // a person: score above 0.4, taller than 40 px in a 720 px picture
  TRACK_GAP: 10,                       // a followed person not seen for 10 frames (1 s) is let go
  COLOUR_GATE: 30,                     // shirt colours further apart than this (Lab) are different people
  MATCH_MAX: 1.4,
  OCR_MIN_H: 60 / 720, OCR_H: 240,     // numbers are read on people at least 60 px tall; the shirt is enlarged to 240 px
  READ_CONF: 0.6, DECIDE_CONF: 0.8, RUN_MIN: 1.5,
  PEOPLE_EVERY: 4,                     // seconds between pictures for the teams and their numbers
  REC_BATCH: 6,
  // classes of the number reading model that are digits (index in its character list; 0 is "blank")
  DIGITS: { 26: '0', 93: '1', 25: '2', 94: '3', 632: '4', 631: '5', 933: '6', 29: '7', 27: '8', 1109: '9' },
};

/* ------------------------------------------------------------------ small helpers */
function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9);
}

/** Minimum-cost assignment of rows to columns (Hungarian method); returns [row, col] pairs. */
function hungarian(cost) {
  const n0 = cost.length, m0 = n0 ? cost[0].length : 0, n = Math.max(n0, m0);
  if (!n0 || !m0) return [];
  let big = 0;
  for (const r of cost) for (const v of r) big = Math.max(big, v);
  const a = (i, j) => (i < n0 && j < m0 ? cost[i][j] : big + 1);       // square it up with equal costs
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity), used = new Uint8Array(n + 1);
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = [];
  for (let j = 1; j <= n; j++) if (p[j] && p[j] <= n0 && j <= m0) out.push([p[j] - 1, j - 1]);
  return out.sort((x, y) => x[0] - y[0]);
}

/** shirt area of a person box (x0, y0, x1, y1): 15-55 % of the height, the middle 60 % of the width */
function torsoRect(box, W, H) {
  const [x0, y0, x1, y1] = box.map((v) => Math.trunc(v)), h = y1 - y0, w = x1 - x0;
  const ya = Math.max(0, y0 + Math.trunc(0.15 * h)), yb = Math.min(H, Math.max(1, y0 + Math.trunc(0.55 * h)));
  const xa = Math.max(0, x0 + Math.trunc(0.2 * w)), xb = Math.min(W, Math.max(1, x1 - Math.trunc(0.2 * w)));
  return yb > ya && xb > xa ? new cv.Rect(xa, ya, xb - xa, yb - ya) : null;
}

/** median shirt colour (Lab, 8 bit) and an HSV histogram (8 x 4 x 4, unit length) of the shirt area */
function shirtOf(rgba, box) {
  const r = torsoRect(box, rgba.cols, rgba.rows);
  if (!r) return { lab: null, hist: null };
  const roi = rgba.roi(r), rgb = new cv.Mat(), lab = new cv.Mat(), hsv = new cv.Mat();
  cv.cvtColor(roi, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const n = r.width * r.height, cnt = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], hist = new Float32Array(128);
  const L = lab.data, Hs = hsv.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    cnt[0][L[j]]++; cnt[1][L[j + 1]]++; cnt[2][L[j + 2]]++;
    hist[Math.min(7, Math.trunc(Hs[j] / 22.5)) * 16 + (Hs[j + 1] >> 6) * 4 + (Hs[j + 2] >> 6)] += 1;
  }
  roi.delete(); rgb.delete(); lab.delete(); hsv.delete();
  const median = (c) => {           // as numpy: the mean of the two middle values when the count is even
    const lo = Math.floor((n - 1) / 2), hi = Math.floor(n / 2); let acc = 0, a = -1, b = -1;
    for (let v = 0; v < 256; v++) { acc += c[v]; if (a < 0 && acc > lo) a = v; if (acc > hi) { b = v; break; } }
    return (a + b) / 2;
  };
  let s = 0;
  for (const v of hist) s += v * v;
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < 128; i++) hist[i] /= s;
  return { lab: [median(cnt[0]), median(cnt[1]), median(cnt[2])], hist };
}

/** OpenCV's Bhattacharyya distance between two histograms */
function bhattacharyya(h1, h2) {
  let s1 = 0, s2 = 0, r = 0;
  for (let i = 0; i < h1.length; i++) { s1 += h1[i]; s2 += h2[i]; r += Math.sqrt(h1[i] * h2[i]); }
  const sc = Math.abs(s1 * s2) > 1.2e-7 ? 1 / Math.sqrt(s1 * s2) : 1;
  return Math.sqrt(Math.max(1 - r * sc, 0));
}
const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ------------------------------------------------------------------ people */
class PersonDetector {
  constructor(session) {
    this.s = session; const S = PL.DET_SIZE;
    const g = [], st = [];
    for (const stride of [8, 16, 32]) {
      const k = S / stride;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { g.push(x, y); st.push(stride); }
    }
    this.grid = Float32Array.from(g); this.stride = Float32Array.from(st);
  }

  async _run(rgba, rect) {
    const S = PL.DET_SIZE, r = Math.min(S / rect.height, S / rect.width);
    const nw = Math.trunc(rect.width * r), nh = Math.trunc(rect.height * r);
    const roi = rgba.roi(rect), small = new cv.Mat();
    cv.resize(roi, small, new cv.Size(nw, nh), 0, 0, cv.INTER_LINEAR);
    roi.delete();
    const N = S * S, f = new Float32Array(3 * N).fill(114), d = small.data;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {          // blue, green, red planes, 0-255
        const j = (y * nw + x) * 4, i = y * S + x;
        f[i] = d[j + 2]; f[N + i] = d[j + 1]; f[2 * N + i] = d[j];
      }
    }
    small.delete();
    const res = await this.s.run({ [this.s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, S, S]) });
    const o = res[this.s.outputNames[0]].data, n = this.stride.length, out = [];
    for (let k = 0; k < n; k++) {
      const q = k * 85, score = o[q + 4] * o[q + 5];
      if (score <= PL.DET_SCORE) continue;
      const st = this.stride[k], cx = (o[q] + this.grid[2 * k]) * st, cy = (o[q + 1] + this.grid[2 * k + 1]) * st;
      const w = Math.exp(o[q + 2]) * st, h = Math.exp(o[q + 3]) * st;
      out.push({ box: [(cx - w / 2) / r + rect.x, (cy - h / 2) / r + rect.y, (cx + w / 2) / r + rect.x, (cy + h / 2) / r + rect.y], score });
    }
    return out;
  }

  /** people in the part x0..x1 of the picture, below `top`; `tiles` side-by-side pieces with 15 % overlap */
  async detect(rgba, x0, x1, top, tiles) {
    const W = x1 - x0, tw = tiles > 1 ? Math.trunc(W / (tiles - (tiles - 1) * 0.15)) : W, all = [];
    for (let i = 0; i < tiles; i++) {
      const tx = tiles === 1 ? 0 : Math.trunc((i * (W - tw)) / (tiles - 1));
      all.push(...await this._run(rgba, new cv.Rect(x0 + tx, top, tw, rgba.rows - top)));
    }
    // the same person found in two tiles, or twice: keep the higher score
    const cand = all.filter((b) => b.score > PL.NMS_SCORE).map((b, i) => [b, i]).sort((a, b) => b[0].score - a[0].score || a[1] - b[1]).map((x) => x[0]);
    const keep = [];
    for (const b of cand) if (!keep.some((k) => iou(k.box, b.box) > PL.NMS_IOU)) keep.push(b);
    return keep;
  }
}

/* ------------------------------------------------------------------ following people */
class Tracker {
  constructor(maxGap = PL.TRACK_GAP, gate = PL.COLOUR_GATE) { this.tracks = []; this.dead = []; this.next = 1; this.maxGap = maxGap; this.gate = gate; }

  /** boxes: [x0, y0, x1, y1] found in frame f; rgba: that frame */
  step(f, boxes, rgba) {
    const sh = boxes.map((b) => shirtOf(rgba, b)), T = this.tracks;
    let pairs = [], C = null;
    if (T.length && boxes.length) {
      C = T.map((t) => {
        const d = (f - t.last), p = [t.box[0] + d * t.v[0], t.box[1] + d * t.v[1], t.box[2] + d * t.v[0], t.box[3] + d * t.v[1]], ph = p[3] - p[1];
        return boxes.map((b, j) => {
          const u = iou(p, b), cd = Math.hypot((p[0] + p[2] - b[0] - b[2]) / 2, (p[1] + p[3] - b[1] - b[3]) / 2);
          if (u < 0.1 && cd > 0.6 * ph) return 9;
          const ratio = (b[3] - b[1]) / Math.max(1, ph);
          if (!(ratio > 0.6 && ratio < 1.6)) return 9;
          if (t.col && sh[j].lab && labDist(t.col, sh[j].lab) > this.gate) return 9;     // other shirt colour: other player
          const hd = t.hist && sh[j].hist ? bhattacharyya(t.hist, sh[j].hist) : 0.5;
          return (1 - u) + 0.8 * hd;
        });
      });
      pairs = hungarian(C);
    }
    const used = new Set();
    for (const [i, j] of pairs) {
      if (C[i][j] > PL.MATCH_MAX) continue;
      const t = T[i], b = boxes[j], dt = f - t.last;
      const cn = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], co = [(t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2];
      t.v = [0.6 * t.v[0] + 0.4 * (cn[0] - co[0]) / dt, 0.6 * t.v[1] + 0.4 * (cn[1] - co[1]) / dt];
      t.box = b.slice(); t.last = f; t.boxes.set(f, b.slice()); t.cols.set(f, sh[j].lab);
      if (sh[j].lab) t.col = t.col ? t.col.map((v, k) => 0.85 * v + 0.15 * sh[j].lab[k]) : sh[j].lab.slice();
      if (sh[j].hist) {
        if (!t.hist) t.hist = sh[j].hist;
        else { const k = Math.min(t.histN, 20); t.hist = t.hist.map((v, q) => (v * k + sh[j].hist[q]) / (k + 1)); }
        t.histN++;
      }
      used.add(j);
    }
    boxes.forEach((b, j) => {
      if (used.has(j)) return;
      this.tracks.push({ id: this.next++, box: b.slice(), v: [0, 0], last: f, hist: sh[j].hist, histN: 1, col: sh[j].lab ? sh[j].lab.slice() : null,
        boxes: new Map([[f, b.slice()]]), cols: new Map([[f, sh[j].lab]]) });
    });
    const alive = [];
    for (const t of this.tracks) (f - t.last <= this.maxGap ? alive : this.dead).push(t);
    this.tracks = alive;
  }

  all() { return [...this.tracks, ...this.dead]; }
}

/* ------------------------------------------------------------------ numbers */
class NumberReader {
  /** det, rec: ort.InferenceSession of the text finding and text reading models */
  constructor(det, rec) { this.det = det; this.rec = rec; this.k2 = cv.Mat.ones(2, 2, cv.CV_8U); }

  /** rgba: a shirt picture. Returns [{text, conf, cx}] with cx the text centre as a share of the width; digits only. */
  async read(rgba) {
    const boxes = await this._detect(rgba);
    if (!boxes.length) return [];
    const crops = boxes.map((pts) => this._crop(rgba, pts));
    const texts = await this._recognise(crops.filter(Boolean));
    const out = [];
    let k = 0;
    boxes.forEach((pts, i) => {
      if (!crops[i]) return;
      const r = texts[k++]; crops[i].delete();
      if (!r || r.conf < 0.5) return;
      out.push({ text: r.text, conf: r.conf, cx: (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4 / rgba.cols });
    });
    return out;
  }

  async _detect(rgba) {
    const h = rgba.rows, w = rgba.cols, ratio = Math.max(h, w) > 400 ? 400 / Math.max(h, w) : 1;
    const r32 = (v) => { const q = Math.trunc(v * ratio) / 32, fl = Math.floor(q); return 32 * (q - fl === 0.5 ? fl + (fl % 2) : Math.round(q)); };
    const rh = r32(h), rw = r32(w);
    if (rh <= 0 || rw <= 0) return [];
    const small = new cv.Mat();
    cv.resize(rgba, small, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);
    const n = rw * rh, f = new Float32Array(3 * n), d = small.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) { f[i] = d[j + 2] / 127.5 - 1; f[n + i] = d[j + 1] / 127.5 - 1; f[2 * n + i] = d[j] / 127.5 - 1; }
    small.delete();
    const res = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, rh, rw]) });
    const pred = res[this.det.outputNames[0]].data;
    const bm = new cv.Mat(rh, rw, cv.CV_8UC1), b = bm.data;
    for (let i = 0; i < n; i++) b[i] = pred[i] > 0.3 ? 255 : 0;
    cv.dilate(bm, bm, this.k2, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bm, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const out = [];
    for (let k = 0; k < Math.min(contours.size(), 1000); k++) {
      const c = contours.get(k), r = cv.minAreaRect(c);
      c.delete();
      if (Math.min(r.size.width, r.size.height) < 3) continue;
      if (NumberReader._score(pred, rw, rh, NumberReader._corners(r, 0)) < 0.5) continue;
      const grow = (r.size.width * r.size.height * 1.6) / (2 * (r.size.width + r.size.height));
      if (Math.min(r.size.width, r.size.height) + 2 * grow < 5) continue;
      const pts = NumberReader._clockwise(NumberReader._corners(r, grow).map(([x, y]) => [
        Math.min(w - 1, Math.max(0, Math.round((x / rw) * w))), Math.min(h - 1, Math.max(0, Math.round((y / rh) * h)))]));
      const bw = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), bh = Math.hypot(pts[0][0] - pts[3][0], pts[0][1] - pts[3][1]);
      if (Math.trunc(bw) <= 3 || Math.trunc(bh) <= 3) continue;
      out.push(pts);
    }
    contours.delete(); hier.delete(); bm.delete();
    // top to bottom, left to right (as the original)
    out.sort((p, q) => p[0][1] - q[0][1] || p[0][0] - q[0][0]);
    for (let i = 0; i < out.length - 1; i++) {
      for (let j = i; j >= 0; j--) {
        if (Math.abs(out[j + 1][0][1] - out[j][0][1]) < 10 && out[j + 1][0][0] < out[j][0][0]) [out[j], out[j + 1]] = [out[j + 1], out[j]];
        else break;
      }
    }
    return out;
  }

  static _corners(r, grow) {
    const a = (r.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), hw = r.size.width / 2 + grow, hh = r.size.height / 2 + grow;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [r.center.x + x * c - y * s, r.center.y + x * s + y * c]);
  }

  static _clockwise(pts) {
    const xs = pts.slice().sort((p, q) => p[0] - q[0]);
    const left = xs.slice(0, 2).sort((p, q) => p[1] - q[1]), right = xs.slice(2).sort((p, q) => p[1] - q[1]);
    return [left[0], right[0], right[1], left[1]];
  }

  static _score(pred, w, h, pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(Math.min(...xs)))), x1 = Math.min(w - 1, Math.max(0, Math.ceil(Math.max(...xs))));
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(Math.min(...ys)))), y1 = Math.min(h - 1, Math.max(0, Math.ceil(Math.max(...ys))));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let inside = true;
        for (let i = 0; i < 4 && inside; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
          if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < -1e-6) inside = false;
        }
        if (inside) { sum += pred[y * w + x]; n++; }
      }
    }
    return n ? sum / n : 0;
  }

  /** the text box cut out and straightened (turned when it is much taller than wide, as the original) */
  _crop(rgba, pts) {
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const w = Math.trunc(Math.max(dist(pts[0], pts[1]), dist(pts[2], pts[3]))), h = Math.trunc(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
    if (w < 1 || h < 1) return null;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat()), dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(src, dst), out = new cv.Mat();
    cv.warpPerspective(rgba, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    src.delete(); dst.delete(); M.delete();
    if (h / w >= 1.5) cv.rotate(out, out, cv.ROTATE_90_COUNTERCLOCKWISE);
    return out;
  }

  /** read the text pieces in batches of six of similar shape, as the original */
  async _recognise(crops) {
    const H = 48, order = crops.map((c, i) => [c.cols / c.rows, i]).sort((a, b) => a[0] - b[0]), res = new Array(crops.length);
    for (let b0 = 0; b0 < order.length; b0 += PL.REC_BATCH) {
      const batch = order.slice(b0, b0 + PL.REC_BATCH), maxRatio = Math.max(320 / 48, ...batch.map((x) => x[0]));
      const W = Math.trunc(H * maxRatio), n = W * H, f = new Float32Array(batch.length * 3 * n);
      batch.forEach(([ratio, i], bi) => {
        const rw = Math.min(W, Math.ceil(H * ratio)), small = new cv.Mat();
        cv.resize(crops[i], small, new cv.Size(rw, H), 0, 0, cv.INTER_LINEAR);
        const d = small.data, base = bi * 3 * n;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < rw; x++) {
            const j = (y * rw + x) * 4, k = y * W + x;
            f[base + k] = d[j + 2] / 127.5 - 1; f[base + n + k] = d[j + 1] / 127.5 - 1; f[base + 2 * n + k] = d[j] / 127.5 - 1;
          }
        }
        small.delete();
      });
      const out = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', f, [batch.length, 3, H, W]) });
      const t = out[this.rec.outputNames[0]], p = t.data, T = t.dims[1], C = t.dims[2];
      batch.forEach(([, i], bi) => {
        let text = '', sum = 0, cnt = 0, last = -1;
        for (let s = 0; s < T; s++) {
          let best = 0, bv = -1;
          for (let c = 0, o = (bi * T + s) * C; c < C; c++) if (p[o + c] > bv) { bv = p[o + c]; best = c; }
          if (best !== 0 && best !== last) { text += PL.DIGITS[best] ?? '?'; sum += bv; cnt++; }
          last = best;
        }
        res[i] = cnt ? { text, conf: sum / cnt } : null;
      });
    }
    return res;
  }

  /** numbers on the shirt of a person box in this picture: [[text, conf]] */
  async shirtNumbers(rgba, box) {
    const r = torsoRect(box, rgba.cols, rgba.rows);
    if (!r) return [];
    const roi = rgba.roi(r), big = new cv.Mat(), k = PL.OCR_H / r.height;
    cv.resize(roi, big, new cv.Size(0, 0), k, k, cv.INTER_CUBIC);
    roi.delete();
    const found = await this.read(big);
    big.delete();
    return found.filter((x) => /^\d{1,2}$/.test(x.text) && x.conf >= PL.READ_CONF && x.cx >= 0.15 && x.cx <= 0.85).map((x) => [x.text, Math.round(x.conf * 1000) / 1000]);
  }
}

/* ------------------------------------------------------------------ deciding the shooter's number */
/** reads [[t, text, conf]] -> the number on the stretch of reads nearest the gather time:
    reads of one number in a row form a run (one stray read in between does not break it); a run needs
    a total confidence of 1.5 (two good reads). Returns {number, gap (s from the gather)} or null. */
function decideNumber(reads, tGather) {
  const rs = reads.filter((r) => r[2] >= PL.DECIDE_CONF).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2]);
  if (!rs.length) return null;
  const runs = [];
  for (const [t, n, c] of rs) {
    const last = runs[runs.length - 1];
    if (last && last.n === n) { last.t1 = t; last.sum += c; last.k++; } else runs.push({ n, t0: t, t1: t, sum: c, k: 1 });
  }
  const merged = [];
  for (const r of runs) {
    const m = merged[merged.length - 1];
    if (merged.length >= 2 && m.k === 1 && merged[merged.length - 2].n === r.n) {
      merged.pop(); const p = merged[merged.length - 1]; p.t1 = r.t1; p.sum += r.sum; p.k += r.k;
    } else if (m && m.n === r.n) { m.t1 = r.t1; m.sum += r.sum; m.k += r.k; } else merged.push({ ...r });
  }
  const good = merged.filter((r) => r.sum >= PL.RUN_MIN);
  if (!good.length) return null;
  const gap = (r) => (r.t0 <= tGather && tGather <= r.t1 ? 0 : Math.min(Math.abs(tGather - r.t0), Math.abs(tGather - r.t1)));
  const best = good.reduce((a, b) => (gap(b) < gap(a) || (gap(b) === gap(a) && b.sum > a.sum) ? b : a));
  return { number: best.n, gap: Math.round(gap(best) * 10) / 10, reads: best.k };
}

/** One shot: frames arrive in time order; people near the ball are followed; at the end the shooter is chosen
    and the numbers on that person are read. shot: {id, t, x, y, rimW, ball: [[t, x, y]]} in PROC_W coordinates. */
class ShotWindow {
  constructor(shot, W, H, procW) {
    this.shot = shot; this.W = W; this.H = H; this.sc = W / procW;
    this.t0 = Math.max(0, shot.t - PL.BEFORE); this.t1 = shot.t + PL.AFTER;
    this.f = 0; this.tracker = new Tracker(); this.crops = new Map();   // "trackId:f" -> shirt picture
    const R = (shot.rimW || 22) * this.sc;
    this.x0 = Math.trunc(Math.max(0, shot.x * this.sc - PL.CROP_R * R)); this.x1 = Math.trunc(Math.min(W, shot.x * this.sc + PL.CROP_R * R));
  }

  /** the frame at grid time t0 + f / FPS is due once a frame at or after it arrives */
  due(ts) { return this.f <= Math.round((this.t1 - this.t0) * PL.FPS) && ts >= this.t0 + this.f / PL.FPS - 0.5 / PL.FPS - 1e-6; }
  done(ts) { return ts > this.t1 + 0.2 || this.f > Math.round((this.t1 - this.t0) * PL.FPS); }

  async push(rgba, detector) {
    const top = Math.round(PL.TOP * this.H), minH = PL.MIN_H * this.H, ocrH = PL.OCR_MIN_H * this.H;
    const found = await detector.detect(rgba, this.x0, this.x1, top, 1);
    const boxes = found.filter((b) => b.score > PL.KEEP_SCORE && b.box[3] - b.box[1] > minH).map((b) => b.box);
    this.tracker.step(this.f, boxes, rgba);
    for (const t of this.tracker.tracks) {
      if (t.last !== this.f) continue;
      const b = t.box;
      if (b[3] - b[1] < ocrH) continue;
      const r = torsoRect(b, rgba.cols, rgba.rows);
      if (r) { const roi = rgba.roi(r); this.crops.set(`${t.id}:${this.f}`, roi.clone()); roi.delete(); }
    }
    this.f++;
  }

  /** -> {id, number, gap, reads, lab} */
  async finish(reader) {
    const s = this.shot, sc = this.sc, all = this.tracker.all();
    const gf = Math.round((s.t - this.t0) * PL.FPS);
    let balls = (s.ball || []).map(([bt, bx, by]) => [Math.round((bt - this.t0) * PL.FPS), bx * sc, by * sc]);
    if (!balls.length) balls = [[gf, s.x * sc, s.y * sc]];
    // the person holding the ball: the ball inside the box (with a margin), between head and hips, over the frames around the gather
    const score = new Map();
    for (const t of all) {
      const ks = [...t.boxes.keys()];
      for (const [bf, bx, by] of balls) {
        let fb = ks[0];
        for (const k of ks) if (Math.abs(k - bf) < Math.abs(fb - bf)) fb = k;
        if (Math.abs(fb - bf) > 2) continue;
        const [x0, y0, x1, y1] = t.boxes.get(fb), h = y1 - y0, w = x1 - x0;
        if (bx >= x0 - 0.3 * w && bx <= x1 + 0.3 * w && by >= y0 - 0.35 * h && by <= y0 + 0.75 * h) {
          score.set(t.id, (score.get(t.id) || 0) + 1 - 0.5 * Math.min(1, Math.abs(bx - (x0 + x1) / 2) / w));
        }
      }
    }
    let shooter = null, best = -Infinity;
    for (const t of all) if (score.has(t.id) && score.get(t.id) > best) { best = score.get(t.id); shooter = t; }
    const out = { id: s.id, number: null, gap: null, reads: [], lab: null };
    if (shooter) {
      const ks = [...shooter.boxes.keys()].sort((a, b) => a - b);
      let ck = ks[0];
      for (const k of ks) if (Math.abs(k - gf) < Math.abs(ck - gf)) ck = k;
      out.lab = shooter.cols.get(ck) || shooter.col;
      for (let i = 0; i < ks.length; i += 2) {             // every second frame of the shooter
        const img = this.crops.get(`${shooter.id}:${ks[i]}`);
        if (!img) continue;
        const big = new cv.Mat(), k = PL.OCR_H / img.rows;
        cv.resize(img, big, new cv.Size(0, 0), k, k, cv.INTER_CUBIC);
        const found = await reader.read(big);
        big.delete();
        for (const x of found) {
          if (/^\d{1,2}$/.test(x.text) && x.conf >= PL.READ_CONF && x.cx >= 0.15 && x.cx <= 0.85) {
            out.reads.push([Math.round((this.t0 + ks[i] / PL.FPS) * 100) / 100, x.text, Math.round(x.conf * 1000) / 1000]);
          }
        }
      }
      const d = decideNumber(out.reads, s.t);
      if (d) { out.number = d.number; out.gap = d.gap; out.runReads = d.reads; }
    }
    this.close();
    return out;
  }

  close() { for (const m of this.crops.values()) m.delete(); this.crops.clear(); }
}

/** everybody in one picture: [{lab, h, reads: [[text, conf]]}] (people at least OCR_MIN_H tall) */
async function peopleIn(rgba, detector, reader) {
  const H = rgba.rows, top = Math.round(PL.TOP * H);
  const found = await detector.detect(rgba, 0, rgba.cols, top, 2), out = [];
  for (const b of found) {
    if (b.score <= PL.KEEP_SCORE || b.box[3] - b.box[1] < PL.OCR_MIN_H * H) continue;
    const { lab } = shirtOf(rgba, b.box);
    if (!lab) continue;
    out.push({ lab, h: Math.round(b.box[3] - b.box[1]), reads: await reader.shirtNumbers(rgba, b.box) });
  }
  return out;
}

/* ------------------------------------------------------------------ teams (main thread) */
/** k-means with a fixed start (k-means++ on a seeded random sequence): same answer every run */
function kmeans(points, k, iters = 50) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
  const cen = [points[Math.floor(rnd() * points.length)].slice()];
  while (cen.length < k) {
    const dist = points.map((p) => Math.min(...cen.map((c) => d2(p, c)))), tot = dist.reduce((a, b) => a + b, 0);
    let r = rnd() * tot, i = 0;
    while (i < points.length - 1 && r > dist[i]) { r -= dist[i]; i++; }
    cen.push(points[i].slice());
  }
  let lbl = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    lbl = points.map((p) => { let b = 0; for (let c = 1; c < k; c++) if (d2(p, cen[c]) < d2(p, cen[b])) b = c; return b; });
    const sum = cen.map(() => new Array(points[0].length).fill(0)), n = new Array(k).fill(0);
    points.forEach((p, i) => { n[lbl[i]]++; p.forEach((v, j) => { sum[lbl[i]][j] += v; }); });
    let moved = 0;
    for (let c = 0; c < k; c++) if (n[c]) { const m = sum[c].map((v) => v / n[c]); moved += d2(m, cen[c]); cen[c] = m; }
    if (moved < 1e-6) break;
  }
  return { cen, lbl };
}
const LAB_W = [0.5, 1, 1];       // colour distance: lightness counts half (shade and light change it), colour fully

function labToHex([L, a, b]) {
  // OpenCV 8-bit Lab -> sRGB
  const l = (L * 100) / 255, A = a - 128, B = b - 128;
  let y = (l + 16) / 116, x = A / 500 + y, z = y - B / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.950456 * f(x); y = f(y); z = 1.088754 * f(z);
  const lin = [3.240479 * x - 1.53715 * y - 0.498535 * z, -0.969256 * x + 1.875991 * y + 0.041556 * z, 0.055648 * x - 0.204043 * y + 1.057311 * z];
  return `#${lin.map((v) => { const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, '0'); }).join('')}`;
}

/** people: [{lab, reads}] from every video -> two teams {colour, lab, numbers} (most numbers read first), or null.
    Shirt colours fall into three groups (two teams and everybody else); a team's numbers are those read on at
    least MIN_SEEN people-pictures, leaving out one digit of a number of the same group read five times as often
    (a part of "33" read as "3"). The two groups whose numbers were read most are the teams. */
const TEAM = { MIN_SEEN: 3, PART: 5, MIN_PEOPLE: 30 };
function findTeams(people) {
  const ps = people.filter((p) => p.lab);
  if (ps.length < TEAM.MIN_PEOPLE) return null;
  const { cen, lbl } = kmeans(ps.map((p) => p.lab.map((v, i) => v * LAB_W[i])), 3);
  const groups = cen.map((c, g) => {
    const seen = new Map();
    ps.forEach((p, i) => {
      if (lbl[i] !== g) return;
      for (const n of new Set(p.reads.filter((r) => r[1] >= PL.DECIDE_CONF).map((r) => r[0]))) seen.set(n, (seen.get(n) || 0) + 1);
    });
    let nums = [...seen].filter(([, k]) => k >= TEAM.MIN_SEEN);
    nums = nums.filter(([n, k]) => !(n.length === 1 && nums.some(([o, ko]) => o !== n && o.includes(n) && ko >= TEAM.PART * k)));
    const lab = c.map((v, i) => v / LAB_W[i]);
    return { lab, colour: labToHex(lab), numbers: nums.map(([n]) => n).sort((a, b) => Number(a) - Number(b)),
      seen: Object.fromEntries(nums), mass: nums.reduce((s, [, k]) => s + k, 0), group: g };
  }).sort((a, b) => b.mass - a.mass);
  if (!groups[1] || !groups[1].mass) return null;
  return { teams: [groups[0], groups[1]], others: groups.slice(2), labOf: (lab) => {
    let b = 0, bd = Infinity;
    cen.forEach((c, g) => { const d = c.reduce((s, v, i) => s + (v - lab[i] * LAB_W[i]) ** 2, 0); if (d < bd) { bd = d; b = g; } });
    return groups.findIndex((x) => x.group === b);
  } };
}

/** which team attacks the left hoop: shots [{side, t, lab, number}] (t on the record's clock; side as shot);
    the shooter's team is the team whose numbers include the number read, else the team of the shirt colour.
    switchTime: the teams change ends at this time (or null). Returns {left: 0|1, votes} or null when unclear. */
function attackDirection(found, shots, switchTime) {
  const votes = [[0, 0], [0, 0]];       // votes[team][0]: shots at the hoop that would be "left" before the switch
  for (const s of shots) {
    let team = s.number ? found.teams.findIndex((t) => t.numbers.includes(s.number)) : -1;
    if (team < 0 && s.lab) { const g = found.labOf(s.lab); team = g < 2 ? g : -1; }
    if (team < 0) continue;
    const swapped = switchTime != null && s.t >= switchTime;
    const left = (s.side === '왼쪽') !== swapped;
    votes[team][left ? 0 : 1]++;
  }
  const score = votes[0][0] - votes[0][1] - (votes[1][0] - votes[1][1]);
  if (Math.abs(score) < 2) return null;
  return { left: score > 0 ? 0 : 1, votes };
}

if (typeof module !== 'undefined') module.exports = { PL, TEAM, iou, hungarian, torsoRect, shirtOf, bhattacharyya, PersonDetector, Tracker, NumberReader, decideNumber, ShotWindow, peopleIn, kmeans, labToHex, findTeams, attackDirection };
if (typeof self !== 'undefined' && typeof importScripts !== 'function') Object.assign(self, { Players: { PL, findTeams, attackDirection, decideNumber, labToHex } });

/* ------------------------------------------------------------------ worker */
if (typeof importScripts === 'function') {
  importScripts('vendor/opencv.js', 'vendor/ort.wasm.min.js', 'vendor/mp4box.all.min.js', 'demux.js');
  const base = self.location.href.replace(/[^/]*$/, '');
  ort.env.wasm.wasmPaths = `${base}vendor/`;
  ort.env.wasm.numThreads = 1;
  const ready = (async () => {
    if (self.cv instanceof Promise) self.cv = await self.cv;
    else if (!self.cv.Mat) await new Promise((r) => { self.cv.onRuntimeInitialized = r; });
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [p, d, r] = await Promise.all(['person', 'text-det', 'text-rec'].map((m) => ort.InferenceSession.create(`${base}vendor/models/${m}.onnx`, opt)));
    return { detector: new PersonDetector(p), reader: new NumberReader(d, r) };
  })();

  const rotationOf = (track) => {
    const m = track.matrix;
    if (!m || m.length < 5) return 0;
    return ((Math.round((Math.atan2(m[1] / 65536, m[0] / 65536) * 180) / Math.PI) % 360) + 360) % 360;
  };
  const description = (trak) => {
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) { const st = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(st); return new Uint8Array(st.buffer, 8); }
    }
    return undefined;
  };

  /** job: {file, shots: [{id, t, x, y, rimW, ball}] (times in this video), people: true|false, procW} */
  async function run(job, post) {
    const { detector, reader } = await ready;
    const m = await Demux.openMp4(MP4Box, job.file.size, (pos, len) => job.file.slice(pos, pos + len).arrayBuffer());
    const track = m.video, rot = rotationOf(track);
    const srcW = track.video.width, srcH = track.video.height, W = rot % 180 ? srcH : srcW, H = rot % 180 ? srcW : srcH;
    const duration = track.duration / track.timescale;
    const config = { codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec, codedWidth: srcW, codedHeight: srcH, description: description(m.mp4.getTrackById(track.id)) };
    const windows = job.shots.map((s) => new ShotWindow(s, W, H, job.procW)).sort((a, b) => a.t0 - b.t0);
    let open = [], nextWin = 0, nextPeople = job.people ? 0 : Infinity, nextPeopleDecode = nextPeople;
    const results = [], people = [];
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let wake = null, decErr = null;
    const decoder = new VideoDecoder({ output: (f) => { frames.push(f); if (wake) { wake(); wake = null; } }, error: (e) => { decErr = e; if (wake) { wake(); wake = null; } } });
    decoder.configure(config);
    const work = Math.max(1, windows.length * PL.FPS * (PL.BEFORE + PL.AFTER) + (job.people ? duration / PL.PEOPLE_EVERY * 3 : 0));
    let doneWork = 0, lastPost = 0;
    const progress = () => { const now = Date.now(); if (now - lastPost > 500) { lastPost = now; post({ type: 'progress', frac: Math.min(1, doneWork / work) }); } };

    const handle = async (vf) => {
      const ts = vf.timestamp / 1e6;
      while (nextWin < windows.length && windows[nextWin].t0 <= ts + 1e-6) open.push(windows[nextWin++]);
      const wantWin = open.filter((w) => w.due(ts)), wantPeople = ts >= nextPeople - 0.05;
      if (wantWin.length || wantPeople) {
        ctx.save();
        if (rot) { ctx.translate(W / 2, H / 2); ctx.rotate((rot * Math.PI) / 180); ctx.drawImage(vf, -srcW / 2, -srcH / 2, srcW, srcH); } else ctx.drawImage(vf, 0, 0, W, H);
        ctx.restore();
        vf.close();
        const rgba = cv.matFromImageData(ctx.getImageData(0, 0, W, H));
        for (const w of wantWin) { while (w.due(ts)) { await w.push(rgba, detector); doneWork++; } }
        if (wantPeople) {
          for (const p of await peopleIn(rgba, detector, reader)) people.push({ t: Math.round(ts * 10) / 10, ...p });
          nextPeople = ts + PL.PEOPLE_EVERY; doneWork += 3;
        }
        rgba.delete();
      } else vf.close();
      for (const w of open.filter((x) => x.done(ts))) {
        results.push(await w.finish(reader));
        post({ type: 'shot', result: results[results.length - 1] });
      }
      open = open.filter((x) => !x.done(ts));
      progress();
    };

    // decode only what is needed: from the key frame before each window to its end, and single key frames for the people pictures
    let running = false, runEnd = -1;
    for (;;) {
      if (decErr) throw new Error(`영상 해석 중 오류: ${decErr.message || decErr}`);
      let ended = false;
      while (decoder.decodeQueueSize < 8 && frames.length < 8) {
        const s = await m.next();
        if (!s) { ended = true; break; }
        if (s.kind !== 'video') continue;
        const t = s.cts / s.timescale;
        if (s.sync) {
          const w = windows.find((x) => x.t1 >= t && x.t0 - t <= 4);
          if (w) { running = true; runEnd = Math.max(runEnd, ...windows.filter((x) => x.t1 >= t && x.t0 - t <= 4).map((x) => x.t1)); }
          else if (running && t > runEnd + 0.3) running = false;
          if (!running && t >= nextPeopleDecode) { nextPeopleDecode = t + PL.PEOPLE_EVERY - 0.5; }
          else if (!running) continue;
        } else if (!running || t > runEnd + 0.3) { running = running && t <= runEnd + 0.3; continue; }
        decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round((1e6 * s.cts) / s.timescale),
          duration: Math.round((1e6 * s.duration) / s.timescale), data: s.data }));
      }
      if (frames.length) { await handle(frames.shift()); continue; }
      if (ended) {
        await decoder.flush();
        while (frames.length) await handle(frames.shift());
        break;
      }
      await new Promise((r) => { wake = r; setTimeout(r, 20); });
    }
    decoder.close();
    for (const w of open) results.push(await w.finish(reader));
    for (const w of windows.slice(nextWin)) { w.close(); results.push({ id: w.shot.id, number: null, gap: null, reads: [], lab: null }); }
    return { shots: results, people, W, H };
  }

  self.onmessage = async (ev) => {
    const m = ev.data;
    if (m.cmd !== 'players') return;
    try {
      const out = await run(m, (x) => self.postMessage(x));
      self.postMessage({ type: 'done', result: out });
    } catch (e) {
      self.postMessage({ type: 'error', message: `선수 번호를 찾는 중 오류: ${e && e.message ? e.message : e}` });
    }
  };
}
