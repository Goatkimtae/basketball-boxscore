/* Reads an MP4/MOV file piece by piece (needs MP4Box). Phone recordings are large (about 100 MB per
   minute) and usually keep their index (moov) at the end of the file, so the file is never loaded whole:
   first only the index is read (the picture data is skipped), then the samples are handed out in order
   while the file is read 4 MB at a time, and each sample's memory is released once it is handed out.

   const m = await openMp4(MP4Box, size, readAt);     // readAt(pos, length) -> Promise<ArrayBuffer>
   m.video, m.audio (track info or null), m.mp4
   for (let s; (s = await m.next()); ) ...            // {kind: 'video' | 'audio', data, cts, duration, timescale, sync} */
'use strict';
(function (root) {
  const CHUNK = 4 * 1024 * 1024;

  async function openMp4(MP4Box, size, readAt, opt = {}) {
    const mp4 = MP4Box.createFile();
    let info = null, error = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { error = e; };
    // 1) the index: follow the parser's hints so the picture data (mdat) is skipped, not read
    let pos = 0, steps = 0, prefixEnd = 0, jumped = false;     // prefixEnd: the file is in the parser from 0 up to here
    while (!info && !error && pos < size) {
      if (++steps > 20000) break;
      const buf = await readAt(pos, Math.min(CHUNK, size - pos));
      if (!buf.byteLength) break;
      buf.fileStart = pos;
      const next = mp4.appendBuffer(buf);
      const seq = pos + buf.byteLength;
      if (!jumped) prefixEnd = seq;
      if (typeof next === 'number' && next > pos && next !== seq) jumped = true;
      pos = typeof next === 'number' && next > pos ? next : seq;
    }
    if (error) throw new Error(`MP4 파일을 읽지 못했습니다: ${error}`);
    if (!info) throw new Error('MP4 형식이 아니거나 손상된 파일입니다. (mp4, mov, m4v만 지원)');
    const video = info.videoTracks[0] || null;
    const audio = opt.audio === false ? null : info.audioTracks[0] || null;
    if (!video) throw new Error('영상 트랙이 없는 파일입니다.');

    // 2) the samples, in file order
    const queue = [];
    const left = { video: video.nb_samples, audio: audio ? audio.nb_samples : 0 };
    const lastNo = { video: -1, audio: -1 };
    mp4.onSamples = (id, kind, samples) => {
      for (const s of samples) {
        if (s.number <= lastNo[kind]) continue;               // never hand a sample out twice
        lastNo[kind] = s.number; left[kind] -= 1;
        queue.push({ kind, data: s.data, cts: s.cts, dts: s.dts, duration: s.duration, timescale: s.timescale, sync: s.is_sync });
      }
      mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);   // drops mp4box's own reference; ours stays in the queue
    };
    mp4.setExtractionOptions(video.id, 'video', { nbSamples: 30 });
    if (audio) mp4.setExtractionOptions(audio.id, 'audio', { nbSamples: 100 });
    mp4.start();                       // hands out what the first pieces already hold
    pos = prefixEnd;                   // then go on from there, in order
    let flushed = false;

    async function next() {
      while (!queue.length) {
        if (left.video <= 0 && left.audio <= 0) return null;
        if (pos >= size) {
          if (flushed) return null;
          mp4.flush(); flushed = true;
          continue;
        }
        const buf = await readAt(pos, Math.min(CHUNK, size - pos));
        if (!buf.byteLength) { pos = size; continue; }
        buf.fileStart = pos;
        mp4.appendBuffer(buf);
        pos += buf.byteLength;
      }
      return queue.shift();
    }
    return { mp4, info, video, audio, next, queued: () => queue.length };
  }

  const Demux = { openMp4 };
  if (typeof self !== 'undefined') self.Demux = Demux;
  if (typeof module !== 'undefined') module.exports = Demux;
})(typeof self !== 'undefined' ? self : globalThis);
