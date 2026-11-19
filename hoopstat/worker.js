/* Analysis worker: reads the video file piece by piece, decodes every frame with WebCodecs and runs
   the engine; the sound track is decoded alongside for whistles and for lining up two cameras. */
'use strict';
importScripts('vendor/opencv.js', 'vendor/mp4box.all.min.js', 'engine.js', 'demux.js');

const cvReady = (async () => {
  if (self.cv instanceof Promise) self.cv = await self.cv;
  else if (!self.cv.Mat) await new Promise((r) => { self.cv.onRuntimeInitialized = r; });
})();

class UserError extends Error {}

function description(trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);   // drop the box header
    }
  }
  return undefined;
}

function rotationOf(track) {
  const m = track.matrix;
  if (!m || m.length < 5) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

const CODEC_NAMES = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC(H.265)', hev1: 'HEVC(H.265)', vp09: 'VP9', av01: 'AV1' };

/* Sound: decoded as it is read. finish() -> {status: 'ok' | 'none' | 'unsupported', list: whistles [{t, dur, f}],
   env: loudness envelope (Float32Array, 100 per second) or null, envStart: time of its first value} */
async function audioPipe(mp4, audio) {
  const none = (status) => ({ push() {}, finish: async () => ({ status, list: [], env: null, envStart: 0 }) });
  if (!audio) return none('none');
  if (typeof AudioDecoder === 'undefined') return none('unsupported');
  const entry = mp4.getTrackById(audio.id).mdia.minf.stbl.stsd.entries[0];
  let codec = audio.codec, desc;
  if (/^mp4a/i.test(codec)) {
    const dcd = entry.esds && entry.esds.esd && entry.esds.esd.findDescriptor(4);
    const dsi = dcd && dcd.findDescriptor(5);
    if (dsi && dsi.data) desc = new Uint8Array(dsi.data);
  } else if (/^opus$/i.test(codec)) codec = 'opus';
  const config = { codec, sampleRate: audio.audio.sample_rate, numberOfChannels: audio.audio.channel_count };
  if (desc) config.description = desc;
  let ok = false;
  try { ok = (await AudioDecoder.isConfigSupported(config)).supported; } catch (e) { ok = false; }
  if (!ok) return none('unsupported');
  let det = null, start = null, err = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      if (!det) { det = new WhistleDetector(ad.sampleRate); start = ad.timestamp / 1e6; }
      const n = ad.numberOfFrames, ch = ad.numberOfChannels, mono = new Float32Array(n), tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch;
      }
      ad.close();
      det.push(mono);
    },
    error: (e) => { err = e; },
  });
  try { dec.configure(config); } catch (e) { return none('unsupported'); }
  return {
    push(s) {
      if (err) return;
      try {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((1e6 * s.cts) / s.timescale),
          duration: Math.round((1e6 * s.duration) / s.timescale), data: s.data }));
      } catch (e) { err = e; }
    },
    async finish() {
      try { if (!err) await dec.flush(); } catch (e) { err = err || e; }
      try { dec.close(); } catch (e) { /* already closed */ }
      if (err || !det) return { status: 'unsupported', list: [], env: null, envStart: 0 };
      return { status: 'ok', list: det.finish(start || 0), env: det.envelope(), envStart: start || 0 };
    },
  };
}

