"""For each labelled shot: track people from 10 s before the gather to 4 s after, pick the person holding
the ball at the gather, read numbers on that person's shirt along the track, vote."""
import sys, json, re, time, subprocess, math, pickle, numpy as np, cv2
sys.path.insert(0, '.')
from det import Detector
from tracker import Tracker, torso
from rapidocr_onnxruntime import RapidOCR
S = '/tmp/claude-0/-home-user/47dfe37f-7616-582b-b52e-2b384b124f49/scratchpad/'
VID = {'L': (S + 'qs_dl/game.mp4', 1472, 720), 'R': (S + 'qs_dl2/game_r.mp4', 1280, 720)}
FPS, BEFORE, AFTER = 15, 10.0, 4.0
cam = sys.argv[1]
shots = [s for s in json.load(open('/home/user/basketball-boxscore/research/jersey-numbers/data/shots.json'))['shots'] if s['cam'] == cam]
det = Detector('yolox_nano', threads=1)
ocr = RapidOCR(det_limit_side_len=400, det_limit_type='max', use_cls=False)
video, W, H = VID[cam]; sc = W / 768
out = []
for s in shots:
    t0 = time.time()
    g_t, g_x, g_y = s['ball'][s['gather']]
    start = max(0.0, g_t - BEFORE)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-i', video, '-t', f'{BEFORE + AFTER:.2f}', '-vf', f'fps={FPS}',
                          '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
    tr = Tracker(max_gap=int(1.0 * FPS))
    for f, fr in enumerate(frames):
        b, sco = det(fr, 60, 2)
        b = [bb for bb, ss in zip(b, sco) if ss > 0.4 and bb[3] - bb[1] > 40]
        tr.step(f, b, fr)
    gf = int(round((g_t - start) * FPS))
    balls = [(int(round((bt - start) * FPS)), bx_ * sc, by_ * sc) for bt, bx_, by_ in s['ball'] if -0.25 <= bt - g_t <= 0.3]
    if not balls: balls = [(gf, g_x * sc, g_y * sc)]
    score = {}
    for t in tr.all():
        for bf, bx, by in balls:
            fb = min(t.boxes, key=lambda k: abs(k - bf))
            if abs(fb - bf) > 2: continue
            x0, y0, x1, y1 = t.boxes[fb]; h = y1 - y0; w = x1 - x0
            if x0 - 0.3 * w <= bx <= x1 + 0.3 * w and y0 - 0.35 * h <= by <= y0 + 0.75 * h:
                # closer to the box centre line and nearer the head counts more
                score[t.id] = score.get(t.id, 0) + 1 - 0.5 * min(1, abs(bx - (x0 + x1) / 2) / w)
    cand = [(-v, t) for t in tr.all() for k, v in score.items() if t.id == k]
    rec = dict(cam=cam, k=s['k'], label=s['shooter'], n_frames=len(frames), n_tracks=len(tr.all()), reads=[], track_frames=0, cands=len(cand))
    if cand:
        t = min(cand, key=lambda c: c[0])[1]
        rec['track_frames'] = len(t.boxes); rec['track_span'] = [round(start + min(t.boxes) / FPS, 2), round(start + max(t.boxes) / FPS, 2)]
        for f in sorted(t.boxes)[::2]:
            x0, y0, x1, y1 = t.boxes[f]; h = y1 - y0
            if h < 60: continue
            crop = torso(t.boxes[f], frames[f])
            if crop.size == 0: continue
            k = 240 / crop.shape[0]
            big = cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
            res, _ = ocr(big)
            for box, text, conf in (res or []):
                txt = text.strip()
                cx = sum(p[0] for p in box) / 4 / big.shape[1]
                if re.fullmatch(r'\d{1,2}', txt) and conf >= 0.6 and 0.15 <= cx <= 0.85:
                    rec['reads'].append([round(start + f / FPS, 2), txt, round(float(conf), 3), int(h)])
        col = t.cols.get(min(t.cols, key=lambda k: abs(k - gf)))
        rec['lab'] = [round(float(v), 1) for v in col] if col is not None else None
        keep = sorted(t.boxes)[:: max(1, len(t.boxes) // 8)]
        rec['thumbs'] = [(round(start + f / FPS, 2), [float(v) for v in t.boxes[f]]) for f in keep]
        pickle.dump([(f, frames[f][max(0, int(t.boxes[f][1])):int(t.boxes[f][3]), max(0, int(t.boxes[f][0])):int(t.boxes[f][2])].copy()) for f in keep],
                    open(f"thumbs_{cam}{s['k']:02d}.pkl", 'wb'))
    votes = {}
    for _, txt, conf, _ in rec['reads']: votes[txt] = votes.get(txt, 0) + conf
    rec['votes'] = dict(sorted(votes.items(), key=lambda kv: -kv[1]))
    out.append(rec)
    print(cam, s['k'], 'label', s['shooter'], 'cands', len(cand), 'track', rec['track_frames'], 'frames', rec.get('track_span'), 'votes', rec['votes'], f'{time.time() - t0:.0f}s', flush=True)
    json.dump(out, open(f'shooter2_{cam}.json', 'w'))
