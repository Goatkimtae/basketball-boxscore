/* The app's whistle detector (engine.js WhistleDetector, as worker.js runs it) on a video's sound in Node.
     node harness/whistles-run.js <video key | file>
   Writes _workspace/whistles/<key>.json: {sampleRate, whistles: [{t, dur, f}]} (t in the video's own time). */
'use strict';
const { spawn } = require('child_process');
const H = require('./lib');

(async () => {
  const v = H.video(H.args()._[0]);
  await H.loadCv();
  const E = require(require('path').join(H.APP, 'engine.js'));
  const sr = 48000, det = new E.WhistleDetector(sr);
  await new Promise((resolve, reject) => {
    // mono = mean of the channels, as worker.js does
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', v.path, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-']);
    let rest = Buffer.alloc(0);
    ff.stdout.on('data', (d) => {
      const b = rest.length ? Buffer.concat([rest, d]) : d, n = Math.floor(b.length / 4);
      det.push(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)));
      rest = b.subarray(n * 4);
    });
    ff.on('error', reject); ff.on('close', resolve);
  });
  const list = det.finish(0);
  console.log(`${v.key}: ${list.length} whistle-like sounds, ${list.filter((w) => w.dur >= 0.5).length} of 0.5 s or more`);
  console.log('->', H.save(H.out('whistles', `${v.key}.json`), { sampleRate: sr, whistles: list }));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
