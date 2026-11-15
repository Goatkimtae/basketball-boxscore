"""Pictures to send for each shot: three moments around where the shooter held the ball (the 'gather' point
in ../data/shots.json), cut from the full-resolution video around that spot, with the ball circled.

    python make_frames.py <left-hoop video> <right-hoop video> <output folder>

The videos are the two originals of the 2026-11-14 game (not in the repository)."""
import json, os, subprocess, sys
import cv2
import numpy as np

R = 22.0                                  # rim width in 768-px-wide coordinates
MOMENTS = (-0.3, 0.0, 0.25)               # seconds from the gather
HERE = os.path.dirname(os.path.abspath(__file__))


def grab(video, t, W, H):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{max(0.0, t):.3f}', '-i', video, '-frames:v', '1',
                          '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).copy()


def size_of(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', video], capture_output=True, text=True, check=True).stdout
    w, h = out.strip().split(',')[:2]
    return int(w), int(h)


def main(left, right, out):
    os.makedirs(os.path.join(out, 'img'), exist_ok=True)
    shots = json.load(open(os.path.join(HERE, '..', 'data', 'shots.json'), encoding='utf-8'))['shots']
    videos = {'L': (left, *size_of(left)), 'R': (right, *size_of(right))}
    meta = []
    for s in shots:
        video, W, H = videos[s['cam']]
        sc = W / 768
        gt, gx, gy = s['ball'][s['gather']]
        files = []
        for m, dt in enumerate(MOMENTS):
            t = gt + dt
            img = grab(video, t, W, H)
            near = min(s['ball'], key=lambda p: abs(p[0] - t))
            if abs(near[0] - t) <= 0.07:
                cv2.circle(img, (int(near[1] * sc), int(near[2] * sc)), int(max(14, 9 * sc)), (0, 255, 255), 2)
            cx, cy = gx * sc, gy * sc
            x0, x1 = int(max(0, cx - 7 * R * sc)), int(min(W, cx + 7 * R * sc))
            y0, y1 = int(max(0, cy - 4 * R * sc)), int(min(H, cy + 9 * R * sc))
            name = f"{s['cam']}{s['k']:02d}_{m}.jpg"
            cv2.imwrite(os.path.join(out, 'img', name), img[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 90])
            files.append(name)
        meta.append(dict(cam=s['cam'], k=s['k'], start=s['start'], files=files))
        print(s['cam'], s['k'], files, flush=True)
    json.dump(meta, open(os.path.join(out, 'frames.json'), 'w'))


if __name__ == '__main__':
    main(*sys.argv[1:4])
