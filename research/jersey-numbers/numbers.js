/* Reads numbers printed on jerseys in a picture: finds text (PP-OCRv4 detection model), then reads each
   piece of text (PP-OCRv4 recognition model) and keeps the ones that are 1-2 digits. Models run on
   ONNX Runtime Web (wasm), so this works in a browser without sending pictures anywhere. Same steps and
   thresholds as the RapidOCR pipeline, minus the upside-down check (jersey numbers are upright).
   Runs as a Web Worker (entry at the bottom) and in Node. Needs globals `cv` (OpenCV.js) and `ort`.
   Not part of the app: see README.md in this folder for why and for how to run it. */
'use strict';

const NUM = {
  DET_MIN_SIDE: 736,          // pictures smaller than this are enlarged for the detector
  DET_THR: 0.3, BOX_THR: 0.5, UNCLIP: 1.6, MIN_SIDE: 3, MAX_BOXES: 200,
  REC_H: 48, REC_W: 320,
  TEXT_SCORE: 0.5,
  // classes of the recognition model that are digits (index in its character list; 0 is "blank")
  DIGITS: { 26: '0', 93: '1', 25: '2', 94: '3', 632: '4', 631: '5', 933: '6', 29: '7', 27: '8', 1109: '9' },
};

class NumberReader {
  /** det, rec: ort.InferenceSession */
  constructor(det, rec) {
    this.det = det; this.rec = rec;
    this.k2 = cv.Mat.ones(2, 2, cv.CV_8U);
  }

  /** rgba: cv.Mat CV_8UC4. Returns [{text, conf, x, y, w, h, shade}] in the picture's pixels (x, y = centre). */
  async read(rgba) {
    const boxes = await this._detect(rgba);
    const out = [];
    for (const pts of boxes) {
      const crop = this._crop(rgba, pts);
      if (!crop) continue;
      const r = await this._recognise(crop);
      crop.delete();
      if (!r || r.conf < NUM.TEXT_SCORE || !/^\d{1,2}$/.test(r.text)) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({ text: r.text, conf: Math.round(r.conf * 1000) / 1000, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0,
        shade: this._shade(rgba, x0, y0, x1, y1) });
    }
    return out;
  }

