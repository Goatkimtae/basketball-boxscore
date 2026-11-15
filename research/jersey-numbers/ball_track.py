"""Where was the ball before a shot? Follows the engine's ball detections back in time from the hoop.

Input: the detections kept by the engine (app/hoopstat/engine.py: track_filter(...) of the detections that
are not on the rim) and its shot candidates (group_shots). Output of shooter_track(): the detections of one
ball, earliest first; gather() gives the index of its lowest point before the flight, which is where the
shooter held it. data/shots.json was made with these functions."""
import math

R = 22.0   # rim width in pixels of a 768-px-wide frame


def index(dets, fps=30):
    by_frame = {}
    for d in dets:
        by_frame.setdefault(round(d['t'] * fps), []).append(d)
    return by_frame


def back_from(seed, side, by_frame, span, gap=4, fps=30):
    """Step back frame by frame: the next point is the detection closest to where the motion so far predicts."""
    pos = lambda d: (d['bx'] - d['hx'], d['by'] - d['hy'])       # relative to the hoop, so camera motion drops out
    cur, pts, f0 = seed, [seed], round(seed['t'] * fps)
    f = f0
    while f0 - f < span * fps:
        v = None
        if len(pts) >= 2:
            a, b = pts[-1], pts[max(0, len(pts) - 4)]
            n = round((b['t'] - a['t']) * fps)
            if n > 0:
                v = ((pos(a)[0] - pos(b)[0]) / n, (pos(a)[1] - pos(b)[1]) / n)
        best = None
        for k in range(1, gap + 1):
            px, py = pos(cur)
            if v:
                px, py = px + v[0] * k, py + v[1] * k
            limit = (7 + 5 * k) if v else (10 + 9 * k)
            for d in by_frame.get(f - k, []):
                if d['side'] != side:
                    continue
                e = math.hypot(pos(d)[0] - px, pos(d)[1] - py)
                if e <= limit and (best is None or e < best[0]):
                    best = (e, k, d)
            if best:
                break
        if not best:
            break
        f -= best[1]
        cur = best[2]
        pts.append(cur)
    return pts[::-1]


def shooter_track(shot, kept, by_frame, span=1.6):
    """Best of several starts: the ball where it is closest to the rim, and the shot's first frames."""
    zone = [d for d in kept if d['side'] == shot.side and shot.start - 1e-6 <= d['t'] <= min(shot.end, shot.start + 1.0) + 1e-6]
    if not zone:
        return []
    near = sorted(zone, key=lambda d: math.hypot(d['bx'] - d['hx'], d['by'] - d['rim_y']))[:4]
    early = [d for d in zone if d['t'] <= shot.start + 0.3 and d['by'] < d['rim_y'] + 0.15 * d['hh'] and abs(d['bx'] - d['hx']) <= 1.6 * d['w']]
    best, score = [], -1
    for seed in near + early:
        p = back_from(seed, shot.side, by_frame, span)
        s = len(p) + 30 * max(0.0, shot.start - p[0]['t'])        # a real flight: many frames, starting well before the hoop
        if s > score:
            best, score = p, s
    return best


def gather(pts, shot):
    """Index of the ball's lowest point on the way up to the hoop (walking back from the top of the flight)."""
    end = max(range(len(pts)), key=lambda i: -pts[i]['by'] if pts[i]['t'] <= shot.start + 0.6 else -1e9)
    g, low = end, pts[end]['by']
    for i in range(end, -1, -1):
        if pts[i]['by'] >= low:
            low, g = pts[i]['by'], i
        elif low - pts[i]['by'] > 0.6 * R:
            break
    return g
