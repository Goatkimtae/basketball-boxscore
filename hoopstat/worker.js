/* Analysis worker: reads the video file, decodes every frame with WebCodecs and runs the engine. */
'use strict';
importScripts('vendor/opencv.js', 'vendor/mp4box.all.min.js', 'engine.js');

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

async function demux(file, post) {
  const mp4 = MP4Box.createFile();
  const chunks = [];
  let track = null;
  const ready = new Promise((resolve, reject) => {
    mp4.onReady = (info) => {
      track = info.videoTracks[0];
      if (!track) { reject(new UserError('영상 트랙이 없는 파일입니다.')); return; }
      mp4.setExtractionOptions(track.id, null, { nbSamples: 200 });
      mp4.start();
      resolve(info);
    };
    mp4.onError = (e) => reject(new UserError(`MP4 파일을 읽지 못했습니다: ${e}`));
  });
  mp4.onSamples = (id, _user, samples) => {
    for (const s of samples) {
      chunks.push(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((1e6 * s.cts) / s.timescale),
        duration: Math.round((1e6 * s.duration) / s.timescale),
        data: s.data,
      }));
    }
    mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };
  const CH = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CH) {
    const buf = await file.slice(off, off + CH).arrayBuffer();
    buf.fileStart = off;
    mp4.appendBuffer(buf);
    post({ type: 'progress', label: '영상 읽는 중', frac: Math.min(1, (off + CH) / file.size) * 0.05 });
  }
  mp4.flush();
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new UserError('MP4 형식이 아니거나 손상된 파일입니다. (mp4, mov, m4v만 지원)')), 2000))]);
  return { mp4, track, chunks };
}

async function analyze(file, templates, post, debug) {
  await cvReady;
  const { mp4, track, chunks } = await demux(file, post);
  if (!chunks.length) throw new UserError('영상에서 장면을 하나도 꺼내지 못했습니다.');
  const trak = mp4.getTrackById(track.id);
  const fourcc = (track.codec || '').slice(0, 4);
  const config = {
    codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: description(trak),
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
  post({ type: 'info', duration, codec: CODEC_NAMES[fourcc] || track.codec, width: dispW, height: dispH, frames: chunks.length });

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const analyzer = new Analyzer(templates, debug && debug.variants);
  analyzer.debug = !!(debug && debug.dets);
  const frames = [];
  let wake = null, decErr = null, done = 0;
  const decoder = new VideoDecoder({
    output: (f) => { frames.push(f); if (wake) { wake(); wake = null; } },
    error: (e) => { decErr = e; if (wake) { wake(); wake = null; } },
  });
  decoder.configure(config);
  const total = chunks.length;
  const t0 = performance.now();

  const handle = (f) => {
    const t = f.timestamp / 1e6;
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
      post({ type: 'progress', label: '분석 중', frac: 0.05 + 0.95 * (done / total), eta: (el / done) * (total - done) });
    }
  };

  let ci = 0;
  for (;;) {
    if (decErr) throw new UserError(`영상 해석 중 오류: ${decErr.message || decErr}`);
    while (ci < total && decoder.decodeQueueSize < 8 && frames.length < 8) decoder.decode(chunks[ci++]);
    if (frames.length) { handle(frames.shift()); continue; }
    if (ci >= total) {
      await decoder.flush();
      while (frames.length) handle(frames.shift());
      break;
    }
    await new Promise((r) => { wake = r; setTimeout(r, 20); });
  }
  decoder.close();
  const res = analyzer.finish();
  res.duration = duration;
  res.seconds = (performance.now() - t0) / 1000;
  return res;
}

self.onmessage = async (ev) => {
  const { cmd, file, templates, debug } = ev.data;
  if (cmd !== 'analyze') return;
  try {
    const result = await analyze(file, templates, (m) => self.postMessage(m), debug);
    self.postMessage({ type: 'done', result });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof UserError ? e.message : `분석 중 오류가 났습니다: ${e && e.message ? e.message : e}` });
  }
};