  async _detect(rgba) {
    const h = rgba.rows, w = rgba.cols;
    const ratio = Math.min(h, w) < NUM.DET_MIN_SIDE ? NUM.DET_MIN_SIDE / Math.min(h, w) : 1;
    const r32 = (v) => { const q = Math.trunc(v * ratio) / 32, f = Math.floor(q); return Math.max(32, 32 * (q - f === 0.5 ? f + (f % 2) : Math.round(q))); };   // halves go to even, as in the original
    const rh = r32(h), rw = r32(w);
    const small = new cv.Mat();
    cv.resize(rgba, small, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);
    const n = rw * rh, f = new Float32Array(3 * n), d = small.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {       // the models take blue, green, red
      f[i] = d[j + 2] / 127.5 - 1; f[n + i] = d[j + 1] / 127.5 - 1; f[2 * n + i] = d[j] / 127.5 - 1;
    }
    small.delete();
    const res = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, rh, rw]) });
    const pred = res[this.det.outputNames[0]].data;
    const bm = new cv.Mat(rh, rw, cv.CV_8UC1), b = bm.data;
    for (let i = 0; i < n; i++) b[i] = pred[i] > NUM.DET_THR ? 255 : 0;
    cv.dilate(bm, bm, this.k2, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bm, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const out = [];
    for (let k = 0; k < Math.min(contours.size(), NUM.MAX_BOXES); k++) {
      const c = contours.get(k);
      const r = cv.minAreaRect(c);
      c.delete();
      if (Math.min(r.size.width, r.size.height) < NUM.MIN_SIDE) continue;
      if (NumberReader._score(pred, rw, rh, NumberReader._corners(r, 0)) < NUM.BOX_THR) continue;
      // grow the box: the detector marks the core of the text
      const grow = (r.size.width * r.size.height * NUM.UNCLIP) / (2 * (r.size.width + r.size.height));
      if (Math.min(r.size.width, r.size.height) + 2 * grow < NUM.MIN_SIDE + 2) continue;
      const pts = NumberReader._corners(r, grow).map(([x, y]) => [
        Math.min(w - 1, Math.max(0, Math.round((x / rw) * w))), Math.min(h - 1, Math.max(0, Math.round((y / rh) * h)))]);
      const ordered = NumberReader._clockwise(pts);
      const bw = Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1]);
      const bh = Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1]);
      if (Math.trunc(bw) <= 3 || Math.trunc(bh) <= 3) continue;
      out.push(ordered);
    }
    contours.delete(); hier.delete(); bm.delete();
    return out;
  }

  /** corners of a rotated rectangle grown by `grow` on every side */
  static _corners(r, grow) {
    const a = (r.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const hw = r.size.width / 2 + grow, hh = r.size.height / 2 + grow;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [r.center.x + x * c - y * s, r.center.y + x * s + y * c]);
  }

  /** top-left, top-right, bottom-right, bottom-left */
  static _clockwise(pts) {
    const xs = pts.slice().sort((p, q) => p[0] - q[0]);
    const left = xs.slice(0, 2).sort((p, q) => p[1] - q[1]), right = xs.slice(2).sort((p, q) => p[1] - q[1]);
    return [left[0], right[0], right[1], left[1]];
  }

  /** mean of the detector's map inside the box */
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

  /** the text box cut out and straightened: cv.Mat RGBA, or null */
  _crop(rgba, pts) {
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const w = Math.trunc(Math.max(dist(pts[0], pts[1]), dist(pts[2], pts[3]))), h = Math.trunc(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
    if (w < 2 || h < 2) return null;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat()), dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(src, dst), out = new cv.Mat();
    cv.warpPerspective(rgba, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    src.delete(); dst.delete(); M.delete();
    return out;
  }

  async _recognise(crop) {
    const H = NUM.REC_H, ratio = crop.cols / crop.rows;
    const W = Math.max(NUM.REC_W, Math.trunc(H * ratio)), rw = Math.min(W, Math.ceil(H * ratio));
    const small = new cv.Mat();
    cv.resize(crop, small, new cv.Size(rw, H), 0, 0, cv.INTER_LINEAR);
    const n = W * H, f = new Float32Array(3 * n), d = small.data;       // the rest of the width stays 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < rw; x++) {
        const j = (y * rw + x) * 4, i = y * W + x;
        f[i] = d[j + 2] / 127.5 - 1; f[n + i] = d[j + 1] / 127.5 - 1; f[2 * n + i] = d[j] / 127.5 - 1;
      }
    }
    small.delete();
    const res = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, H, W]) });
    const t = res[this.rec.outputNames[0]], p = t.data, T = t.dims[1], C = t.dims[2];
    let text = '', sum = 0, cnt = 0, last = -1;
    for (let s = 0; s < T; s++) {
      let best = 0, bv = -1;
      for (let c = 0, o = s * C; c < C; c++) if (p[o + c] > bv) { bv = p[o + c]; best = c; }
      if (best !== 0 && best !== last) { text += NUM.DIGITS[best] ?? '?'; sum += bv; cnt++; }
      last = best;
    }
    return cnt ? { text, conf: sum / cnt } : null;
  }

  /** how light the cloth around the number is (0-255): median grey of the box and a margin around it */
  _shade(rgba, x0, y0, x1, y1) {
    const bw = x1 - x0, bh = y1 - y0;
    const ax = Math.max(0, Math.round(x0 - 0.5 * bw)), ay = Math.max(0, Math.round(y0 - 0.4 * bh));
    const bx = Math.min(rgba.cols - 1, Math.round(x1 + 0.5 * bw)), by = Math.min(rgba.rows - 1, Math.round(y1 + 0.4 * bh));
    const hist = new Uint32Array(256), d = rgba.data, W = rgba.cols;
    let n = 0;
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const j = (y * W + x) * 4;
        hist[(d[j] * 4899 + d[j + 1] * 9617 + d[j + 2] * 1868 + 8192) >> 14]++; n++;
      }
    }
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= n) return v; }
    return 0;
  }
}

if (typeof module !== 'undefined') module.exports = { NUM, NumberReader };

/* ---------------------------------------------------------------- worker entry */
if (typeof importScripts === 'function') {
  importScripts('vendor/opencv.js', 'vendor/ort/ort.wasm.min.js');
  const base = self.location.href.replace(/[^/]*$/, '');
  ort.env.wasm.wasmPaths = `${base}vendor/ort/`;
  ort.env.wasm.numThreads = 1;
  let reader = null;
  const ready = (async () => {
    if (self.cv instanceof Promise) self.cv = await self.cv;
    else if (!self.cv.Mat) await new Promise((r) => { self.cv.onRuntimeInitialized = r; });
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(`${base}vendor/ocr/det.onnx`, opt), ort.InferenceSession.create(`${base}vendor/ocr/rec.onnx`, opt)]);
    reader = new NumberReader(det, rec);
  })();
  let chain = Promise.resolve();
  self.onmessage = (ev) => {
    const m = ev.data;
    if (m.cmd === 'init') { ready.then(() => self.postMessage({ type: 'ready' }), (e) => self.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) })); return; }
    if (m.cmd !== 'read') return;
    chain = chain.then(async () => {
      try {
        await ready;
        const mat = cv.matFromImageData({ data: new Uint8ClampedArray(m.data), width: m.width, height: m.height });
        const t0 = performance.now();
        const boxes = await reader.read(mat);
        mat.delete();
        self.postMessage({ type: 'result', id: m.id, boxes, ms: performance.now() - t0 });
      } catch (e) {
        self.postMessage({ type: 'result', id: m.id, boxes: [], error: String(e && e.message ? e.message : e) });
      }
    });
  };
}
