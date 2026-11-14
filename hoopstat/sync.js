/* Line up two recordings of the same game by their sound.
   Each analysis returns a loudness envelope (100 values per second, see WhistleDetector.envelope()).
   Whistles, bounces and shouts reach both phones at almost the same moment, so the two envelopes
   match best when shifted by the difference between the recordings' start times. */
'use strict';
(function (root) {
  /** in-place radix-2 FFT (inverse leaves the result unscaled) */
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /** sudden sounds only: the envelope minus its 1 s moving average, negatives dropped, mean removed */
  function onsets(env, hz) {
    const n = env.length, win = Math.max(1, Math.round(hz)), out = new Float64Array(n);
    let sum = 0;
    const half = win >> 1;
    for (let i = 0; i < Math.min(n, half); i++) sum += env[i];
    let cnt = Math.min(n, half);
    for (let i = 0; i < n; i++) {
      if (i + half < n) { sum += env[i + half]; cnt += 1; }
      if (i - half - 1 >= 0) { sum -= env[i - half - 1]; cnt -= 1; }
      out[i] = Math.max(0, env[i] - sum / cnt);
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i];
    mean /= Math.max(1, n);
    for (let i = 0; i < n; i++) out[i] -= mean;
    return out;
  }

  /** Returns {offset, score, ratio, ok}: a moment at time t in recording B is at t + offset in recording A.
      score = how many standard deviations the best match stands above the rest; ratio = best / second best. */
  function offset(envA, envB, hz = 100) {
    if (!envA || !envB || envA.length < hz * 20 || envB.length < hz * 20) return { offset: 0, score: 0, ratio: 0, ok: false };
    const a = onsets(envA, hz), b = onsets(envB, hz);
    let n = 1;
    while (n < a.length + b.length) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(a); br.set(b);
    fft(ar, ai, false); fft(br, bi, false);
    for (let i = 0; i < n; i++) {                       // A x conj(B)
      const re = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i];
      ar[i] = re; ai[i] = im;
    }
    fft(ar, ai, true);
    // lag k >= 0 at index k, negative lags at n + k; at least 20 s of overlap
    const minOverlap = hz * 20;
    let best = -Infinity, bestLag = 0, sum = 0, sq = 0, cnt = 0;
    const lagAt = (i) => (i < n / 2 ? i : i - n);
    const valid = (lag) => (lag >= 0 ? a.length - lag : b.length + lag) >= minOverlap && (lag >= 0 ? lag < a.length : -lag < b.length);
    for (let i = 0; i < n; i++) {
      const lag = lagAt(i);
      if (!valid(lag)) continue;
      const v = ar[i];
      sum += v; sq += v * v; cnt += 1;
      if (v > best) { best = v; bestLag = lag; }
    }
    const mean = sum / cnt, sd = Math.sqrt(Math.max(1e-12, sq / cnt - mean * mean));
    let second = -Infinity;
    for (let i = 0; i < n; i++) {
      const lag = lagAt(i);
      if (!valid(lag) || Math.abs(lag - bestLag) <= hz * 0.5) continue;
      if (ar[i] > second) second = ar[i];
    }
    const score = (best - mean) / sd, ratio = second > 0 ? best / second : 99;
    return { offset: bestLag / hz, score: Math.round(score * 10) / 10, ratio: Math.round(ratio * 100) / 100, ok: score >= 8 && ratio >= 1.3 };
  }

  const Sync = { fft, onsets, offset };
  if (typeof window !== 'undefined') window.Sync = Sync;
  if (typeof module !== 'undefined') module.exports = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
