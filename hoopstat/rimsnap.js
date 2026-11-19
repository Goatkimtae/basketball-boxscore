/* Rim snap for the gym profile: the hoop picture is cut around the clicked point and the analysis takes the
   rim to be at a fixed place in it, so a click a little beside the rim loses most shots (measured: 12 px off
   at 768 px wide, 13 shots -> 4-5). snapRim() finds the rim near the click and returns its centre; with
   nothing rim-like near the click it returns the click unchanged.
   The rim is a horizontal red-orange run in a row: on a far rim the long thin part is a dull red and only the
   near end is bright, and a brown wall or a net can touch it, so rows are scanned for runs (strong reds count
   more than weak ones) instead of taking whole blobs.
   Works on RGBA pixels (canvas ImageData or a Node buffer), in the profile picture's coordinates. */
'use strict';
(function (root) {
  const SNAP = {
    RX: 30, RY: 24,          // look this far left/right and up/down of the click (px at 768 wide)
    HUE_LO: 320, HUE_HI: 35, // red-orange hue range (degrees, wraps through 0)
    STRONG: [0.35, 56],      // strong red: saturation and brightest channel (0-255) at least this
    WEAK: [0.2, 40],         // weak red
    WEAK_W: 0.3,             // a weak pixel counts this much
    GAP: 2,                  // a run may have gaps this long
    MIN_RUN: 10, MAX_RUN: 45,// rim width at 768 px: about 15-35
    MIN_STRONG: 4,           // a rim run has at least this many strong pixels
    NEAR: 10,                // score falls with distance from the click: weight / (1 + d / NEAR)
    ROWS: 3, ROW_SHARE: 0.6, // the rim's height: rows within 3 of the best whose run is at least 0.6 as long
  };

  /** 2 strong red, 1 weak red, 0 not red */
  function redLevel(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < SNAP.WEAK[1] || mx === mn) return 0;
    const s = (mx - mn) / mx;
    if (s < SNAP.WEAK[0]) return 0;
    let h;
    if (mx === r) h = (60 * (g - b)) / (mx - mn); else if (mx === g) h = 120 + (60 * (b - r)) / (mx - mn); else h = 240 + (60 * (r - g)) / (mx - mn);
    if (h < 0) h += 360;
    if (!(h >= SNAP.HUE_LO || h <= SNAP.HUE_HI)) return 0;
    return s >= SNAP.STRONG[0] && mx >= SNAP.STRONG[1] ? 2 : 1;
  }

  /** red runs of one row: [{a, b, strong, weak}] (a..b inclusive) */
  function runsOf(levels) {
    const out = [];
    let cur = null, gap = 0;
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i];
      if (v) {
        if (!cur) cur = { a: i, b: i, strong: 0, weak: 0 };
        cur.b = i; gap = 0;
        if (v === 2) cur.strong++; else cur.weak++;
      } else if (cur && ++gap > SNAP.GAP) { out.push(cur); cur = null; gap = 0; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** data: RGBA bytes of a W x H picture; (x, y): the click. Returns {x, y, snapped, moved, w} (w: rim width). */
  function snapRim(data, W, H, x, y) {
    const x0 = Math.max(0, Math.round(x - SNAP.RX)), x1 = Math.min(W - 1, Math.round(x + SNAP.RX));
    const y0 = Math.max(0, Math.round(y - SNAP.RY)), y1 = Math.min(H - 1, Math.round(y + SNAP.RY));
    const rows = [];
    for (let yy = y0; yy <= y1; yy++) {
      const lv = new Uint8Array(x1 - x0 + 1);
      for (let xx = x0; xx <= x1; xx++) { const j = (yy * W + xx) * 4; lv[xx - x0] = redLevel(data[j], data[j + 1], data[j + 2]); }
      rows.push(runsOf(lv).map((r) => ({ ...r, a: r.a + x0, b: r.b + x0, y: yy, len: r.b - r.a + 1 })));
    }
    let best = null;
    for (const list of rows) {
      for (const r of list) {
        if (r.len < SNAP.MIN_RUN || r.len > SNAP.MAX_RUN || r.strong < SNAP.MIN_STRONG) continue;
        const cx = (r.a + r.b) / 2, d = Math.hypot(cx - x, r.y - y), score = (r.strong + SNAP.WEAK_W * r.weak) / (1 + d / SNAP.NEAR);
        if (!best || score > best.score) best = { ...r, cx, score };
      }
    }
    if (!best) return { x, y, snapped: false, moved: 0, w: null };
    // the rim's height: neighbouring rows with a run over the same place
    let sy = 0, sn = 0;
    for (const list of rows) {
      for (const r of list) {
        if (Math.abs(r.y - best.y) > SNAP.ROWS || r.len < SNAP.ROW_SHARE * best.len) continue;
        if (Math.min(r.b, best.b) - Math.max(r.a, best.a) < 0.5 * best.len) continue;
        const wgt = r.strong + SNAP.WEAK_W * r.weak; sy += r.y * wgt; sn += wgt;
      }
    }
    const sx = Math.round(best.cx), sy2 = Math.round(sn ? sy / sn : best.y);
    return { x: sx, y: sy2, snapped: true, moved: Math.round(Math.hypot(sx - x, sy2 - y)), w: best.len };
  }

  const RimSnap = { SNAP, snapRim, redLevel };
  if (typeof module !== 'undefined') module.exports = RimSnap;
  else root.RimSnap = RimSnap;
})(typeof self !== 'undefined' ? self : this);
