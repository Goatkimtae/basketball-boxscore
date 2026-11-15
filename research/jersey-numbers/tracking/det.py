"""YOLOX person detector (Apache-2.0 models from the YOLOX releases), frame split into tiles."""
import numpy as np, cv2, onnxruntime as ort
M = '/tmp/claude-0/-home-user/47dfe37f-7616-582b-b52e-2b384b124f49/scratchpad/yolox/'
class Detector:
    def __init__(self, name='yolox_tiny', threads=1):
        so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
        self.s = ort.InferenceSession(M + name + '.onnx', so, providers=['CPUExecutionProvider'])
        self.size = self.s.get_inputs()[0].shape[2]
        grids, strides = [], []
        for st in (8, 16, 32):
            n = self.size // st
            yv, xv = np.meshgrid(np.arange(n), np.arange(n), indexing='ij')
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2)); strides.append(np.full((n * n, 1), st))
        self.grid = np.concatenate(grids).astype(np.float32); self.stride = np.concatenate(strides).astype(np.float32)
    def _run(self, img):
        S = self.size; h, w = img.shape[:2]; r = min(S / h, S / w)
        pad = np.full((S, S, 3), 114, np.uint8)
        pad[:int(h * r), :int(w * r)] = cv2.resize(img, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        x = pad.transpose(2, 0, 1)[None].astype(np.float32)
        o = self.s.run(None, {'images': x})[0][0]
        xy = (o[:, :2] + self.grid) * self.stride; wh = np.exp(o[:, 2:4]) * self.stride
        score = o[:, 4] * o[:, 5]                                   # objectness x person class
        keep = score > 0.25
        b = np.concatenate([xy[keep] - wh[keep] / 2, xy[keep] + wh[keep] / 2], 1) / r
        return b, score[keep]
    def __call__(self, frame, y0=0, tiles=2, overlap=0.15):
        H, W = frame.shape[:2]; img = frame[y0:]
        tw = int(W / (tiles - (tiles - 1) * overlap)) if tiles > 1 else W
        boxes, scores = [], []
        for i in range(tiles):
            x0 = 0 if tiles == 1 else int(i * (W - tw) / (tiles - 1))
            b, s = self._run(img[:, x0:x0 + tw])
            b[:, [0, 2]] += x0; b[:, [1, 3]] += y0
            boxes.append(b); scores.append(s)
        b = np.concatenate(boxes); s = np.concatenate(scores)
        if not len(b): return np.zeros((0, 4)), np.zeros(0)
        idx = cv2.dnn.NMSBoxes(b[:, :2].tolist() and [[float(x0), float(y0_), float(x1 - x0), float(y1 - y0_)] for x0, y0_, x1, y1 in b], s.tolist(), 0.3, 0.5)
        idx = np.array(idx).reshape(-1)
        return b[idx], s[idx]
