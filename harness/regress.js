/* Engine regression over every video in harness/config.json (those with a template): runs the engine
   on each (several at once) and compares with harness/baselines/<key>.json.

     node harness/regress.js [--only key,key] [--jobs 4] [--update]

   --update writes the new results as the baselines (do it only when a change in shots is intended,
   and say so in the commit message). Exit code 1 when any video's shots changed. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const H = require('./lib');
const { compare, sideRuns } = require('./engine-compare');

const a = H.args(), c = H.config();
const keys = Object.values(c.videos).filter((v) => v.template && (!a.only || a.only.split(',').includes(v.key))).map((v) => v.key);
const jobs = Number(a.jobs) || Math.max(1, Math.min(keys.length, os.cpus().length));
const runOne = (key) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(__dirname, 'engine-run.js'), key], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ key, code, err }));
});
(async () => {
  const queue = [...keys], results = [];
  await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) results.push(await runOne(queue.shift())); }));
  let bad = 0;
  for (const key of keys) {
    const r = results.find((x) => x.key === key);
    if (r.code) { console.log(`FAIL ${key}: engine run failed\n${r.err}`); bad++; continue; }
    const now = H.load(H.out('engine', `${key}.json`));
    const slim = { shots: now.shots.map(({ start, end, side, made, made_t, frames }) => ({ start, end, side, made, made_t, frames })), sideRuns: sideRuns(now.track), visibility: now.visibility, frames: now.frames };
    const bfile = path.join(__dirname, 'baselines', `${key}.json`);
    if (a.update || !fs.existsSync(bfile)) { fs.writeFileSync(bfile, JSON.stringify(slim)); console.log(`BASELINE ${key}: ${slim.shots.length} shots written`); continue; }
    const d = compare(H.load(bfile), { ...slim, track: now.track });
    const ok = d.same;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${key}: shots ${d.shots[0]} -> ${d.shots[1]}, made ${d.made[0]} -> ${d.made[1]}, camera side differs on ${d.sideDiffer}/${d.sideSamples} samples (${now.seconds}s)`
      + (d.onlyA.length ? `\n     only in baseline: ${d.onlyA.join('  ')}` : '') + (d.onlyB.length ? `\n     only now:         ${d.onlyB.join('  ')}` : ''));
  }
  process.exit(bad ? 1 : 0);
})();
