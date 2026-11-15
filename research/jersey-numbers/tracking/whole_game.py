"""Whole game, one camera: people found 10 times a second, followed with the colour-gated tracker,
numbers read on each followed person about twice a second. Saves every track (boxes, shirt colour, reads)."""
import sys, json, re, time, subprocess, numpy as np, cv2
sys.path.insert(0, '.')
from det import Detector
from tracker import Tracker, torso
from rapidocr_onnxruntime import RapidOCR
S = '/tmp/claude-0/-home-user/47dfe37f-7616-582b-b52e-2b384b124f49/scratchpad/'
VID = {'L': (S + 'qs_dl/game.mp4', 1472, 720), 'R': (S + 'qs_dl2/game_r.mp4', 1280, 720)}
FPS = 10
cam = sys.argv[1]
video, W, H = VID[cam]
det = Detector('yolox_nano', threads=1)
ocr = RapidOCR(det_limit_side_len=400, det_limit_type='max', use_cls=False)
tr = Tracker(max_gap=FPS, col_gate=30.0)
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', video, '-vf', f'fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
N = W * H * 3; f = 0; t0 = time.time(); reads = {}; n_ocr = 0
while True:
    buf = p.stdout.read(N)
    if len(buf) < N: break
    fr = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
    b, sco = det(fr, 60, 2)
    b = [bb for bb, ss in zip(b, sco) if ss > 0.4 and bb[3] - bb[1] > 40]
    tr.step(f, b, fr)
    for t in tr.tracks:
        if t.last != f or (f + t.id) % 4: continue                 # each followed person about every 0.4 s
        x0, y0, x1, y1 = t.boxes[f]
        if y1 - y0 < 60: continue
        crop = torso(t.boxes[f], fr)
        if crop.size == 0: continue
        k = 240 / crop.shape[0]
        res, _ = ocr(cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)); n_ocr += 1
        for box, text, conf in (res or []):
            txt = text.strip(); cx = sum(q[0] for q in box) / 4 / (crop.shape[1] * k)
            if re.fullmatch(r'\d{1,2}', txt) and conf >= 0.6 and 0.15 <= cx <= 0.85:
                reads.setdefault(t.id, []).append([round(f / FPS, 2), txt, round(float(conf), 3), int(y1 - y0)])
    f += 1
    if f % 500 == 0: print(cam, f'{f / FPS:.0f}s of video, {time.time() - t0:.0f}s, tracks {tr.next - 1}, ocr {n_ocr}', flush=True)
out = []
for t in tr.all():
    fs = sorted(t.boxes)
    cols = [t.cols[k] for k in fs if t.cols.get(k) is not None]
    out.append(dict(id=t.id, f0=fs[0], f1=fs[-1], n=len(fs),
                    boxes={k: [round(float(v), 1) for v in t.boxes[k]] for k in fs},
                    lab=[round(float(v), 1) for v in np.median(np.array(cols), 0)] if cols else None,
                    reads=reads.get(t.id, [])))
json.dump(dict(fps=FPS, W=W, H=H, tracks=out), open(f'game_{cam}.json', 'w'))
print(cam, 'done', f, 'frames', f'{time.time() - t0:.0f}s', 'tracks', len(out), 'ocr calls', n_ocr)
