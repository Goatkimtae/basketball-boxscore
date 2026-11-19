/* The whole app flow in headless Chromium on the two-camera test clips, checking that what the user does survives:
     choose videos -> teams / direction found -> rims marked -> analyse -> team colour changed by hand
     -> a 2-pointer made a 3-pointer and an automatic rebound deleted -> re-analyse (nothing doubled, nothing back,
     the colour kept) -> attack direction changed (records follow) -> work file saved and opened again
     -> HTML / CSV / Excel saved -> one video holding two quarters: spans set and moved.
     node harness/flow-e2e.js [game] [--clips left150,right150] [--no-players]
   Prints one line per check (ok / FAIL) and writes _workspace/e2e/flow-<time>.json. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib');
const { serve } = require('./e2e');

async function run(game, opt = {}) {
  const c = H.config(), g = c.games[game], vl = c.videos[g.left], vr = c.videos[g.right];
  const [ka, kb] = (opt.clips || 'left150,right150').split(',');
  const clipA = g.clips[ka], clipB = g.clips[kb];
  const { chromium } = require('playwright');
  const srv = await serve(H.ROOT), port = srv.address().port;
  const b = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8' } });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 950 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const log = { checks: [], errors: [], dialogs: [], times: {} };
  const check = (name, ok, detail = '') => { log.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
  page.on('pageerror', (e) => log.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('dialog', (d) => { log.dialogs.push(d.message().slice(0, 200)); d.accept(); });
  const records = () => page.$$eval('#eventTable tbody tr', (trs) => trs.map((tr) => ({ id: tr.dataset.id, cells: [...tr.children].map((td) => td.textContent) })));
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('hoopstat.work.v1') || 'null'));
  const pts = (st) => { const ev = st.events.filter((e) => e.type !== '휘슬'); const p = (e) => (e.result !== '성공' ? 0 : e.type === '야투' ? (e.detail === '3점' ? 3 : 2) : 0); return ev.reduce((a, e) => a + p(e), 0); };
  const analyse = async (label) => {
    const t0 = Date.now();
    await page.click('#runBtn');
    await page.waitForFunction(() => /분석 끝|분석하지 못했|오류/.test(document.getElementById('status').textContent) && !document.getElementById('runBtn').disabled, null, { timeout: 7000000, polling: 2000 });
    log.times[label] = Math.round((Date.now() - t0) / 1000);
    return page.textContent('#status');
  };
  try {
    await page.goto(`http://127.0.0.1:${port}/hoopstat/`);
    const LS = await page.evaluate(() => Object.keys(localStorage));
    log.lsKeys = LS;
    await page.selectOption('#cam_mode', 'two');
    if (opt.players === false) await page.uncheck('#auto_players');
    await page.setInputFiles('#videoInput', clipA);
    await page.setInputFiles('#videoInputB', clipB);
    await page.waitForFunction(() => document.getElementById('videoInfo').textContent.includes('×') && document.getElementById('videoInfoB').textContent.includes('×'), null, { timeout: 60000 });
    // gym profile: click both rims
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
    };
    await setT(vl.rimTime); await clickRim(vl.rim);
    await setT(vr.rimTime); await clickRim(vr.rim);
    await page.fill('#pfName', `harness flow ${game}`); await page.click('#pfSave');

    // 1. first analysis (1st quarter)
    const st1 = await analyse('first');
    check('analysis 1 finished', /분석 끝/.test(st1), st1.slice(0, 120));
    const dir1 = await page.$$eval('#dirTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => (td.querySelector('select') ? td.querySelector('select').selectedOptions[0].textContent : td.textContent.trim()))));
    log.dir1 = dir1;
    const info = [await page.textContent('#teamInfo_left'), await page.textContent('#teamInfo_right')];
    log.teamInfo = info;
    if (opt.players !== false) {
      check('team colours filled from the video with evidence', info.every((x) => /영상에서 본 색/.test(x)), info.join(' | '));
      check('attack direction found for the 1st quarter', dir1.length >= 1 && /영상/.test(dir1[0][4]), JSON.stringify(dir1[0]));
    }
    // 2. the user changes team A's colour
    const colA = await page.inputValue('#color_left');
    const newCol = colA === '노랑' ? '초록' : '노랑';
    await page.selectOption('#color_left', newCol);
    // 3. edit: the first automatic 2-pointer becomes a 3-pointer; delete the first automatic rebound
    let s1 = await state();
    const before = pts(s1);
    const fg = s1.events.find((e) => e.type === '야투' && e.source === '자동' && e.detail === '2점' && e.result === '성공') || s1.events.find((e) => e.type === '야투' && e.source === '자동');
    await page.dblclick(`#eventTable tbody tr[data-id="${fg.id}"]`);      // a double-click on the row opens the edit dialog
    await page.waitForSelector('#eventDlg[open]', { timeout: 5000 });
    await page.selectOption('#evDetail', '3점');
    await page.click('#evOk');
    await page.waitForTimeout(500);
    const reb = (await state()).events.find((e) => e.type === '리바운드' && e.derived);
    await page.click(`#eventTable tbody tr[data-id="${reb.id}"]`);
    await page.click('#delBtn');
    await page.waitForTimeout(500);
    s1 = await state();
    const afterEdit = pts(s1);
    check('2-pointer made a 3-pointer by hand', afterEdit === before + (fg.result === '성공' ? 1 : 0), `${before} -> ${afterEdit}`);
    check('automatic rebound deleted', !s1.events.some((e) => e.id === reb.id) && s1.settings.removed.length >= 1);

    // 4. re-analyse the same videos, same quarter
    const st2 = await analyse('again');
    const s2 = await state();
    check('re-analysis: the 3-pointer is not counted twice', pts(s2) === afterEdit, `points ${afterEdit} -> ${pts(s2)}; shots near: ${s2.events.filter((e) => e.type === '야투' && Math.abs(e.time - fg.time) < 1.5).map((e) => `${e.detail}/${e.source}`).join(',')}`);
    check('re-analysis: the deleted rebound did not come back', !s2.events.some((e) => e.type === '리바운드' && e.of === reb.of && Math.abs(e.time - reb.time) < 1.6), `rebounds ${s1.events.filter((e) => e.type === '리바운드').length} -> ${s2.events.filter((e) => e.type === '리바운드').length}`);
    check('re-analysis: the colour chosen by hand is kept', (await page.inputValue('#color_left')) === newCol, `${newCol} / ${await page.inputValue('#color_left')}`);
    check('re-analysis status mentions what is still open', /사람이 확인하지 않은 것|열린 항목/.test(st2), st2.slice(-160));

    // 5. the user turns the 1st quarter's direction round
    const teamsBefore = s2.events.filter((e) => e.type === '야투' && e.source === '자동' && !e.edited && !e.checked).map((e) => [e.id, e.team]);
    const sel = page.locator('#dirTable tbody tr').first().locator('select');
    const cur = await sel.inputValue();
    await sel.selectOption(cur === 'A' ? 'B' : 'A');
    await page.waitForTimeout(800);
    const s3 = await state();
    const flipped = teamsBefore.filter(([id, t]) => { const e = s3.events.find((x) => x.id === id); return e && e.team !== t; }).length;
    check('direction changed by hand: automatic shots change team', flipped === teamsBefore.length && flipped > 0, `${flipped}/${teamsBefore.length}`);
    check('direction kept as the user\'s', s3.settings.quarters[1].dir.source === '사람');
    const tA = s3.settings.team_left;
    check('records keep their team id after the change', s3.events.filter((e) => e.team === tA).every((e) => !e.tid || e.tid === 'A'));

    // 6. work file: save, start a new game, open it again
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saveWorkBtn')]);
    const workFile = path.join(os.tmpdir(), `flow-work-${Date.now()}.json`);
    await dl.saveAs(workFile);
    const saved = JSON.parse(fs.readFileSync(workFile, 'utf8'));
    check('work file has profile, quarters, removed, history, team info', !!(saved.profile && saved.settings.quarters && saved.settings.removed.length && saved.settings.history.length && saved.settings.teamInfo), `version ${saved.version}, history ${saved.settings.history.length}`);
    await page.evaluate(() => { localStorage.removeItem('hoopstat.work.v1'); });
    await page.reload();
    await page.setInputFiles('#openWork', workFile);
    await page.waitForTimeout(1500);
    const s4 = await state();
    check('work file opened again: same records', s4 && s4.events.length === s3.events.length, `${s3.events.length} / ${s4 && s4.events.length}`);
    check('work file opened again: colour, direction and deletions kept', s4.settings.color_left === newCol && s4.settings.quarters[1].dir.source === '사람' && s4.settings.removed.length === s3.settings.removed.length);

    // 7. exports
    for (const [btn, ext] of [['#htmlBtn', 'html'], ['#csvBtn', 'csv'], ['#xlsxBtn', 'xlsx']]) {
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(btn)]);
      const f = path.join(os.tmpdir(), `flow-export.${ext}`); await d.saveAs(f);
      const size = fs.statSync(f).size;
      const text = ext === 'xlsx' ? '' : fs.readFileSync(f, 'utf8');
      check(`export ${ext}`, size > 500 && (ext === 'xlsx' || /쿼터/.test(text)) && (ext !== 'html' || /확인 상태/.test(text)) && (ext !== 'csv' || /번호 상태/.test(text)), `${size} bytes`);
    }

    // 8. one video holding two quarters: the same clips as the whole game, spans set by hand, then moved
    if (opt.whole !== false) {
      await page.setInputFiles('#videoInput', clipA);
      await page.setInputFiles('#videoInputB', clipB);
      await page.waitForTimeout(2000);
      await page.selectOption('#video_layout', 'whole');
      await page.uncheck('#auto_players');
      await page.fill('#q_count', '2'); await page.dispatchEvent('#q_count', 'change');
      await page.evaluate(() => { document.getElementById('spanAdd').click(); });
      await page.waitForTimeout(300);
      const fillSpan = async (row, start, end) => {
        const tr = page.locator('#spanTable tbody tr').nth(row);
        await tr.locator('input').nth(0).fill(String(start)); await tr.locator('input').nth(0).dispatchEvent('change');
        await page.locator('#spanTable tbody tr').nth(row).locator('input').nth(1).fill(String(end)); await page.locator('#spanTable tbody tr').nth(row).locator('input').nth(1).dispatchEvent('change');
      };
      await fillSpan(0, 0, 75);
      await page.evaluate(() => { document.getElementById('spanAdd').click(); });
      await page.waitForTimeout(300);
      await fillSpan(1, 75, 152);
      const st5 = await analyse('whole');
      const s5 = await state();
      const qs = [...new Set(s5.events.map((e) => e.q || 1))].sort();
      check('one video, two quarters: records in both', qs.includes(1) && qs.includes(2), `${st5.slice(0, 90)} | quarters ${qs.join(',')}`);
      const ls = await page.$$eval('#lineTable tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
      const sumOk = ls.slice(1).every((r) => r.slice(1, -1).reduce((a, x) => a + Number(x), 0) === Number(r[r.length - 1]));
      check('points per quarter add up to the total', ls.length >= 3 && sumOk, JSON.stringify(ls));
      const nQ2 = s5.events.filter((e) => e.q === 2).length;
      await fillSpan(0, 0, 50); await fillSpan(1, 50, 152);
      await page.waitForTimeout(800);
      const s6 = await state();
      check('moving the boundary moves records to the other quarter', s6.events.filter((e) => e.q === 2).length > nQ2, `2nd quarter ${nQ2} -> ${s6.events.filter((e) => e.q === 2).length}`);
      check('records near a boundary are marked to check', s6.events.some((e) => e.qUnsure));
      // overtime: a span for 연장 1
      await page.evaluate(() => { document.getElementById('spanAdd').click(); });
      await page.waitForTimeout(300);
      await page.locator('#spanTable tbody tr').nth(2).locator('select').selectOption('5');
      await fillSpan(1, 50, 120); await fillSpan(2, 120, 152);
      await page.waitForTimeout(800);
      const s7 = await state();
      check('overtime span gets records', s7.events.some((e) => e.q === 5), `OT records ${s7.events.filter((e) => e.q === 5).length}`);
    }
    check('no page errors', log.errors.length === 0, log.errors.slice(0, 3).join(' | '));
    await page.screenshot({ path: H.out('e2e', 'flow-last.png'), fullPage: false });
  } catch (e) {
    check('flow ran to the end', false, (e.stack || String(e)).slice(0, 400));
  } finally {
    await b.close(); srv.close();
  }
  return log;
}

if (require.main === module) {
  const a = H.args();
  run(a._[0] || 'hvn', { clips: a.clips, players: !a['no-players'], whole: !a['no-whole'] }).then((log) => {
    const file = H.save(H.out('e2e', `flow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), log);
    const bad = log.checks.filter((c) => !c.ok);
    console.log(`${log.checks.length - bad.length}/${log.checks.length} checks ok, times ${JSON.stringify(log.times)}, dialogs ${log.dialogs.length} -> ${path.relative(H.ROOT, file)}`);
    process.exit(bad.length ? 1 : 0);
  });
}
module.exports = { run };
