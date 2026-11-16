/* Shared helpers for the HoopStat harness: config, OpenCV.js / ONNX Runtime in Node, frames from ffmpeg,
   labels. Every script loads the app's own files from hoopstat/, so what is measured is what ships. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'hoopstat');
const WORK = path.join(ROOT, '_workspace');

/** harness/config.json (not in git: it holds local paths). See config.example.json. */
function config() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error('harness/config.json is missing. Copy harness/config.example.json to harness/config.json and fill in where the game videos are.');
  }
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [key, v] of Object.entries(c.videos || {})) v.key = key;
  return c;
}
/** a video entry by key, or an ad-hoc entry for a file path */
function video(keyOrPath, extra = {}) {
  const c = fs.existsSync(path.join(__dirname, 'config.json')) ? config() : { videos: {} };
  const v = c.videos[keyOrPath] || { key: path.basename(keyOrPath).replace(/\.[^.]+$/, ''), path: keyOrPath };
  Object.assign(v, extra);
  if (!fs.existsSync(v.path)) throw new Error(`video not found: ${v.path} (key ${v.key}). Fix harness/config.json or download it again.`);
  return v;
}
const rel = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const out = (...parts) => { const p = path.join(WORK, ...parts); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };

/** displayed size and duration of a video */
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json', file], { encoding: 'utf8' });
  if (r.status) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout), s = j.streams[0];
  const rot = Math.abs(Number(((s.side_data_list || [])[0] || {}).rotation || 0)) % 180;
  return { W: rot ? s.height : s.width, H: rot ? s.width : s.height, duration: Number(j.format.duration) };
}

/** RGBA frames of [t0, t0 + dur) at `fps`, scaled to width `w` (or full size), one Buffer per frame.
    ffmpeg's -ss before -i is frame-accurate when decoding (OpenCV seeking is not: up to 1 s early on HEVC). */
function grab(file, { t0 = 0, dur = null, fps = null, w = null, frames = null } = {}) {
  const { W, H } = probe(file);
  const ow = w || W, oh = w ? Math.round((H * w) / W) : H;
  const vf = [fps ? `fps=${fps}` : null, w ? `scale=${ow}:${oh}` : null].filter(Boolean).join(',');
  const args = ['-v', 'error', '-ss', t0.toFixed(3), '-i', file, ...(dur ? ['-t', dur.toFixed(3)] : []), ...(frames ? ['-frames:v', String(frames)] : []),
    ...(vf ? ['-vf', vf] : []), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  const r = spawnSync('ffmpeg', args, { maxBuffer: 2 ** 31 });
  const n = ow * oh * 4, list = [];
  for (let o = 0; o + n <= r.stdout.length; o += n) list.push(r.stdout.subarray(o, o + n));
  return { frames: list, W: ow, H: oh };
}

/** frames streamed one at a time (whole videos): onFrame(buffer, index) may be async */
function stream(file, { fps = 30, w = null } = {}, onFrame) {
  const { W, H } = probe(file);
  const ow = w || W, oh = w ? Math.round((H * w) / W) : H, n = ow * oh * 4;
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps}${w ? `,scale=${ow}:${oh}` : ''}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    // collect pieces and join them once per frame (joining on every piece copies megabytes each time)
    let parts = [], len = 0, k = 0, pending = 0, chain = Promise.resolve();
    ff.stdout.on('data', (d) => {
      parts.push(d); len += d.length;
      while (len >= n) {
        const all = Buffer.concat(parts, len), fr = Buffer.from(all.subarray(0, n));
        parts = len > n ? [all.subarray(n)] : []; len -= n;
        const i = k++; pending++;
        chain = chain.then(() => onFrame(fr, i)).then(() => { pending--; });
      }
      if (pending > 30) { ff.stdout.pause(); chain.then(() => ff.stdout.resume()); }
    });
    ff.on('error', reject);
    ff.on('close', () => chain.then(() => resolve({ frames: k, W: ow, H: oh }), reject));
  });
}

let cvP = null;
/** OpenCV.js (the app's copy) as the global `cv`, as the app's code expects. Resolves to nothing: the cv object
    is "thenable", so returning it from a promise would make the promise adopt it again and again (a hang). */
function loadCv() {
  if (!cvP) {
    cvP = new Promise((resolve) => {
      const cv = require(path.join(APP, 'vendor/opencv.js'));
      const ready = (c) => { global.cv = c && c.Mat ? c : cv; delete global.cv.then; resolve(); };
      if (cv.Mat) ready(cv); else if (typeof cv.then === 'function') cv.then(ready); else cv.onRuntimeInitialized = () => ready(cv);
    });
  }
  return cvP;
}
/** ONNX Runtime Web (wasm, one thread: as in the app's workers) as a global */
function loadOrt() {
  const ort = require(path.join(__dirname, 'node_modules/onnxruntime-web/dist/ort.node.min.js'));
  ort.env.wasm.numThreads = 1;
  global.ort = ort;
  return ort;
}
/** the players-stage models from the app's vendor folder */
async function playersModels() {
  await loadCv(); const ort = loadOrt();
  const P = require(path.join(APP, 'players.js'));
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const m = (name) => ort.InferenceSession.create(fs.readFileSync(path.join(APP, 'vendor/models', `${name}.onnx`)), opt);
  return { P, detector: new P.PersonDetector(await m('person')), reader: new P.NumberReader(await m('text-det'), await m('text-rec')) };
}
/** a gym-profile template file -> {side: {w, h, data: Uint8Array}} */
function template(file) {
  const t = JSON.parse(fs.readFileSync(rel(file), 'utf8'));
  for (const k in t) t[k].data = new Uint8Array(t[k].data);
  return t;
}

/** hand labels of the shooters (research/jersey-numbers/data/shots.json), for camera 'L' or 'R' */
function shooterLabels(cam) {
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'research/jersey-numbers/data/shots.json'), 'utf8')).shots;
  return cam ? all.filter((s) => s.cam === cam) : all;
}

const args = (argv = process.argv.slice(2)) => {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(argv[i]);
  }
  return o;
};
const save = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); return file; };
const load = (file) => JSON.parse(fs.readFileSync(rel(file), 'utf8'));

module.exports = { ROOT, APP, WORK, config, video, rel, out, probe, grab, stream, loadCv, loadOrt, playersModels, template, shooterLabels, args, save, load };
