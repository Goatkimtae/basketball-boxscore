/* The whole app in headless Chromium on a two-camera game: makes the gym profile by clicking the rims,
   runs the analysis (both stages), reads the results back from the page.

     node harness/e2e.js <game key> [--clips left150,right150] [--no-players] [--names] [--rosters "1 2 3|4 5 6"] [--rim-offset dx,dy] [--quarters]
   --quarters: after the first analysis the same clips are chosen again under other names and analysed as the next quarter.
   --swap (with --quarters): before that, the page's two teams are put on the wrong ends (the app should put them back).

   Headless Chromium has no H.264/HEVC decoder: the clips must be VP9 in MP4 (make them with
   make-clips.sh at full resolution; 768-px clips are too small to read numbers). The page is served by
   a small built-in server from the repository, so the app under test is the working copy.
   Writes _workspace/e2e/<game>-<time>.json with the status line, team fields, records, the
   [players] diagnostic line, timings and any page errors. */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const H = require('./lib');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4' };
function serve(root) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run(game, opt = {}) {
  const c = H.config(), g = c.games[game], vl = c.videos[g.left], vr = c.videos[g.right];
  const [ka, kb] = (opt.clips || 'left,right').split(',');
  const clipA = g.clips[ka], clipB = g.clips[kb];
  for (const f of [clipA, clipB]) if (!f || !fs.existsSync(f)) throw new Error(`clip not found: ${f} (make it with harness/make-clips.sh, list it under games.${game}.clips)`);
  const { chromium } = require('playwright');
  const srv = await serve(H.ROOT), port = srv.address().port;
  const b = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8' } });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 950 }, deviceScaleFactor: 1 })).newPage();
  const log = { game, clips: [clipA, clipB], errors: [], stages: [], players: null };
  page.on('pageerror', (e) => log.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); if (m.text().startsWith('[players] ')) log.players = JSON.parse(m.text().slice(10)); if (m.text().startsWith('[practice] ')) log.practice = JSON.parse(m.text().slice(11)); });
  // the quick review says there is nothing left to check: that is the hoped-for result, not an error
  page.on('dialog', (d) => { if (/검토할 기록이 없습니다/.test(d.message())) log.nothingToReview = true; else log.errors.push(`[dialog] ${d.message()}`); d.accept(); });
  try {
    await page.goto(`http://127.0.0.1:${port}/hoopstat/`);
    await page.selectOption('#cam_mode', 'two');
    if (opt.players === false) await page.uncheck('#auto_players');
    if (opt.names) { await page.fill('#team_left', 'H'); await page.fill('#team_right', 'N'); }
    if (opt.rosters) { const [l, r] = opt.rosters.split('|'); await page.fill('#roster_left', l); await page.fill('#roster_right', r); }
    await page.setInputFiles('#videoInput', clipA);
    await page.setInputFiles('#videoInputB', clipB);
    await page.waitForFunction(() => document.getElementById('videoInfo').textContent.includes('×') && document.getElementById('videoInfoB').textContent.includes('×'), null, { timeout: 60000 });
    await page.click('#newProfileBtn');
    const setT = async (t) => {
      await page.evaluate((t) => { const r = document.getElementById('pfRange'); r.value = t; r.dispatchEvent(new Event('input')); }, t);
      await page.waitForFunction((t) => document.getElementById('pfTime').textContent.startsWith(t.toFixed(1)), t);
      await page.waitForTimeout(900);
    };
    const clickRim = async ([x, y]) => {
      const box = await page.locator('#pfCanvas').boundingBox();
      const [cw, ch] = await page.$eval('#pfCanvas', (cv) => [cv.width, cv.height]);
      await page.mouse.click(box.x + (x * box.width) / cw, box.y + (y * box.height) / ch);
      await page.waitForTimeout(1500);
      (log.snap = log.snap || []).push(await page.textContent('#pfSnapNote').catch(() => ''));
    };
    // --rim-offset dx,dy: click beside the rim (how sensitive is the analysis to a careless click?)
    const [odx, ody] = (opt.rimOffset || '0,0').split(',').map(Number), off = ([x, y]) => [x + odx, y + ody];
    await setT(vl.rimTime); await clickRim(off(vl.rim));
    await setT(vr.rimTime); await clickRim(off(vr.rim));
    await page.fill('#pfName', `harness ${game}`); await page.click('#pfSave');
    const t0 = Date.now();
    await page.click('#runBtn');
    let last = '';
    const timer = setInterval(async () => {
      try { const st = await page.textContent('#status'); const stage = st.slice(0, 3); if (stage !== last) { last = stage; log.stages.push([Math.round((Date.now() - t0) / 1000), st.slice(0, 60)]); if (opt.log) opt.log(`[${log.stages[log.stages.length - 1][0]}s] ${st.slice(0, 60)}`); } } catch (e) { /* page busy */ }
    }, 3000);
    await page.waitForFunction(() => /분석 끝|분석하지 못했|오류/.test(document.getElementById('status').textContent), null, { timeout: 7000000, polling: 2000 });
    clearInterval(timer);
    log.seconds = Math.round((Date.now() - t0) / 1000);
    log.status = await page.textContent('#status');
    log.fields = {};
    for (const id of ['team_left', 'color_left', 'roster_left', 'team_right', 'color_right', 'roster_right', 'cam_offset']) log.fields[id] = await page.inputValue(`#${id}`);
    log.records = await page.$$eval('#eventTable tbody tr', (trs) => trs.map((tr) => [...tr.children].slice(0, 6).map((td) => td.textContent)));
    // --quarters: the same clips again under other file names, as the next quarter (the app should pick it by itself)
    if (opt.quarters) {
      const os = require('os'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoopstat-q2-'));
      const copy = (f, n) => { const to = path.join(dir, n); fs.copyFileSync(f, to); return to; };
      await page.setInputFiles('#videoInput', copy(clipA, 'second-left.mp4'));
      await page.setInputFiles('#videoInputB', copy(clipB, 'second-right.mp4'));
      await page.waitForTimeout(3000);
      log.quarter2 = await page.inputValue('#quarter');
      if (opt.swap) {
        // put the page's two teams on the wrong ends: the analysis should move them back to what the video shows
        await page.evaluate(() => { for (const k of ['team', 'color', 'roster']) { const l = document.getElementById(`${k}_left`), r = document.getElementById(`${k}_right`); [l.value, r.value] = [r.value, l.value]; } });
        log.swappedTo = await page.inputValue('#team_left');
      }
      log.quarterNote = await page.textContent('#quarterNote');
      const t1 = Date.now();
      await page.click('#runBtn');
      await page.waitForFunction(() => /쿼터 분석 끝|분석하지 못했|오류/.test(document.getElementById('status').textContent) && !document.getElementById('runBtn').disabled, null, { timeout: 7000000, polling: 2000 });
      await page.waitForFunction(() => document.getElementById('status').textContent.startsWith(document.getElementById('quarter').selectedOptions[0].textContent), null, { timeout: 7000000, polling: 2000 });
      log.seconds2 = Math.round((Date.now() - t1) / 1000);
      log.status2 = await page.textContent('#status');
      log.records = await page.$$eval('#eventTable tbody tr', (trs) => trs.map((tr) => [...tr.children].slice(0, 6).map((td) => td.textContent)));
      await page.click('#tabBox');
      log.linescore = await page.$$eval('#lineTable tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
      log.boxOptions = await page.$$eval('#boxQuarter option', (os) => os.map((o) => o.textContent));
      await page.selectOption('#boxQuarter', '2');
      log.box2 = await page.$$eval('#teamTable tr', (trs) => trs.slice(0, 3).map((tr) => [...tr.children].map((td) => td.textContent.trim())));
      await page.click('#tabEvents');
      for (const id of ['team_left', 'color_left', 'team_right', 'color_right']) log.fields[`${id}_q2`] = await page.inputValue(`#${id}`);
    }
    await page.click('#numBtn'); await page.waitForTimeout(3000);
    log.reviewLeft = log.nothingToReview ? '0' : await page.textContent('#numLeft');
    await page.screenshot({ path: H.out('e2e', `${game}-last.png`) });
  } finally {
    await b.close(); srv.close();
  }
  return log;
}

if (require.main === module) {
  const a = H.args();
  if (!a._[0]) { console.error('usage: node harness/e2e.js <game key> [--clips left150,right150] [--no-players] [--names] [--rosters "l|r"]'); process.exit(2); }
  run(a._[0], { clips: a.clips, players: !a['no-players'], names: a.names, rosters: a.rosters, rimOffset: a['rim-offset'], quarters: a.quarters, swap: a.swap, log: (m) => console.log(m) }).then((log) => {
    const file = H.save(H.out('e2e', `${a._[0]}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), log);
    const shots = log.records.filter((r) => r[3] === '야투' || r[3] === '자유투');
    console.log(`STATUS (${log.seconds}s): ${log.status}`);
    console.log('fields:', JSON.stringify(log.fields));
    const rebs = log.records.filter((r) => r[3] === '리바운드');
    const n = (list, re) => list.filter((r) => re.test(r[2])).length;
    console.log(`shots ${shots.length}: number read ${n(shots, /\(자동\)/)}, guessed ${n(shots, /\(추정\)/)}; rebounds ${rebs.length}: number read ${n(rebs, /\(자동\)/)}, guessed ${n(rebs, /\(추정\)/)}; review left ${log.reviewLeft}`);
    if (log.snap) console.log('rim snap:', log.snap.join(' / '));
    if (log.players) console.log('direction:', JSON.stringify({ how: log.players.how, score: log.players.dirScore, shooters: log.players.direction, defence: log.players.defence }));
    if (log.status2) {
      console.log(`2nd analysis (quarter picked: ${log.quarter2}, note: ${log.quarterNote}${log.swappedTo ? `, page swapped so the left team was ${log.swappedTo}` : ''}) ${log.seconds2}s: ${log.status2}`);
      console.log('teams after it:', JSON.stringify(Object.fromEntries(Object.entries(log.fields).filter(([k]) => k.endsWith('_q2')))));
      console.log('linescore:', JSON.stringify(log.linescore), 'box options:', JSON.stringify(log.boxOptions));
      console.log('box (2nd quarter only):', JSON.stringify(log.box2));
    }
    console.log('errors:', log.errors.length ? log.errors.join('\n') : 'none');
    console.log('->', path.relative(H.ROOT, file));
    process.exit(log.errors.length ? 1 : 0);
  }).catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { run };