async function analyze(file, templates, post, debug, both) {
  await cvReady;
  post({ type: 'progress', label: '영상 읽는 중', frac: 0 });
  let m;
  try {
    m = await Demux.openMp4(MP4Box, file.size, (pos, len) => file.slice(pos, pos + len).arrayBuffer());
  } catch (e) {
    throw new UserError(e.message || String(e));
  }
  const track = m.video;
  const fourcc = (track.codec || '').slice(0, 4);
  const config = {
    codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: description(m.mp4.getTrackById(track.id)),
  };
  let support;
  try { support = await VideoDecoder.isConfigSupported(config); } catch (e) { support = { supported: false }; }
  if (!support.supported) {
    throw new UserError(`이 브라우저가 이 영상 형식(${CODEC_NAMES[fourcc] || track.codec})을 해석하지 못합니다. `
      + '최신 Edge 또는 Chrome에서 열어 보시고, 그래도 안 되면 영상을 H.264(mp4)로 변환해 주세요.');
  }
  const rot = rotationOf(track);
  const srcW = track.video.width, srcH = track.video.height;
  const dispW = rot % 180 ? srcH : srcW, dispH = rot % 180 ? srcW : srcH;
  const W = HS.PROC_W, H = Math.round((dispH * W) / dispW);
  const duration = track.duration / track.timescale;
  const total = track.nb_samples;
  post({ type: 'info', duration, codec: CODEC_NAMES[fourcc] || track.codec, width: dispW, height: dispH, frames: total });

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // one fixed camera showing both hoops: each hoop analysed on its own in the same frames
  const analyzer = both && templates['왼쪽'] && templates['오른쪽'] ? new DualAnalyzer(templates, debug && debug.variants) : new Analyzer(templates, debug && debug.variants);
  analyzer.debug = !!(debug && debug.dets);
  const sound = await audioPipe(m.mp4, m.audio);
  const frames = [];
  let wake = null, decErr = null, done = 0;
  const decoder = new VideoDecoder({
    output: (f) => { frames.push(f); if (wake) { wake(); wake = null; } },
    error: (e) => { decErr = e; if (wake) { wake(); wake = null; } },
  });
  decoder.configure(config);
  const t0 = performance.now();

  // at most about 30 frames a second, as in the measurements (60/120 fps videos, or repeated frames in a 120 fps
  // time base, would make every step and the scene motion different, and the analysis 2-4 times slower)
  let lastT = -Infinity;
  const handle = (f) => {
    const t = f.timestamp / 1e6;
    if (t - lastT < 1 / 32) { f.close(); done += 1; return; }
    lastT = t;
    ctx.save();
    if (rot) {
      ctx.translate(W / 2, H / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const dw = rot % 180 ? H : W, dh = rot % 180 ? W : H;
      ctx.drawImage(f, -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx.drawImage(f, 0, 0, W, H);
    }
    ctx.restore();
    f.close();
    analyzer.push(t, cv.matFromImageData(ctx.getImageData(0, 0, W, H)));
    done += 1;
    if (done % 15 === 0) {
      const el = (performance.now() - t0) / 1000;
      post({ type: 'progress', label: '분석 중', frac: Math.min(1, done / total), eta: (el / done) * Math.max(0, total - done) });
    }
  };

  let ended = false;
  for (;;) {
    if (decErr) throw new UserError(`영상 해석 중 오류: ${decErr.message || decErr}`);
    // read on only while the decoder and the analysis keep up, so memory stays small
    while (!ended && decoder.decodeQueueSize < 8 && frames.length < 8) {
      const s = await m.next();
      if (!s) { ended = true; break; }
      if (s.kind === 'audio') { sound.push(s); continue; }
      decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round((1e6 * s.cts) / s.timescale),
        duration: Math.round((1e6 * s.duration) / s.timescale), data: s.data }));
    }
    if (frames.length) { handle(frames.shift()); continue; }
    if (ended) {
      await decoder.flush();
      while (frames.length) handle(frames.shift());
      break;
    }
    await new Promise((r) => { wake = r; setTimeout(r, 20); });
  }
  decoder.close();
  if (!done) throw new UserError('영상에서 장면을 하나도 꺼내지 못했습니다.');
  const res = analyzer.finish();
  const wh = await sound.finish();
  res.whistles = wh.list;
  res.audio = wh.status;
  res.env = wh.env;                 // 100 values per second, first value at envStart seconds
  res.envStart = wh.envStart;
  res.duration = duration;
  res.seconds = (performance.now() - t0) / 1000;
  return res;
}

self.onmessage = async (ev) => {
  const { cmd, file, templates, debug, both } = ev.data;
  if (cmd !== 'analyze') return;
  try {
    const result = await analyze(file, templates, (m) => self.postMessage(m), debug, both);
    self.postMessage({ type: 'done', result }, result.env ? [result.env.buffer] : []);
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof UserError ? e.message : `분석 중 오류가 났습니다: ${e && e.message ? e.message : e}` });
  }
};
