"""Video analysis: hoop tracking, ball detection, shot candidates and made/missed estimate.

All image work happens on frames resized to PROC_W pixels wide, so the thresholds below
do not depend on the source resolution.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

PROC_W = 768                     # processing width (px)
TW, TH = 84, 70                  # hoop template size at PROC_W
RIM_DY = 0.30                    # rim centre sits this far (x TH) below the template centre
SCALES = (0.8, 0.9, 1.0, 1.1, 1.25)
HOOP_THR = 0.65                  # template match score that counts as "hoop visible"
SEARCH_TOP = 0.65                # hoops are searched in the top part of the frame only

# ball = orange and moving (camera motion removed by aligning on the hoop)
# Ball hue sits around 0-14 (red-orange) on compressed phone video; decoders differ by a few
# hue steps, so the range wraps through red. Size and shape filters keep jerseys out.
BALL_HSV_RANGES = (((0, 100, 70), (22, 255, 255)), ((176, 100, 70), (180, 255, 255)))
BALL_AREA = (12, 160)
BALL_BLUR = 0                    # Gaussian blur (px) before the colour test; 0 = off

SIDES = ("왼쪽", "오른쪽")


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- profile
@dataclass
class GymProfile:
    """Templates of the two hoops of one gym. Made once from two clicks, reused for every video."""
    name: str
    templates: dict = field(default_factory=dict)   # side -> gray uint8 array (TH x TW)

    def save(self, folder: str) -> str:
        path = os.path.join(folder, self.name)
        os.makedirs(path, exist_ok=True)
        for side, tpl in self.templates.items():
            ok, buf = cv2.imencode(".png", tpl)   # cv2.imwrite cannot write Korean paths on Windows
            if not ok:
                raise IOError("골대 그림을 저장하지 못했습니다.")
            buf.tofile(os.path.join(path, f"{'left' if side == '왼쪽' else 'right'}.png"))
        with open(os.path.join(path, "profile.json"), "w", encoding="utf-8") as fh:
            json.dump({"name": self.name, "sides": list(self.templates)}, fh, ensure_ascii=False)
        return path

    @classmethod
    def load(cls, path: str) -> "GymProfile":
        with open(os.path.join(path, "profile.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        tpls = {}
        for side in meta.get("sides", SIDES):
            f = os.path.join(path, f"{'left' if side == '왼쪽' else 'right'}.png")
            img = cv2.imdecode(np.fromfile(f, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            if img is not None:
                tpls[side] = img
        return cls(meta["name"], tpls)

    @staticmethod
    def template_from_click(frame_proc: np.ndarray, rim_x: float, rim_y: float) -> np.ndarray:
        """frame_proc: BGR frame at PROC_W. (rim_x, rim_y): the rim centre the user clicked."""
        g = cv2.cvtColor(frame_proc, cv2.COLOR_BGR2GRAY)
        cx, cy = rim_x, rim_y - RIM_DY * TH
        x0 = int(round(np.clip(cx - TW / 2, 0, g.shape[1] - TW)))
        y0 = int(round(np.clip(cy - TH / 2, 0, g.shape[0] - TH)))
        return g[y0:y0 + TH, x0:x0 + TW].copy()


# ---------------------------------------------------------------- video
def opencv_path(path: str) -> str:
    """OpenCV on Windows cannot open file names with Korean (non-ASCII) characters.
    Use the short 8.3 name, or else a hard link / copy in an ASCII-named folder."""
    if os.name != "nt" or path.isascii():
        return path
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buf, 32768) and buf.value.isascii():
            return buf.value
    except (AttributeError, OSError):
        pass
    import hashlib
    import shutil
    import tempfile
    st = os.stat(path)
    tag = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}".encode("utf-8")).hexdigest()[:12]
    name = f"hoopstat_{tag}{os.path.splitext(path)[1] if os.path.splitext(path)[1].isascii() else '.mp4'}"
    folders = [tempfile.gettempdir(), os.environ.get("PUBLIC", ""), os.path.join(os.environ.get("SystemDrive", "C:") + os.sep, "HoopStatTemp")]
    for d in folders:
        if not d or not d.isascii():
            continue
        try:
            os.makedirs(d, exist_ok=True)
            target = os.path.join(d, name)
            if not os.path.exists(target):
                try:
                    os.link(path, target)
                except OSError:
                    shutil.copyfile(path, target)
            return target
        except OSError:
            continue
    return path


class Video:
    def __init__(self, path: str):
        self.path = opencv_path(path)
        self.original_path = path
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise IOError(f"영상을 열 수 없습니다: {path}")
        self.fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        w = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or PROC_W
        h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or PROC_W * 9 / 16
        self.scale = PROC_W / w
        self.proc_size = (PROC_W, int(round(h * self.scale)))
        self.duration = self.frames / self.fps if self.frames else 0.0
        cap.release()

    def _prep(self, f):
        return cv2.resize(f, self.proc_size, interpolation=cv2.INTER_AREA) if f.shape[1] != PROC_W else f

    def iter(self, step: int = 1, progress=None, cancel=None, label: str = ""):
        cap = cv2.VideoCapture(self.path)
        i = 0
        while True:
            ok = cap.grab()
            if not ok:
                break
            if i % step == 0:
                ok, f = cap.retrieve()
                if not ok:
                    break
                t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 or i / self.fps
                yield i, t, self._prep(f)
                if cancel is not None and cancel():
                    cap.release()
                    raise Cancelled()
                if progress is not None and self.frames and i % 30 == 0:
                    progress(label, i / self.frames)
            i += 1
        cap.release()

    def frame_at(self, t: float):
        cap = cv2.VideoCapture(self.path)
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, f = cap.read()
        cap.release()
        return self._prep(f) if ok else None


# ---------------------------------------------------------------- hoops
def track_hoops(video: Video, profile: GymProfile, step: int = 2, progress=None, cancel=None) -> np.ndarray:
    """Rows: t, then for 왼쪽 and 오른쪽: score, centre x, centre y, scale."""
    tpls = {s: profile.templates[s] for s in SIDES if s in profile.templates}
    scaled = {s: [(sc, cv2.resize(t, None, fx=sc, fy=sc)) for sc in SCALES] for s, t in tpls.items()}
    top = int(video.proc_size[1] * SEARCH_TOP)
    rows = []
    for _, t, f in video.iter(step, progress, cancel, "골대 찾는 중"):
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)[:top]
        rec = [t]
        for s in SIDES:
            best = (-1.0, 0.0, 0.0, 1.0)
            for sc, tt in scaled.get(s, []):
                if tt.shape[0] >= g.shape[0] or tt.shape[1] >= g.shape[1]:
                    continue
                r = cv2.matchTemplate(g, tt, cv2.TM_CCOEFF_NORMED)
                _, mx, _, loc = cv2.minMaxLoc(r)
                if mx > best[0]:
                    best = (float(mx), loc[0] + tt.shape[1] / 2, loc[1] + tt.shape[0] / 2, sc)
            rec += list(best)
        rows.append(rec)
    return np.array(rows, dtype=float) if rows else np.zeros((0, 9))


def hoop_at(hoops: np.ndarray, t: float):
    """(side, x, y, scale) of the hoop in view at time t, or None."""
    if not len(hoops):
        return None
    h = hoops[int(np.argmin(np.abs(hoops[:, 0] - t)))]
    left, right = h[1:5], h[5:9]
    cand = [(s, v) for s, v in (("왼쪽", left), ("오른쪽", right)) if v[0] >= HOOP_THR]
    if not cand:
        return None
    s, v = max(cand, key=lambda c: c[1][0])
    return s, v[1], v[2], v[3]


def hoop_visibility(hoops: np.ndarray) -> dict:
    out = {"왼쪽": 0, "오른쪽": 0, "없음": 0}
    for h in hoops:
        l, r = h[1] >= HOOP_THR, h[5] >= HOOP_THR
        out["왼쪽" if l and (not r or h[1] >= h[5]) else "오른쪽" if r else "없음"] += 1
    n = max(1, len(hoops))
    return {k: v / n for k, v in out.items()}


# ---------------------------------------------------------------- ball
def detect_ball(video: Video, hoops: np.ndarray, progress=None, cancel=None) -> list[dict]:
    """Orange, moving blobs near the hoop, in every frame where a hoop is visible."""
    hist = []
    dets = []
    for _, t, f in video.iter(1, progress, cancel, "공 찾는 중"):
        hp = hoop_at(hoops, t)
        hist.append((t, f, hp))
        hist = hist[-3:]
        if hp is None or len(hist) < 3 or hist[0][2] is None or hist[0][2][0] != hp[0]:
            continue
        side, hx, hy, hs = hp
        w, hh = TW * hs, TH * hs
        rim_y = hy + RIM_DY * hh
        x0, x1 = int(max(0, hx - 2.2 * w)), int(min(f.shape[1], hx + 2.2 * w))
        y0, y1 = 0, int(min(f.shape[0], rim_y + 1.4 * hh))
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        pf, php = hist[0][1], hist[0][2]
        m = np.float32([[1, 0, hx - php[1]], [0, 1, hy - php[2]]])
        prev = cv2.warpAffine(pf, m, (f.shape[1], f.shape[0]), borderMode=cv2.BORDER_REPLICATE)
        cur, prv = f[y0:y1, x0:x1], prev[y0:y1, x0:x1]
        hsv = cv2.cvtColor(cv2.GaussianBlur(cur, (BALL_BLUR, BALL_BLUR), 0) if BALL_BLUR else cur, cv2.COLOR_BGR2HSV)
        orange = cv2.inRange(hsv, *BALL_HSV_RANGES[0])
        for lo, hi in BALL_HSV_RANGES[1:]:
            orange |= cv2.inRange(hsv, lo, hi)
        diff = cv2.absdiff(cv2.cvtColor(cur, cv2.COLOR_BGR2GRAY), cv2.cvtColor(prv, cv2.COLOR_BGR2GRAY))
        moving = cv2.dilate((diff > 20).astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
        mask = cv2.morphologyEx(cv2.bitwise_and(orange, moving), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        n, _, st, cen = cv2.connectedComponentsWithStats(mask)
        for k in range(1, n):
            bx, by, bw, bh, area = st[k]
            if not (BALL_AREA[0] <= area <= BALL_AREA[1]) or not (0.5 <= bw / max(bh, 1) <= 2.0):
                continue
            fill = area / float(bw * bh)
            if fill < 0.45:
                continue
            dets.append(dict(t=round(t, 3), side=side, fill=round(float(fill), 2), bx=float(x0 + cen[k][0]), by=float(y0 + cen[k][1]),
                             bw=float(bw), hx=float(hx), hy=float(hy), rim_y=float(rim_y), w=float(w), hh=float(hh)))
    return dets



def track_filter(dets: list[dict], max_gap: float = 0.12, step_px: float = 20.0, min_len: int = 4, min_move: float = 10.0) -> list[dict]:
    """Keep detections that form a moving chain over consecutive frames. Decoder colour noise
    (jersey edges, the red rim) appears as isolated or static blobs; a ball in flight moves smoothly."""
    ds = sorted(dets, key=lambda d: d["t"])
    by_t: dict = {}
    for d in ds:
        by_t.setdefault(d["t"], []).append(d)
    times = sorted(by_t)
    prev: dict = {}
    used: set = set()
    for ti, t in enumerate(times):
        cands = []
        for t2 in times[max(0, ti - 4):ti]:
            if t - t2 > max_gap:
                continue
            frames = max(1, int(math.floor((t - t2) * 30 + 0.5)))
            for a in by_t[t2]:
                for b in by_t[t]:
                    if a["side"] != b["side"]:
                        continue
                    dist = math.hypot(a["bx"] - b["bx"], a["by"] - b["by"])
                    if dist <= step_px * frames:
                        cands.append((dist / frames, a, b))
        cands.sort(key=lambda c: c[0])
        taken_a, taken_b = set(), set()
        for _, a, b in cands:
            if id(a) in taken_a or id(b) in taken_b or id(a) in used:
                continue
            prev[id(b)] = a
            taken_a.add(id(a)); taken_b.add(id(b)); used.add(id(a))
    keep = []
    for h in ds:
        if id(h) in used:
            continue                      # not a chain end
        chain, d = [], h
        while d is not None:
            chain.append(d)
            d = prev.get(id(d))
        if len(chain) < min_len:
            continue
        xs = [c["bx"] for c in chain]
        ys = [c["by"] for c in chain]
        if max(max(xs) - min(xs), max(ys) - min(ys)) < min_move:
            continue
        keep.extend(chain)
    return keep

# ---------------------------------------------------------------- shots
@dataclass
class ShotCandidate:
    start: float
    end: float
    side: str
    frames: int
    made: bool = False
    made_t: float | None = None
    confidence: str = "낮음"


def group_shots(dets: list[dict], gap: float = 0.7, split: float = 20.0, merge_gap: float = 0.5,
                min_frames: int = 4, max_dx: float = 1.0) -> list[ShotCandidate]:
    """Ball frames at or above rim height near the hoop -> one candidate per flight.
    A fall of `split` px followed by a rise of `split` px starts a new flight (a put-back)."""
    z = {}
    for d in dets:
        if d["by"] < d["rim_y"] + 0.15 * d["hh"] and abs(d["bx"] - d["hx"]) <= 1.6 * d["w"]:
            if d["t"] not in z or d["fill"] > z[d["t"]]["fill"]:
                z[d["t"]] = d
    pts = sorted(z.values(), key=lambda d: d["t"])
    groups: list[list[dict]] = []
    for d in pts:
        if groups and groups[-1][-1]["side"] == d["side"] and d["t"] - groups[-1][-1]["t"] <= gap:
            groups[-1].append(d)
        else:
            groups.append([d])
    events: list[list[dict]] = []
    for g in groups:
        cur = [g[0]]
        apex = g[0]["by"] - g[0]["rim_y"]
        fell, bottom = False, None
        for d in g[1:]:
            y = d["by"] - d["rim_y"]
            if not fell:
                apex = min(apex, y)
                if y - apex >= split:
                    fell, bottom = True, y
            elif y > bottom:
                bottom = y
            elif bottom - y >= split:
                events.append(cur)
                cur, apex, fell = [], y, False
            cur.append(d)
        events.append(cur)
    events = [e for e in events if e]
    # a flight that starts right after another on the same hoop, close to the rim, is the ball
    # bouncing off the rim or backboard: same attempt
    merged: list[list[dict]] = []
    for e in events:
        prev = merged[-1] if merged else None
        first = e[0]
        if (prev and prev[-1]["side"] == first["side"] and first["t"] - prev[-1]["t"] <= merge_gap
                and abs(first["bx"] - first["hx"]) <= 0.6 * first["w"]
                and abs(first["by"] - first["rim_y"]) <= 0.8 * first["hh"]):
            prev.extend(e)
        else:
            merged.append(list(e))
    out = []
    for e in merged:
        min_dx = min(abs(d["bx"] - d["hx"]) / d["w"] for d in e)
        # a shot gets near the rim; a pass or dribble that only crosses the hoop area does not
        if len(e) < min_frames or min_dx > max_dx:
            continue
        out.append(ShotCandidate(e[0]["t"], e[-1]["t"], e[0]["side"], len(e)))
    return out


def on_rim(d: dict) -> bool:
    """Blobs sitting on the rim: the orange rim 'moves' when the camera shakes or the net sways."""
    return abs(d["bx"] - d["hx"]) <= 0.35 * d["w"] and d["rim_y"] - 0.1 * d["hh"] <= d["by"] <= d["rim_y"] + 0.06 * d["hh"]


MADE = dict(x=0.3, start=0.3, end=0.6, gap=0.07, span=0.4, step_x=0.25)


def judge_made(shots: list[ShotCandidate], dets: list[dict], window: float = 2.5) -> None:
    """Made = the ball is followed falling through the hoop: detections frame after frame (gaps up to
    0.07 s) from just under the rim (0.3 x hoop height) down to 0.6 x hoop height within 0.4 s, near the
    rim centre. A swaying net moves about but does not fall steadily. Same rule as the web app."""
    by_side = {s: sorted((d for d in dets if d["side"] == s), key=lambda d: d["t"]) for s in SIDES}
    dy = lambda d: (d["by"] - d["rim_y"]) / d["hh"]
    for i, sh in enumerate(shots):
        nxt = shots[i + 1].start if i + 1 < len(shots) and shots[i + 1].side == sh.side else math.inf
        t_end = min(sh.end + window, nxt + 0.2)
        ds = [d for d in by_side[sh.side] if sh.start - 0.1 <= d["t"] <= t_end
              and abs(d["bx"] - d["hx"]) <= MADE["x"] * d["w"] and 0 < dy(d) <= 1.3]
        hit, steps = None, 0
        for a in range(len(ds)):
            if hit or dy(ds[a]) > MADE["start"]:
                continue
            cur, n = ds[a], 0
            for d in ds[a + 1:]:
                if d["t"] - ds[a]["t"] > MADE["span"]:
                    break
                if 0 < d["t"] - cur["t"] <= MADE["gap"] and dy(d) > dy(cur) and abs(d["bx"] - cur["bx"]) <= MADE["step_x"] * cur["w"]:
                    cur, n = d, n + 1
                    if dy(cur) >= MADE["end"]:
                        hit, steps = ds[a], n
                        break
        sh.made = hit is not None
        sh.made_t = hit["t"] if hit else None
        sh.confidence = "보통" if hit and steps >= 3 else "낮음"


# ---------------------------------------------------------------- whole pipeline
def analyze(video_path: str, profile: GymProfile, progress=None, cancel=None) -> dict:
    video = Video(video_path)
    stage = {"n": 0}

    def prog(label, frac, base=0.0, span=1.0):
        if progress:
            progress(label, base + span * frac)

    hoops = track_hoops(video, profile, 2, lambda l, f: prog(l, f, 0.0, 0.6), cancel)
    dets = detect_ball(video, hoops, lambda l, f: prog(l, f, 0.6, 0.4), cancel)
    dets = track_filter([d for d in dets if not on_rim(d)])
    shots = group_shots(dets)
    judge_made(shots, dets)
    if progress:
        progress("완료", 1.0)
    del stage
    return {
        "video": video_path,
        "duration": video.duration,
        "visibility": hoop_visibility(hoops),
        "shots": shots,
        "ball_frames": len(dets),
    }
