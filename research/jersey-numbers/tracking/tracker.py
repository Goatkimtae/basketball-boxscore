"""Simple multi-person tracker: predicted box overlap + shirt colour, Hungarian matching."""
import numpy as np, cv2
from scipy.optimize import linear_sum_assignment
def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    i = max(0, x1 - x0) * max(0, y1 - y0)
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9)
def torso(box, frame):
    x0, y0, x1, y1 = [int(v) for v in box]; h = y1 - y0; w = x1 - x0
    return frame[max(0, y0 + int(0.15 * h)):max(1, y0 + int(0.55 * h)), max(0, x0 + int(0.2 * w)):max(1, x1 - int(0.2 * w))]
def lab(box, frame):
    """median shirt colour (Lab) of the torso"""
    t = torso(box, frame)
    if t.size == 0: return None
    return np.median(cv2.cvtColor(t, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(float), 0)
def hist(box, frame):
    t = torso(box, frame)
    if t.size == 0: return None
    hsv = cv2.cvtColor(t, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    return cv2.normalize(h, h).flatten()
class Track:
    def __init__(self, tid, box, f, hst, col=None):
        self.id, self.box, self.v, self.last, self.hist = tid, np.array(box, float), np.zeros(2), f, hst
        self.col = col; self.cols = {f: col}
        self.hist_n = 1; self.boxes = {f: tuple(box)}
    def pred(self, f):
        d = (f - self.last) * self.v
        return self.box + np.array([d[0], d[1], d[0], d[1]])
class Tracker:
    def __init__(self, max_gap=15, col_gate=30.0):
        self.tracks, self.dead, self.next, self.max_gap, self.col_gate = [], [], 1, max_gap, col_gate
    def step(self, f, boxes, frame):
        hs = [hist(b, frame) for b in boxes]
        cs = [lab(b, frame) for b in boxes]
        T = self.tracks
        if T and len(boxes):
            C = np.full((len(T), len(boxes)), 9.0)
            for i, t in enumerate(T):
                p = t.pred(f); ph = p[3] - p[1]
                for j, b in enumerate(boxes):
                    u = iou(p, b)
                    cd = np.hypot((p[0] + p[2] - b[0] - b[2]) / 2, (p[1] + p[3] - b[1] - b[3]) / 2)
                    if u < 0.1 and cd > 0.6 * ph: continue
                    if not 0.6 < (b[3] - b[1]) / max(1, ph) < 1.6: continue
                    # a different shirt colour is a different player (teams differ by colour)
                    if t.col is not None and cs[j] is not None and np.linalg.norm(t.col - cs[j]) > self.col_gate: continue
                    hd = cv2.compareHist(t.hist, hs[j], cv2.HISTCMP_BHATTACHARYYA) if t.hist is not None and hs[j] is not None else 0.5
                    C[i, j] = (1 - u) + 0.8 * hd
            ri, ci = linear_sum_assignment(C)
        else:
            ri, ci = [], []
        used = set()
        for i, j in zip(ri, ci):
            if C[i, j] > 1.4: continue
            t = T[i]; b = np.array(boxes[j], float)
            dt = f - t.last
            c_new = (b[:2] + b[2:]) / 2; c_old = (t.box[:2] + t.box[2:]) / 2
            t.v = 0.6 * t.v + 0.4 * (c_new - c_old) / dt
            t.box, t.last = b, f; t.boxes[f] = tuple(boxes[j]); t.cols[f] = cs[j]
            if cs[j] is not None: t.col = cs[j] if t.col is None else 0.85 * t.col + 0.15 * cs[j]
            if hs[j] is not None:
                t.hist = (t.hist * min(t.hist_n, 20) + hs[j]) / (min(t.hist_n, 20) + 1); t.hist_n += 1
            used.add(j)
        for j, b in enumerate(boxes):
            if j not in used:
                self.tracks.append(Track(self.next, b, f, hs[j], cs[j])); self.next += 1
        alive = []
        for t in self.tracks:
            (alive if f - t.last <= self.max_gap else self.dead).append(t)
        self.tracks = alive
    def all(self):
        return self.tracks + self.dead
