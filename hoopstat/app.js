/* HoopStat web app: screens, gym profiles, running the analysis worker(s), review and saving.
   One video (a camera that follows play, or one fixed hoop) or two videos (one fixed camera per hoop).
   With two videos, camera A films the left hoop, camera B the right hoop; all record times are on
   camera A's clock: a moment at time t in video B is at t + cam_offset in the record. */
'use strict';

const $ = (id) => document.getElementById(id);
const SIDES = ['왼쪽', '오른쪽'];
const PROC_W = 768, TW = 84, TH = 70, RIM_DY = 0.30;
const LS_PROFILES = 'hoopstat.profiles.v1';
const LS_WORK = 'hoopstat.work.v1';

const newVid = () => ({ file: null, url: null, duration: 0, ok: false, name: '' });
const S = { vids: { A: newVid(), B: newVid() }, events: [], selId: null, workers: [], ctx: null, quarters: {}, removed: [], history: [], runId: 0,
  teamInfo: { A: {}, B: {} }, spans: null,
  reviewing: false, skipped: new Set(), sceneCam: null, sceneToken: 0, grabChain: Promise.resolve() };

/* ------------------------------------------------------------------ storage */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let uidN = 0;
const uid = () => `e${Date.now().toString(36)}${(uidN++).toString(36)}`;

function profiles() { return lsGet(LS_PROFILES, {}); }
function profileTemplates(name) {
  const p = profiles()[name];
  if (!p) return null;
  const out = {};
  for (const side of SIDES) if (p[side]) out[side] = { w: p[side].w, h: p[side].h, data: unb64(p[side].b64) };
  return out;
}

/* ------------------------------------------------------------------ settings */
const APP_VERSION = 'hoopstat-v13';   // the same as VERSION in sw.js (a test checks)
/* ------------------------------------------------------------------ settings (continued) */
const SETTING_IDS = ['cam_mode', 'team_left', 'color_left', 'team_right', 'color_right', 'roster_left', 'roster_right', 'team_size', 'switch_time', 'cam_offset', 'title', 'quarter',
  'sync_mode', 'video_layout', 'q_count', 'q_len', 'ot_len'];
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const twoCam = () => $('cam_mode').value === 'two';
/** one fixed camera showing both hoops at once */
const bothHoops = () => $('cam_mode').value === 'both';
function settings() {
  const s = {};
  for (const id of SETTING_IDS) s[id] = $(id).value.trim();
  s.switch_time = num(s.switch_time);
  s.cam_offset = num(s.cam_offset) ?? 0;
  s.profile = $('profileSel').value;
  s.video_name = S.vids.A.file ? S.vids.A.file.name : S.vids.A.name;
  s.video_name_b = S.vids.B.file ? S.vids.B.file.name : S.vids.B.name;
  s.duration = S.vids.A.duration;
  s.flow = S.ctx;
  s.analysis = S.analysis || null;   // how the last analysis went (app version, status line): saved and exported
  s.quarters = S.quarters;            // per quarter: its videos, play-flow ctx, which team attacked which hoop
  s.colours_known = !!S.coloursKnown;  // the team colours were chosen or found, not just the defaults
  s.removed = S.removed;              // deleted automatic / rebuilt records (not made again)
  s.teamInfo = S.teamInfo;            // per team: where the colour came from (auto / user), the colour seen, evidence
  s.spans = S.spans;                  // one video holding several quarters: {spans: [{q, start, end}], source, why, video}
  s.history = S.history;              // edits and deletions, newest last
  return s;
}
/** the quarter of the videos chosen now (step 2): analyses, the quick review and new records go there */
const curQ = () => Number($('quarter').value) || 1;
// qOf(e): the record's quarter (stats.js, shared by the page's scripts)
/** the two teams, A then B (the page's first and second team rows; ids kept from when they were left / right) */
function teams() { const s = settings(); return [s.team_left || '팀 A', s.team_right || '팀 B']; }
const idOf = (name) => { const [a, b] = teams(); return name === a ? 'A' : name === b ? 'B' : null; };
const nameOf = (id) => teams()[id === 'B' ? 1 : 0];
const otherId = (id) => (id === 'A' ? 'B' : 'A');
/** A quarter's attack direction {left: 'A'|'B', switchT, source, how}: as saved for it (found by the analysis or set by
    the user), else from the nearest quarter with one (same half: same ends; the other half: the other ends, FIBA 9.5;
    overtime like the 4th), else team A on the left (not known). */
const dirFor = (q) => Stats.dirOf(S.quarters, q);
/** settings as one quarter sees them: team_left / team_right are the teams attacking the left / right hoop then,
    switch_time the time they change ends inside that quarter's video (or null) */
function settingsFor(q) {
  const s = settings(), d = dirFor(q), [a, b] = teams();
  const [L, R] = d.left === 'B' ? [b, a] : [a, b], [cL, cR] = d.left === 'B' ? [s.color_right, s.color_left] : [s.color_left, s.color_right];
  return { ...s, team_left: L, team_right: R, color_left: cL, color_right: cR, switch_time: d.switchT ?? null };
}
/** records keep their team as A or B (tid): renaming a team renames its records, they never split off */
function syncTeamIds() {
  const [a, b] = teams();
  for (const e of S.events) {
    if (e.tid === 'A' || e.tid === 'B') { const n = e.tid === 'A' ? a : b; if (e.team && e.team !== n) e.team = n; }
    else if (e.team) { const id = idOf(e.team); if (id) e.tid = id; }
  }
}
let knownTeams = null;
const flowCtx = () => S.ctx || { mode: twoCam() || bothHoops() ? 'two' : 'pan', segs: [] };
/** the play-flow ctx of a quarter (filming mode, camera looks): the one saved with its analysis */
const ctxFor = (q) => ({ ...((S.quarters[q] && S.quarters[q].ctx) || flowCtx()), removed: S.removed.filter((r) => (r.q || 1) === q) });
/** what the user did to the record (kept in the work file): edits, deletions, additions */
const brief = (e) => (e ? `${Stats.quarterName(qOf(e))} ${Number(e.time).toFixed(1)}초 ${e.team || ''} ${e.player ? `#${e.player} ` : ''}${e.type}${e.detail ? ` ${e.detail}` : ''}${e.result ? ` ${e.result}` : ''}` : '');
function logChange(action, before, after) {
  S.history.push({ at: new Date().toISOString(), action, id: (after || before || {}).id || null, before: brief(before), after: brief(after) });
  if (S.history.length > 2000) S.history.splice(0, S.history.length - 2000);
}
/** a record is deleted: an automatic or rebuilt one leaves a tombstone so re-analysis and rebuilding do not bring it back */
function removeEvent(e) {
  if (e.source === '자동' || e.derived || e.origin) S.removed.push(Stats.tombstone(e));
  logChange('삭제', e, null);
  S.events = S.events.filter((x) => x.id !== e.id);
}

function save() {
  lsSet(LS_WORK, { settings: settings(), events: S.events, saved: new Date().toISOString() });
}

/** After any change to the record: rebuild rebounds/turnovers from the shots as they are now. */
function changed() {
  for (const e of S.events) if (!e.id) e.id = uid();
  syncTeamIds();
  S.events = Flow.deriveQuarters(S.events, settingsFor, ctxFor);
  for (const e of S.events) if (!e.id) e.id = uid();
  syncTeamIds();
  render(); save();
}

/* ------------------------------------------------------------------ cameras and video frames */
const vidEl = (cam) => $(cam === 'B' ? 'vidB' : 'vid');
const camOffset = (cam) => (cam === 'B' ? settings().cam_offset : 0);
/** which camera shows this record: the shot's own camera, else the hoop it happened at */
function camOf(e) {
  if (!twoCam()) return 'A';
  if (e.cam === 'A' || e.cam === 'B') return e.cam;
  if (e.side) return e.side === '왼쪽' ? 'A' : 'B';
  const near = S.events.filter((x) => x.cam && qOf(x) === qOf(e) && Math.abs(x.time - e.time) <= 6).sort((a, b) => Math.abs(a.time - e.time) - Math.abs(b.time - e.time))[0];
  if (near) return near.cam;
  return Stats.teamFor('왼쪽', e.time, settingsFor(qOf(e))) === e.team ? 'A' : 'B';
}
function frameSize(cam) {
  const v = vidEl(cam);
  const w = v.videoWidth || PROC_W, h = v.videoHeight || Math.round(PROC_W * 9 / 16);
  return [PROC_W, Math.round((h * PROC_W) / w)];
}
function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.01));
    setTimeout(done, 4000);
  });
}
/** t: time in that camera's own video */
async function grab(t, canvas, cam = 'A') {
  const v = vidEl(cam);
  await seek(v, t);
  const [W, H] = frameSize(cam);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, W, H);
  return ctx;
}
/** grabs run one at a time on the shared hidden videos; a stale token skips the work */
function queueGrab(t, canvas, token, cam) {
  S.grabChain = S.grabChain.then(() => (token === S.sceneToken ? grab(t, canvas, cam) : null)).catch(() => null);
  return S.grabChain;
}
// same weights as OpenCV RGB->GRAY (fixed point, 14 bits)
function grayCrop(ctx, x0, y0, w, h) {
  const d = ctx.getImageData(x0, y0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 4899 + d[j + 1] * 9617 + d[j + 2] * 1868 + 8192) >> 14;
  return out;
}

/* ------------------------------------------------------------------ status */
function status(text) { $('status').textContent = text; }
function fmtSec(s) { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; }

/* ------------------------------------------------------------------ setup */
function fillColors() {
  for (const [id, def] of [['color_left', '빨강'], ['color_right', '남색']]) {
    const sel = $(id);
    sel.replaceChildren(...Object.keys(Export.TEAM_COLORS).map((n) => new Option(n, n)));
    sel.value = def;
  }
}
function reloadProfiles(select) {
  const names = Object.keys(profiles()).sort((a, b) => a.localeCompare(b, 'ko'));
  const sel = $('profileSel');
  const keep = select || sel.value;
  sel.replaceChildren(...(names.length ? names.map((n) => new Option(n, n)) : [new Option('(아직 없음 · 새로 만들기를 누르세요)', '')]));
  if (keep && names.includes(keep)) sel.value = keep;
  $('delProfileBtn').disabled = !names.length;
}
function applyMode() {
  document.body.classList.toggle('two', twoCam());
  $('videoLabel').textContent = twoCam() ? '왼쪽 골대 영상' : '경기 영상';
}
function checkBrowser() {
  const msgs = [];
  if (!('VideoDecoder' in window)) msgs.push('이 브라우저는 영상 분석 기능(WebCodecs)이 없습니다. 최신 Microsoft Edge 또는 Chrome에서 열어 주세요.');
  if (location.protocol === 'file:') msgs.push('파일을 직접 열면 분석이 동작하지 않습니다. 인터넷 주소(https://…)로 열어 주세요.');
  if (msgs.length) { $('browserWarn').textContent = msgs.join(' '); $('browserWarn').hidden = false; }
}

/* ------------------------------------------------------------------ video input */
function setVideo(cam, f) {
  const V = S.vids[cam], v = vidEl(cam), info = $(cam === 'B' ? 'videoInfoB' : 'videoInfo');
  if (V.url) URL.revokeObjectURL(V.url);
  V.file = f; V.url = URL.createObjectURL(f); V.ok = false; V.name = f.name;
  v.src = V.url;
  info.textContent = `${(f.size / 1048576).toFixed(0)}MB · 확인 중…`;
  v.onloadedmetadata = () => {
    V.duration = v.duration; V.ok = true;
    info.textContent = `${(f.size / 1048576).toFixed(0)}MB · ${fmtSec(v.duration)} · ${v.videoWidth}×${v.videoHeight}`;
    status(`영상 길이 ${fmtSec(v.duration)}. 체육관 설정을 고르고 '분석 시작'을 누르세요.`);
    save();
  };
  v.onerror = () => {
    info.textContent = '이 브라우저에서 재생할 수 없는 형식입니다';
    status('이 영상은 브라우저에서 열리지 않습니다. 최신 Edge에서 열어 보거나, 영상을 H.264(mp4)로 변환해 주세요.');
  };
}
/** a video was chosen: is it one already analysed (reconnect), the next quarter, a new file for this quarter, or a
    new game? Asked only when there are records; a quarter written in the file name (2쿼터, 2Q, Q2) is used. */
const quarterInName = (name) => { const m = name.match(/(?:^|[^0-9])([1-4])\s*(?:쿼터|q)(?![a-z])/i) || name.match(/(?:^|[^a-z])q\s*([1-4])(?![0-9])/i); return m ? Number(m[1]) : null; };
function knownQuarterOf(f) {
  const same = (v, n) => v && v.name === f.name && (!v.size || v.size === f.size) || n === f.name;
  return Object.entries(S.quarters).find(([, x]) => x && (same(x.video, x.video_name) || same(x.video_b, x.video_name_b)));
}
function askDialog(dlg, text) {
  return new Promise((resolve) => {
    $('newVidText').textContent = text;
    const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue || 'cancel'); };
    dlg.addEventListener('close', done);
    dlg.returnValue = ''; dlg.showModal();
  });
}
/** a new game: the records, quarters and analysis information of the last one go (team names and colours stay) */
function newGame() {
  S.runId++; stopWorkers(); finish();
  S.events = []; S.quarters = {}; S.removed = []; S.history = []; S.analysis = null; S.ctx = null; S.mostSeen = null; S.selId = null;
  $('quarter').value = '1'; $('switch_time').value = '';
  render(); save();
}
async function chooseVideo(cam, input) {
  const f = input.files[0];
  if (!f) return;
  const before = curQ(), known = knownQuarterOf(f), inName = quarterInName(f.name);
  let why = '';
  if (known) {
    $('quarter').value = known[0]; why = `전에 ${Stats.quarterName(Number(known[0]))}로 분석한 영상을 다시 연결`;
  } else {
    // the other camera of a pair being chosen goes with it (a pair is complete once both cameras are in)
    const partner = twoCam() && S.setChoice && !S.setChoice.cams.includes(cam) && Date.now() - S.setChoice.at < 10 * 60 * 1000;
    if (S.events.length && !partner) {
      const ans = await askDialog($('newVidDlg'), `${f.name}: 지금 기록(${Stats.quartersIn(S.events).map(Stats.quarterName).join('·')})과 어떻게 연결할까요? 새 경기를 시작하면 지금 기록은 지워집니다(필요하면 먼저 '작업 저장').`);
      if (ans === 'cancel') { input.value = ''; return; }
      if (ans === 'new') { newGame(); why = '새 경기'; if (inName) $('quarter').value = String(inName); }
      else if (ans === 'next') { $('quarter').value = String(inName || Math.min(7, Math.max(0, ...Stats.quartersIn(S.events)) + 1)); why = '같은 경기의 다음 쿼터'; }
      else why = `${Stats.quarterName(before)} 영상을 바꿈(다시 분석하면 이 쿼터의 자동 기록만 바뀜)`;
    } else if (!S.events.length && inName) { $('quarter').value = String(inName); why = '파일 이름'; }
    S.setChoice = partner ? { ...S.setChoice, cams: [...S.setChoice.cams, cam] } : { cams: [cam], at: Date.now() };
  }
  if (curQ() !== before) restoreQuarter();
  if (why) $('quarterNote').textContent = `${Stats.quarterName(curQ())}: ${why}. 다르면 '이 영상의 쿼터'를 바꾸세요.`;
  setVideo(cam, f);
}
$('videoInput').addEventListener('change', () => chooseVideo('A', $('videoInput')));
$('videoInputB').addEventListener('change', () => chooseVideo('B', $('videoInputB')));

/* ------------------------------------------------------------------ gym profile dialog */
const PF = { t: 0, cam: 'A', tBy: { A: 0, B: 0 }, marks: {}, ctx: null };
const pfSide = () => document.querySelector('input[name=pfSide]:checked').value;
const pfCamFor = (side) => (twoCam() && side === '오른쪽' ? 'B' : 'A');
async function pfShow() {
  PF.ctx = await grab(PF.t, $('pfCanvas'), PF.cam);
  const ctx = PF.ctx;
  for (const [side, m] of Object.entries(PF.marks)) {
    if (m.cam === PF.cam && Math.abs(m.t - PF.t) < 0.05) {
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(m.x, m.y, 9, 5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#00e5ff'; ctx.font = '14px sans-serif'; ctx.fillText(side, m.x - 14, m.y - 10);
    }
  }
  $('pfTime').textContent = `${PF.t.toFixed(1)}초`;
  $('pfRange').value = PF.t;
}
function pfUseSide() {
  const cam = pfCamFor(pfSide());
  if (cam !== PF.cam) { PF.tBy[PF.cam] = PF.t; PF.cam = cam; PF.t = PF.tBy[cam] || 0; }
  $('pfRange').max = (S.vids[PF.cam].duration || 0).toFixed(1);
  return pfShow();
}
$('newProfileBtn').addEventListener('click', async () => {
  if (!S.vids.A.ok || (twoCam() && !S.vids.B.ok)) {
    alert(twoCam() ? '먼저 왼쪽 골대 영상과 오른쪽 골대 영상을 모두 고르세요. 그 영상에서 골대 위치를 표시합니다.'
      : '먼저 이 체육관에서 찍은 경기 영상을 고르세요. 그 영상에서 골대 위치를 표시합니다.');
    return;
  }
  PF.t = 0; PF.cam = 'A'; PF.tBy = { A: 0, B: 0 }; PF.marks = {}; $('pfSnapNote').textContent = '';
  for (const side of SIDES) $(`thumb${side}`).getContext('2d').clearRect(0, 0, 168, 140);
  $('pfSave').disabled = true;
  document.querySelector('input[name=pfSide][value=왼쪽]').checked = true;
  $('profileDlg').showModal();
  await pfUseSide();
});
for (const r of document.querySelectorAll('input[name=pfSide]')) r.addEventListener('change', pfUseSide);
let pfTimer = null;
$('pfRange').addEventListener('input', () => {
  PF.t = parseFloat($('pfRange').value);
  $('pfTime').textContent = `${PF.t.toFixed(1)}초`;
  clearTimeout(pfTimer);
  pfTimer = setTimeout(pfShow, 120);
});
for (const b of document.querySelectorAll('[data-jump]')) {
  b.addEventListener('click', () => { PF.t = Math.min(Math.max(0, PF.t + parseFloat(b.dataset.jump)), S.vids[PF.cam].duration); pfShow(); });
}
$('pfCanvas').addEventListener('click', (ev) => {
  if (!PF.ctx) return;
  const c = $('pfCanvas');
  const cx0 = Math.round((ev.offsetX * c.width) / c.clientWidth), cy0 = Math.round((ev.offsetY * c.height) / c.clientHeight);
  const side = pfSide(), cam = PF.cam, t = PF.t;
  // re-grab without marks drawn
  grab(t, document.createElement('canvas'), cam).then((clean) => {
    // the analysis takes the rim at a fixed place in the hoop picture: move the click onto the rim found near it
    let x = cx0, y = cy0, note = '';
    if ($('pfSnap').checked) {
      const s = RimSnap.snapRim(clean.getImageData(0, 0, clean.canvas.width, clean.canvas.height).data, clean.canvas.width, clean.canvas.height, cx0, cy0);
      if (s.snapped) { x = s.x; y = s.y; note = s.moved ? `${side} 골대: 누른 곳에서 ${s.moved}칸 옮겨 림 한가운데에 맞췄습니다.` : `${side} 골대: 림 한가운데를 눌렀습니다.`; }
      else note = `${side} 골대: 누른 곳 가까이에서 림을 찾지 못해 누른 곳을 그대로 씁니다. 림 한가운데를 정확히 눌러 주세요.`;
    }
    $('pfSnapNote').textContent = note;
    // template = TW x TH gray patch whose centre sits RIM_DY*TH above the rim centre
    const x0 = Math.round(Math.min(Math.max(x - TW / 2, 0), c.width - TW));
    const y0 = Math.round(Math.min(Math.max(y - RIM_DY * TH - TH / 2, 0), c.height - TH));
    const g = grayCrop(clean, x0, y0, TW, TH);
    PF.marks[side] = { t, cam, x, y, tpl: g };
    const th = $(`thumb${side}`).getContext('2d');
    const img = th.createImageData(TW, TH);
    for (let i = 0; i < g.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g[i]; img.data[i * 4 + 3] = 255; }
    const tmp = document.createElement('canvas'); tmp.width = TW; tmp.height = TH; tmp.getContext('2d').putImageData(img, 0, 0);
    th.imageSmoothingEnabled = false; th.clearRect(0, 0, 168, 140); th.drawImage(tmp, 0, 0, 168, 140);
    $('pfSave').disabled = Object.keys(PF.marks).length < 1;   // one hoop is enough for a camera that films one half
    if (side === '왼쪽' && !PF.marks['오른쪽']) {
      document.querySelector('input[name=pfSide][value=오른쪽]').checked = true;
      pfUseSide();
    } else pfShow();
  });
});
$('pfSave').addEventListener('click', () => {
  const name = $('pfName').value.trim().replace(/[\\/:*?"<>|]/g, '') || '체육관';
  const all = profiles();
  if (all[name] && !confirm(`'${name}' 설정이 이미 있습니다. 바꿀까요?`)) return;
  all[name] = { created: new Date().toISOString() };
  for (const side of SIDES) if (PF.marks[side]) all[name][side] = { w: TW, h: TH, b64: b64(PF.marks[side].tpl) };
  if (!lsSet(LS_PROFILES, all)) { alert('브라우저 저장 공간에 저장하지 못했습니다.'); return; }
  $('profileDlg').close();
  reloadProfiles(name);
  status(`체육관 '${name}' 설정을 저장했습니다. 이제 '분석 시작'을 누르세요.`);
  save();
});
$('delProfileBtn').addEventListener('click', () => {
  const name = $('profileSel').value;
  if (!name || !confirm(`체육관 설정 '${name}'을(를) 지울까요?`)) return;
  const all = profiles(); delete all[name]; lsSet(LS_PROFILES, all); reloadProfiles();
});

/* ------------------------------------------------------------------ analysis */
/** A worker running `script` with message `msg`; progress messages go to onProgress, others (e.g. 'shot') to onOther. */
function runWorker(script, msg, onProgress, onOther) {
  return new Promise((resolve, reject) => {
    const w = new Worker(script);
    const end = () => { w.terminate(); S.workers = S.workers.filter((x) => x.w !== w); };
    S.workers.push({ w, reject });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') { end(); resolve(m.result); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
      else if (onOther) onOther(m);
    };
    w.onerror = (e) => { end(); reject(new Error(`분석 중 오류가 났습니다: ${e.message}`)); };
    w.postMessage(msg);
  });
}
function stopWorkers() {
  const list = S.workers; S.workers = [];
  for (const x of list) { x.w.terminate(); x.reject(new Error('cancelled')); }
}
/** whistles heard by either camera, on the record's clock */
function mergeWhistles(a, b, off) {
  const all = [...a, ...b.map((w) => ({ ...w, t: Math.round((w.t + off) * 100) / 100 }))].sort((x, y) => x.t - y.t), out = [];
  for (const w of all) {
    const p = out[out.length - 1];
    if (p && w.t - p.t <= 1.0) { if (w.dur > p.dur) out[out.length - 1] = w; } else out.push(w);
  }
  return out;
}
const soundText = (r) => (r.audio === 'ok' ? null : r.audio === 'none' ? '영상에 소리가 없음' : '이 브라우저가 소리 형식을 읽지 못함');

/* ------------------------------------------------------------------ players: teams, numbers, attack direction */
/** numbers typed (or filled in) for a team in step 1 */
function rosterList(team) {
  const s = settings(), [a, b] = teams();
  const raw = team === a ? s.roster_left : team === b ? s.roster_right : '';
  return (raw || '').split(/[\s,·/]+/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean);
}
/** a measured shirt colour (OpenCV Lab) -> the nearest colour name of the list in step 1 */
function colourName(lab) {
  const [L, a, b] = [lab[0], lab[1] - 128, lab[2] - 128];
  if (Math.hypot(a, b) < 12) return L >= 120 ? '흰색' : L >= 70 ? '회색' : b < -4 ? '남색' : '검정';
  const hexLab = (hex) => {               // sRGB -> OpenCV 8-bit Lab
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const X = (0.412453 * c[0] + 0.35758 * c[1] + 0.180423 * c[2]) / 0.950456, Y = 0.212671 * c[0] + 0.71516 * c[1] + 0.072169 * c[2];
    const Z = (0.019334 * c[0] + 0.119193 * c[1] + 0.950227 * c[2]) / 1.088754;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [(116 * f(Y) - 16) * 2.55, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  let best = '회색', bd = Infinity;
  for (const [name, hex] of Object.entries(Export.TEAM_COLORS)) {
    if (['흰색', '검정', '회색'].includes(name)) continue;
    const q = hexLab(hex), d = Math.hypot(0.5 * (q[0] - L), q[1] - a, q[2] - b);
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
const DEFAULT_TEAMS = ['빨강', '남색'];
/** Which of the two found teams is the team on the left of the page now (index), or null when nothing tells:
    the typed / earlier filled number lists first, then the team colours (both colours matching, or one when the
    colours were chosen by the user or filled by an earlier analysis, not just left at their defaults). */
function identify(found) {
  const [l, r] = teams(), L = rosterList(l), R = rosterList(r);
  const ov = (list, k) => list.filter((n) => found.teams[k].numbers.includes(n)).length;
  const sc = (ov(L, 0) - ov(L, 1)) - (ov(R, 0) - ov(R, 1));
  if (sc) return sc > 0 ? 0 : 1;
  const [fa, fb] = found.teams.map((t) => colourName(t.lab)), [cl, cr] = [$('color_left').value, $('color_right').value];
  if (fa === fb || cl === cr) return null;
  if (cl === fa && cr === fb) return 0;
  if (cl === fb && cr === fa) return 1;
  if (!S.coloursKnown) return null;
  if (cl === fa || cr === fb) return 0;
  if (cl === fb || cr === fa) return 1;
  return null;
}

/** Second stage: people, their shirt colours and numbers. Fills in step 1 (team colours and numbers, when the
    number lists are empty) and puts the shooter's number on shots where it was read near the moment the shooter
    held the ball and belongs to the team attacking that hoop. Returns a note for the status line. */
async function findPlayers(jobs, res, off, run, onProgress) {
  const per = (navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1, tasks = [], taskVi = [];
  jobs.forEach((j, vi) => {
    const shots = res[vi].shots.map((sh, k) => (sh.gather ? { id: `${j.cam}:${k}`, t: sh.gather.t, x: sh.gather.x, y: sh.gather.y, rimW: sh.gather.rimW, ball: sh.ball || [] } : null)).filter(Boolean);
    // missed shots: who has the ball after it (the rebounder)
    const misses = res[vi].shots.map((sh, k) => (!sh.made && sh.hoop ? { id: `${j.cam}:${k}`, end: sh.end, x: sh.hoop.x, y: sh.hoop.y, rimW: sh.hoop.w } : null)).filter(Boolean);
    const dur = res[vi].duration || S.vids[j.cam].duration || 0;
    const part = (list, p) => list.filter((_, k) => Math.floor((k * per) / Math.max(1, list.length)) === p);
    for (let p = 0; p < per; p++) {
      tasks.push({ cmd: 'players', file: j.file, procW: PROC_W, people: [(p * dur) / per, ((p + 1) * dur) / per], shots: part(shots, p), rebounds: part(misses, p) });
      taskVi.push(vi);
    }
  });
  // fetch the models once here, so the workers find them in the cache instead of each downloading them
  await Promise.all(['vendor/models/person.onnx', 'vendor/models/text-det.onnx', 'vendor/models/text-rec.onnx', 'vendor/ort-wasm-simd.wasm', 'vendor/ort.wasm.min.js']
    .map((u) => fetch(u).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)));
  const fr = tasks.map(() => 0);
  const out = await Promise.all(tasks.map((t, i) => runWorker('players.js', t, (m) => { fr[i] = m.frac; onProgress(fr.reduce((a, b) => a + b, 0) / fr.length); })));
  if (run.id !== S.runId) throw new Error('cancelled');     // cancelled or replaced while the workers ran: change nothing
  const results = out.flatMap((r) => r.shots);
  const byId = new Map(results.filter((x) => x.kind !== 'rebound').map((x) => [x.id, x]));
  const rebById = new Map(results.filter((x) => x.kind === 'rebound').map((x) => [x.id, x]));
  // team colours from the pictures where the play is in that half (6 or more people: fewer waiting players, people at
  // the side or practising at the empty hoop); all pictures when that finds no two teams
  const allPeople = out.flatMap((r, i) => r.people.map((p) => ({ ...p, k: `${taskVi[i]}:${p.t}` })));
  const perPic = new Map(); for (const p of allPeople) perPic.set(p.k, (perPic.get(p.k) || 0) + 1);
  const found = Players.findTeams(allPeople.filter((p) => perPic.get(p.k) >= 6)) || Players.findTeams(allPeople);
  const clock = (cam, t) => t + (cam === 'B' ? off : 0);
  const shotList = [];
  jobs.forEach((j, vi) => res[vi].shots.forEach((sh, k) => {
    const r = byId.get(`${j.cam}:${k}`) || { reads: [], look: null, lab: null, number: null };
    shotList.push({ sh, cam: j.cam, k, vi, r, reb: rebById.get(`${j.cam}:${k}`), side: sh.side, t: clock(j.cam, sh.start), lab: r.lab, number: r.number });
  }));
  const notes = [];
  // each team has this many players (subs included): extra numbers are misreadings or people not in the game
  const size = parseInt(settings().team_size, 10);
  if (found && size > 0) {
    for (const t of found.teams) {
      if (t.numbers.length <= size) continue;
      const keep = [...t.numbers].sort((x, y) => (t.seen[y] || 0) - (t.seen[x] || 0)).slice(0, size);
      t.numbers = t.numbers.filter((n) => keep.includes(n));
    }
  }
  // two fixed cameras: where the people stood (the defence stands nearer the hoop it defends), per camera, on the game clock
  const camsDir = jobs.length === 2 ? jobs.map((j, vi) => {
    const hs = res[vi].shots.map((sh) => sh.hoop).filter(Boolean);
    if (!hs.length) return null;
    const medOf = (k) => hs.map((h) => h[k]).sort((a, b) => a - b)[Math.floor(hs.length / 2)];
    return { side: vi ? '오른쪽' : '왼쪽', hoop: { x: medOf('x'), y: medOf('y') },
      people: out.filter((_, i) => taskVi[i] === vi).flatMap((r) => r.people).map((p) => ({ ...p, t: clock(j.cam, p.t) })) };
  }).filter(Boolean) : bothHoops() ? (() => {
    const hoopOf = (side) => { const hs = res[0].shots.filter((sh) => sh.side === side && sh.hoop).map((sh) => sh.hoop); if (!hs.length) return null;
      const medOf = (k) => hs.map((h) => h[k]).sort((a, b) => a - b)[Math.floor(hs.length / 2)]; return { x: medOf('x'), y: medOf('y') }; };
    const hl = hoopOf('왼쪽'), hr = hoopOf('오른쪽');
    if (!hl || !hr) return [];
    const mid = (hl.x + hr.x) / 2, people = out.flatMap((r) => r.people);
    return [{ side: '왼쪽', hoop: hl, people: people.filter((p) => p.x != null && p.x < mid) }, { side: '오른쪽', hoop: hr, people: people.filter((p) => p.x != null && p.x >= mid) }];
  })() : [];
  // which found team is team A (the page's first team): its number list first, then its colour
  const ident = found ? identify(found) : null;
  // the attack direction of each quarter (one window: the quarter analysed; a video holding several quarters: each span)
  const windows = run.windows || [{ q: run.q, from: -Infinity, to: Infinity }];
  const evid = windows.map((w) => {
    const inW = (t) => t >= w.from && t < w.to, prev = S.quarters[w.q] && S.quarters[w.q].dir;
    let switchT = prev && prev.switchSource === '사람' ? prev.switchT : null, switchSource = switchT != null ? '사람' : null;
    const sl = shotList.filter((x) => inW(x.t)), cd = camsDir.map((c) => ({ ...c, people: c.people.filter((p) => inW(p.t)) }));
    // a video holding both halves of one quarter's worth of play: the time the teams changed ends
    if (found && switchSource !== '사람' && windows.length === 1) {
      const sw = Players.findSwitch(Players.directionItems(found, sl, cd));
      if (sw) { switchT = Math.round(sw.t); switchSource = '자동'; notes.push(`두 팀이 ${switchT}초쯤 골대를 바꿈(전반·후반이 한 영상에 있음)`); }
    }
    const more = found ? cd.map((c) => Players.defenceScore(found, c.people, c.hoop, c.side, switchT)) : [];
    const autoDir = found ? Players.attackDirection(found, sl, switchT, more) : null;
    const pics = more.reduce((a, m) => a + m.pictures, 0);
    const how = autoDir ? `슈터 ${Math.abs(autoDir.shooters)}표${pics ? `, 수비 위치 ${Math.abs(more.reduce((a, m) => a + m.score, 0))}표(사진 ${pics}장)` : ''}` : '';
    return { w, prev, switchT, switchSource, more, autoDir, how };
  });
  // found team index -> A / B; nothing tells: the team found attacking the left hoop (first decided quarter) is A
  const firstAuto = evid.find((x) => x.autoDir);
  const idOfFound = (k) => (ident != null ? (k === ident ? 'A' : 'B') : firstAuto ? (k === firstAuto.autoDir.left ? 'A' : 'B') : (k === 0 ? 'A' : 'B'));
  const dirNotes = [];
  for (const x of [...evid].sort((a, b) => !!b.autoDir - !!a.autoDir)) {          // decided quarters first, the rest follow them
    const q = x.w.q, base = { switchT: x.switchT, switchSource: x.switchSource };
    if (x.prev && x.prev.source === '사람') {
      const agree = !x.autoDir || idOfFound(x.autoDir.left) === x.prev.left;
      S.quarters[q] = { ...S.quarters[q], dir: { ...x.prev, ...base } };
      dirNotes.push(`${Stats.quarterName(q)} 사람이 정한 방향${agree ? '' : `(영상으로는 반대로 보임: ${x.how})`}`);
    } else if (x.autoDir) {
      S.quarters[q] = { ...(S.quarters[q] || {}), dir: { left: idOfFound(x.autoDir.left), ...base, source: '자동', how: x.how, score: x.autoDir.score } };
      dirNotes.push(`${Stats.quarterName(q)} ${x.how}`);
    } else {
      if (S.quarters[q]) delete S.quarters[q].dir;
      const d = dirFor(q);
      S.quarters[q] = { ...(S.quarters[q] || {}), dir: { ...d, ...base, source: d.source === '기본' ? '기본' : '규칙', how: `영상으로 정하지 못함 — ${d.how}` } };
      dirNotes.push(`${Stats.quarterName(q)} 영상으로 정하지 못함(${d.how}${d.source === '기본' ? ', 1단계 공격 방향 표에서 고르세요' : ''})`);
    }
  }
  const dirNote = `공격 방향: ${dirNotes.join(' · ')}`;
  const q = run.q, more = evid.flatMap((x) => x.more), autoDir = firstAuto ? firstAuto.autoDir : null, dirHow = firstAuto ? firstAuto.how : '';
  if (found) {
    // colours: what the video shows, unless the user chose one; names still at their defaults become colour names
    const [ka, kb] = [0, 1].sort((x, y) => (idOfFound(x) === 'A' ? -1 : 1));
    const de = Math.hypot(...found.teams[0].lab.map((v, i) => v - found.teams[1].lab[i]));
    const filled = [];
    for (const [side, k] of [['left', ka], ['right', kb]]) {
      const t = found.teams[k], id = side === 'left' ? 'A' : 'B', info = S.teamInfo[id] = S.teamInfo[id] || {};
      const conf = t.count >= 40 && t.numbers.length >= 2 && de >= 25 ? '높음' : t.count >= 15 && de >= 15 ? '보통' : '낮음';
      Object.assign(info, { hex: t.colour, colourSeen: colourName(t.lab), people: t.count, numbers: t.numbers.join(' '), apart: Math.round(de), confidence: conf,
        evidence: `사람 사진 ${t.count}명, 번호 ${t.numbers.join('·') || '없음'}, 두 팀 색 차이 ${Math.round(de)}` });
      if (info.colourSource !== '사람') { $(`color_${side}`).value = colourName(t.lab); info.colourSource = '자동'; }
      if (!$(`roster_${side}`).value.trim()) { $(`roster_${side}`).value = t.numbers.join(' '); filled.push(side); }
    }
    S.coloursKnown = true;
    if ($('team_left').value.trim() === DEFAULT_TEAMS[0] && $('team_right').value.trim() === DEFAULT_TEAMS[1]) {
      let [nl, nr] = [$('color_left').value, $('color_right').value];
      if (nl === nr) { nl += ' A'; nr += ' B'; }
      $('team_left').value = nl; $('team_right').value = nr;
    }
    knownTeams = teams();
    const d = dirFor(q), [ta, tb] = teams();
    notes.push(`팀 자동 찾기: 팀 A ${ta}(${found.teams[ka].numbers.join('·') || '번호 없음'}), 팀 B ${tb}(${found.teams[kb].numbers.join('·') || '번호 없음'})`
      + `${de < 15 ? ' — 두 팀 색이 비슷해 구분이 약함, 1단계에서 확인하세요' : ''}. ${Stats.quarterName(q)} 왼쪽 골대 공격 ${nameOf(d.left)}. ${dirNote}`
      + (filled.length < 2 ? ' — 이미 적힌 등번호 명단은 그대로 둠' : ''));
  } else {
    notes.push(`팀을 셔츠 색으로 가리지 못함(사람이 적게 보임). ${dirNote}`);
  }
  console.info('[players]', JSON.stringify({ teams: found && found.teams.map((t) => ({ colour: t.colour, numbers: t.numbers, seen: t.seen, count: t.count })),
    others: found && found.others.map((t) => ({ colour: t.colour, numbers: t.numbers })), direction: autoDir && autoDir.votes, dirScore: autoDir && autoDir.score,
    defence: more.map((m) => ({ score: m.score, near: m.near, pictures: m.pictures })), how: dirHow, ident, dir: dirFor(q),
    shots: shotList.map((x) => [x.cam, Math.round(x.sh.start * 10) / 10, x.side, x.number, x.r.gap, x.r.runReads, x.r.reads.length]) }));
  const qOfT = (t) => (windows.find((w) => t >= w.from && t < w.to) || windows[0]).q;
  // shooters: a number read surely and on the attacking team's list; otherwise (when allowed) the most likely number of that list
  const guessing = $('auto_guess').checked;
  const prof = Players.lookProfiles(out.flatMap((r) => r.people), [...rosterList(teams()[0]), ...rosterList(teams()[1])]);
  // the fallback guess for somebody nobody could see: the team's most often seen number
  const mostSeen = (list) => [...list].sort((a, b) => ((prof[b] && prof[b].seen) || 0) - ((prof[a] && prof[a].seen) || 0))[0] || null;
  S.mostSeen = guessing ? Object.fromEntries(teams().map((t) => [t, mostSeen(rosterList(t))]).filter(([, n]) => n)) : null;
  // a guess only from the person's look and unsure reads; 'the team's most often seen number' is no better than chance
  // (labelled test game: shooters 5/20 right, chance about 22%), so a record with nothing to go on keeps no number
  const guessIn = (look, reads, list) => (guessing ? Players.guessNumber(look, reads, list, prof) : null);
  let auto = 0, guessed = 0;
  for (const x of shotList) {
    const team = Stats.teamFor(x.side, x.t, settingsFor(qOfT(x.t))), list = rosterList(team);
    // the shooter's nearest opponent: who fouled, if this shot was fouled (used when a whistle follows)
    const opp = teams().find((t) => t !== team), olist = rosterList(opp), d = x.r.def;
    if (d) {
      if (d.number && olist.includes(d.number)) x.sh.def = { team: opp, number: d.number, guess: false };
      else { const g = guessIn(d.look, d.reads, olist); if (g) x.sh.def = { team: opp, number: g.number, guess: true }; }
    }
    if (x.number && list.includes(x.number)) { Object.assign(x.sh, { player: x.number, playerAuto: true, playerGuess: false }); auto++; continue; }
    const g = guessIn(x.r.look, x.r.reads, list);
    if (g) { Object.assign(x.sh, { player: g.number, playerAuto: true, playerGuess: true }); guessed++; }
  }
  // rebounders, for each team (play flow decides which team got the ball): the shooter of a put-back within 3 s,
  // else a number read surely on the person under the hoop, else (when allowed) the most likely number
  let rebs = 0;
  for (const x of shotList) {
    if (x.sh.made) continue;
    const reb = {};
    const next = shotList.find((y) => y.vi === x.vi && y.side === x.side && y.sh.start > x.sh.end && y.sh.start <= x.sh.end + 3);
    for (const team of teams()) {
      const list = rosterList(team);
      if (next && next.sh.player && Stats.teamFor(next.side, next.t, settingsFor(qOfT(next.t))) === team) { reb[team] = { number: next.sh.player, guess: !!next.sh.playerGuess, how: '연속 슛' }; continue; }
      if (x.reb && x.reb.number && list.includes(x.reb.number)) { reb[team] = { number: x.reb.number, guess: false, how: '번호 읽음' }; continue; }
      const g = guessIn(x.reb ? x.reb.look : null, x.reb ? x.reb.reads : [], list);
      if (g) reb[team] = { number: g.number, guess: true, how: '추정' };
    }
    if (Object.keys(reb).length) { x.sh.reb = reb; rebs++; }
  }
  notes.push(`슛 ${shotList.length}개 중 ${auto}개의 슈터 번호를 읽어서 넣음` + (guessing ? `, ${guessed}개는 추정해서 넣음` : '') + `, 실패한 슛 ${shotList.filter((x) => !x.sh.made).length}개 중 ${rebs}개의 리바운드 선수를 찾음`);
  save();
  return notes.join(' · ');
}

async function runAnalysis() {
  const s = settings(), two = twoCam();
  if (!S.vids.A.file || (two && !S.vids.B.file)) { alert(two ? '왼쪽 골대 영상과 오른쪽 골대 영상을 모두 고르세요.' : '분석할 경기 영상을 고르세요.'); return; }
  const tpl = profileTemplates(s.profile);
  if (!tpl || Object.keys(tpl).length < 1) { alert("체육관 설정이 없습니다. '새로 만들기'에서 영상에 보이는 골대를 한 번 표시해 주세요."); return; }
  if (bothHoops() && !(tpl['왼쪽'] && tpl['오른쪽'])) { alert("양쪽 골대가 함께 보이는 촬영에는 이 영상에서 왼쪽·오른쪽 골대를 모두 표시한 체육관 설정이 필요합니다. '새로 만들기'에서 두 골대를 하나씩 표시해 주세요."); return; }
  if (two && !(tpl['왼쪽'] && tpl['오른쪽'])) { alert("카메라 2대 분석에는 왼쪽·오른쪽 골대가 모두 표시된 체육관 설정이 필요합니다. '새로 만들기'로 두 영상에서 골대를 하나씩 표시해 주세요."); return; }
  if (!('VideoDecoder' in window)) { alert('이 브라우저는 분석 기능을 지원하지 않습니다. 최신 Edge 또는 Chrome을 쓰세요.'); return; }
  const jobs = two
    ? [{ cam: 'A', name: '왼쪽 골대 영상', file: S.vids.A.file, tpl: { 왼쪽: tpl['왼쪽'] } }, { cam: 'B', name: '오른쪽 골대 영상', file: S.vids.B.file, tpl: { 오른쪽: tpl['오른쪽'] } }]
    : [{ cam: 'A', name: '', file: S.vids.A.file, tpl }];
  const withPlayers = $('auto_players').checked;
  // this analysis belongs to the quarter and files chosen now; a cancel, a new game or an opened work file in the
  // meantime makes it stale and its results are dropped
  const run = { id: ++S.runId, q: curQ(), files: jobs.map((j) => j.file), whole: wholeVideo() };
  S.setChoice = null;                     // the next video chosen starts a new set
  const stale = () => run.id !== S.runId;
  S.mostSeen = null;
  $('runBtn').disabled = true; $('cancelBtn').disabled = false; $('bar').value = 0;
  for (const id of ['videoInput', 'videoInputB', 'quarter', 'openWork', 'cam_mode', 'video_layout']) $(id).disabled = true;
  status('분석 준비 중… (처음에는 분석 도구를 내려받느라 조금 걸립니다)');
  const t0 = performance.now(), prog = jobs.map(() => ({ frac: 0, eta: null, label: '영상 읽는 중' }));
  const stage1 = withPlayers ? 0.6 : 1;          // share of the bar for the first stage
  const show = () => {
    const frac = prog.reduce((a, p) => a + p.frac, 0) / prog.length, etas = prog.map((p) => p.eta).filter((x) => x != null);
    $('bar').value = frac * stage1;
    const slow = prog.reduce((a, p) => (p.frac < a.frac ? p : a));
    status(`${withPlayers ? '1/2 ' : ''}${two ? '두 영상 함께 ' : ''}${slow.label} ${(frac * 100).toFixed(0)}%${etas.length === prog.length ? ` · 남은 시간 약 ${fmtSec(Math.max(...etas))}` : ''}`);
  };
  let res;
  try {
    res = await Promise.all(jobs.map((j, i) => runWorker('worker.js', { cmd: 'analyze', file: j.file, templates: j.tpl, both: bothHoops() },
      (m) => { prog[i] = { frac: m.frac, eta: m.eta ?? null, label: m.label }; show(); })));
  } catch (err) {
    if (stale()) return;
    stopWorkers(); finish();
    if (err.message !== 'cancelled') { status('분석하지 못했습니다.'); alert(err.message); }
    return;
  }
  if (stale()) return;
  let syncNote = '', off = 0;
  if (two) {
    const [a, b] = res;
    const sy = $('sync_mode').value === 'manual' ? { ok: false, manual: true } : Sync.offset(a.env, b.env);
    if (sy.manual) {
      $('syncInfo').textContent = '직접 적은 값을 씀';
      syncNote = ` 두 영상 시작 차이는 직접 적은 ${settings().cam_offset}초를 씀.`;
    } else if (sy.ok) {
      off = Math.round((sy.offset + (a.envStart || 0) - (b.envStart || 0)) * 100) / 100;
      $('cam_offset').value = off.toFixed(2);
      $('syncInfo').textContent = `소리로 자동 맞춤(일치도 ${sy.score})`;
      syncNote = ` 두 영상 시작 차이 ${off.toFixed(2)}초(소리로 맞춤).`;
    } else {
      $('syncInfo').textContent = '소리로 맞추지 못함 — 직접 적어 주세요';
      syncNote = ` 두 영상의 시작 차이를 소리로 맞추지 못해 ${settings().cam_offset}초로 두었습니다. 다르면 '두 영상 시작 차이'를 고치고 다시 분석하세요.`;
    }
    off = settings().cam_offset;
  }
  // two fixed cameras: shots at a hoop while the players are at the other end are practice (people waiting
  // to play, warming up): they are left out before the players stage and the record
  let practiceNote = '';
  if (two) {
    const split = Flow.splitPractice([{ shots: res[0].shots, track: res[0].track, offset: 0 }, { shots: res[1].shots, track: res[1].track, offset: off }]);
    const out = split.flatMap((x, i) => x.practice.map((sh) => sh.start + (i ? off : 0))).sort((x, y) => x - y);
    console.info('[practice]', JSON.stringify(split.map((x, i) => ({ cam: i, game: x.game.map((sh) => [Math.round(sh.start), sh.motionRatio]), practice: x.practice.map((sh) => [Math.round(sh.start), sh.motionRatio]),
      track: { n: res[i].track.length, valid: res[i].track.filter((r) => r[3] >= 0).length, first: res[i].track.slice(0, 3), mid: res[i].track.slice(1000, 1003) } }))));
    split.forEach((x, i) => { res[i].shots = x.game; });
    if (out.length) practiceNote = ` 경기가 반대쪽 골대에서 진행 중일 때의 슛 ${out.length}개는 빈 골대 연습으로 보고 뺌(${out.slice(0, 8).map((t) => t.toFixed(0)).join('·')}${out.length > 8 ? '…' : ''}초).`;
  }
  // one video holding several quarters: the spans the user set, else suggested from the long breaks in play
  let spanNote = '';
  if (run.whole) {
    const shotT = res.flatMap((r, i) => r.shots.map((sh) => sh.start + (i ? off : 0)));
    const slots = res.map((r, i) => Flow.slotMotion(r.track, i ? off : 0)).filter(Boolean);
    const motion = slots.length ? (t1, t2) => { const v = slots.map((m) => m.mean(t1, t2)).filter((x) => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; } : null;
    S.vids.A.duration = S.vids.A.duration || res[0].duration;
    const vkey = `${run.files[0].name}:${run.files[0].size}`;
    if (!(S.spans && S.spans.source === '사람' && S.spans.spans.length && (!S.spans.video || S.spans.video === vkey))) {
      const sg = suggestSpans(shotT, motion);
      S.spans = sg ? { ...sg, video: vkey } : { spans: [{ q: 1, start: 0, end: Math.round(S.vids.A.duration || 0) }], source: '기본', video: vkey,
        why: '쿼터 경계를 찾지 못함(쿼터 수만큼 긴 휴식이 보이지 않음) — 영상 보며 지정하세요' };
    }
    run.windows = windowsOf(S.spans.spans);
    spanNote = ` 쿼터 경계(${S.spans.source === '사람' ? '사람이 정함' : S.spans.source === '자동' ? '자동 제안' : '정하지 못함'}): ${S.spans.why}.`;
  }
  let playersNote = '';
  if (withPlayers) {
    const tp = performance.now();
    status('2/2 선수 번호·팀 찾는 중… (처음에는 모델 약 30MB를 내려받습니다)');
    try {
      playersNote = await findPlayers(jobs, res, off, run, (frac) => {
        $('bar').value = stage1 + (1 - stage1) * frac;
        const el = (performance.now() - tp) / 1000, eta = frac > 0.05 ? (el / frac) * (1 - frac) : null;
        status(`2/2 선수 번호·팀 찾는 중 ${(frac * 100).toFixed(0)}%${eta != null ? ` · 남은 시간 약 ${fmtSec(eta)}` : ''}`);
      });
    } catch (err) {
      if (err.message === 'cancelled' || stale()) { if (!stale()) finish(); return; }
      stopWorkers();
      playersNote = `선수 번호를 찾지 못함(${err.message})`;
    }
  }
  finish();
  let result;
  if (two) {
    const [a, b] = res;
    const shift = (sh) => ({ ...sh, start: sh.start + off, end: sh.end + off, made_t: sh.made_t == null ? null : sh.made_t + off, gather: sh.gather ? { ...sh.gather, t: sh.gather.t + off } : sh.gather });
    result = {
      shots: [...a.shots.map((sh) => ({ ...sh, cam: 'A' })), ...b.shots.map((sh) => ({ ...shift(sh), cam: 'B' }))],
      cams: [{ id: 'A', side: '왼쪽', track: a.track, offset: 0 }, { id: 'B', side: '오른쪽', track: b.track, offset: off }],
      whistles: mergeWhistles(a.whistles || [], b.whistles || [], off),
    };
    S.vids.A.duration = S.vids.A.duration || a.duration;
  } else {
    result = res[0];
    if (bothHoops()) result.both = true;
  }
  // (the team's most often seen number is not used as a guess: measured no better than chance)
  if (stale()) return;
  const s2 = settingsFor(run.q), q = run.q;
  // each quarter is worked out on its own (its own attack direction, no rebound or turnover across quarters)
  const windows = run.windows || [{ q, from: -Infinity, to: Infinity }];
  const vkey = `${run.files[0].name}:${run.files[0].size}`;
  const outs = windows.map((w) => {
    const inW = (t) => t >= w.from && t < w.to;
    const rq = { ...result, shots: result.shots.filter((sh) => inW(sh.start)), whistles: (result.whistles || []).filter((x) => inW(x.t)) };
    const o = Flow.infer(rq, settingsFor(w.q));
    for (const e of o.events) {
      e.q = w.q; e.vk = vkey;
      if (run.whole) { const a = Stats.qAt(S.spans.spans, e.release ?? e.time); e.qUnsure = !!(a && a.unsure); }
    }
    return o;
  });
  const out = outs[0];
  S.ctx = out.ctx;
  S.events = Stats.mergeReanalysis(S.events, outs.flatMap((o) => o.events), run.whole ? windows.map((w) => w.q) : q, S.removed);
  const fid = (f) => (f ? { name: f.name, size: f.size, lastModified: f.lastModified } : null);
  windows.forEach((w, i) => {
    const sp = run.whole ? S.spans.spans.find((x) => x.q === w.q) : null;
    S.quarters[w.q] = { ...(S.quarters[w.q] || {}), ctx: outs[i].ctx, video: fid(run.files[0]), video_b: two ? fid(run.files[1]) : null,
      video_name: s2.video_name, video_name_b: two ? s2.video_name_b : '', cam_offset: two ? off : 0, vk: vkey,
      span: sp ? { start: sp.start, end: sp.end } : null, duration: S.vids.A.duration || 0, at: new Date().toISOString() };
  });
  const n = { ...out.summary };
  for (const o of outs.slice(1)) for (const [k, v] of Object.entries(o.summary)) if (typeof v === 'number') n[k] += v;
  const noSound = res.map(soundText).filter(Boolean)[0];
  const sound = noSound ? `${noSound}(파울·자유투는 판정하지 않음)`
    : n.mode === 'pan' ? `휘슬로 보이는 소리 ${n.whistles}번 중 경기가 멈춘 ${n.fouls}번을 파울로 판단`
      : n.mode === 'two' ? `휘슬 같은 소리 ${n.whistles}번 중 슛 순간 휘슬 뒤 같은 골대에서 자유투가 나온 ${n.pf}번을 슈팅파울로 판단(나머지는 파울로 세지 않음)`
        : `휘슬 같은 소리 ${n.unknownWhistles}개를 검토 목록에 올림(고정 카메라 1대에서는 파울을 자동으로 가리지 않음)`;
  const vis = res.map((r, i) => (r.hoops ? `왼쪽 골대 보임 ${Math.round(100 * (r.hoops['왼쪽'] || 0))}%, 오른쪽 골대 보임 ${Math.round(100 * (r.hoops['오른쪽'] || 0))}%${r.dualDropped ? `(두 골대에서 같은 때 잡힌 슛 ${r.dualDropped}개는 하나로)` : ''}`
    : `${two ? (i ? '오른쪽 영상 ' : '왼쪽 영상 ') : ''}골대 보임 ${(100 * (1 - r.visibility['없음'])).toFixed(0)}%`)).join(', ');
  status(`${run.whole ? `경기 전체(${windows.map((w) => Stats.quarterName(w.q)).join('·')})` : Stats.quarterName(q)} 분석 끝(${fmtSec((performance.now() - t0) / 1000)}): 야투 ${n.fg}개(성공 ${n.made}) · 자유투 ${n.ft}개 · 리바운드 ${n.reb}개(공격 ${n.oreb}) · `
    + `턴오버 ${n.to}개 · 파울 ${n.pf}개 · ${sound}. ${vis}.${syncNote}${practiceNote}${spanNote}${playersNote ? ` ${playersNote}.` : ''} 다음은 '빠른 검토'.`);
  S.analysis = { version: APP_VERSION, at: new Date().toISOString(), mode: two ? '카메라 2대' : '카메라 1대', players: withPlayers ? '켜짐' : '꺼짐', status: $('status').textContent };
  if (res.some((r) => r.visibility['없음'] > 0.7)) alert("골대를 거의 찾지 못한 영상이 있습니다. 다른 체육관이나 다른 카메라 위치라면 '새로 만들기'로 체육관 설정을 새로 만들어 주세요.");
  changed();
  // with everything filled in automatically nothing may be left to check
  const oc = openCounts(run.whole ? null : q), left = Object.values(oc).reduce((a, b) => a + b, 0);
  if (run.whole) renderSpans();
  status($('status').textContent.replace("다음은 '빠른 검토'.", left
    ? `아직 사람이 확인하지 않은 것: ${countsText(oc)}('빠른 검토'에서 종류를 골라 확인). 자동 기록은 틀릴 수 있습니다(사용법의 정확도 참고).`
    : '열린 항목은 없지만 자동 기록은 틀릴 수 있습니다(사용법의 정확도 참고).'));
  S.analysis.status = $('status').textContent;
  S.analysis.quarter = Stats.quarterName(q);
  S.quarters[q].analysis = S.analysis;
  save();
}
$('runBtn').addEventListener('click', runAnalysis);
$('auto_players').checked = lsGet('hoopstat.autoPlayers', true) !== false;
$('auto_players').addEventListener('change', () => lsSet('hoopstat.autoPlayers', $('auto_players').checked));
$('auto_guess').checked = lsGet('hoopstat.autoGuess', true) !== false;
$('auto_guess').addEventListener('change', () => lsSet('hoopstat.autoGuess', $('auto_guess').checked));
function finish() {
  $('runBtn').disabled = false; $('cancelBtn').disabled = true;
  for (const id of ['videoInput', 'videoInputB', 'quarter', 'openWork', 'cam_mode', 'video_layout']) $(id).disabled = false;
}
$('cancelBtn').addEventListener('click', () => { S.runId++; stopWorkers(); finish(); status('분석을 취소했습니다. 이 분석의 결과는 기록에 넣지 않습니다.'); });

/* ------------------------------------------------------------------ quarters inside one video (step 2) */
const wholeVideo = () => $('video_layout').value === 'whole';
function applyLayout() {
  $('spanWrap').hidden = !wholeVideo();
  $('quarterRow').hidden = wholeVideo();
}
const fmtClock = (sec) => { const t = Math.max(0, Math.round(sec)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
/** windows of the record's clock for each quarter of one video: cut halfway through each break */
function windowsOf(spans) {
  const list = [...spans].filter((x) => x.start != null && x.end != null).sort((a, b) => a.start - b.start);
  return list.map((x, i) => ({ q: x.q, from: i ? (list[i - 1].end + x.start) / 2 : -Infinity, to: i + 1 < list.length ? (x.end + list[i + 1].start) / 2 : Infinity }));
}
function renderSpans() {
  const sp = (S.spans && S.spans.spans) || [];
  $('spanTable').tBodies[0].replaceChildren(...sp.map((x, i) => {
    const tr = document.createElement('tr');
    const qs = document.createElement('select');
    for (let q = 1; q <= 7; q++) qs.append(new Option(Stats.quarterName(q), String(q)));
    qs.value = String(x.q);
    const inp = (k) => { const el = document.createElement('input'); el.inputMode = 'decimal'; el.size = 7; el.value = x[k] ?? ''; el.addEventListener('change', () => editSpan(i, { [k]: num(el.value) })); return el; };
    qs.addEventListener('change', () => editSpan(i, { q: Number(qs.value) }));
    tr.append(tdOf(qs), tdOf(inp('start')), tdOf(inp('end')), cell(x.start != null && x.end != null ? fmtClock(x.end - x.start) : ''));
    return tr;
  }));
  if (S.spans && S.spans.why) $('spanNote').textContent = `${S.spans.source === '사람' ? '사람이 고친 경계' : S.spans.source === '자동' ? '자동 제안' : ''}: ${S.spans.why}`;
}
/** quarter spans changed: each record of this video goes to the quarter holding it (by the moment the shot left the
    hand when known); a record whose team came from the hoop follows the new quarter's direction; everything the user
    did to the records stays */
function editSpan(i, change) {
  S.spans = S.spans || { spans: [], source: '사람', why: '' };
  if (i == null) S.spans.spans.push(change); else Object.assign(S.spans.spans[i], change);
  S.spans.source = '사람';
  S.spans.why = '사람이 정함';
  reassignQuarters();
}
function reassignQuarters() {
  const sp = (S.spans && S.spans.spans) || [];
  if (!sp.length) { render(); save(); return; }
  let moved = 0;
  for (const e of S.events) {
    if (S.spans.video && e.vk && e.vk !== S.spans.video) continue;
    const a = Stats.qAt(sp, e.release ?? e.time);
    if (!a) continue;
    const old = qOf(e);
    e.qUnsure = a.unsure;
    if (a.q === old) continue;
    const swap = !e.derived && e.team && e.source === '자동' && !e.edited
      && Stats.teamFor('왼쪽', e.time, settingsFor(old)) !== Stats.teamFor('왼쪽', e.time, settingsFor(a.q));
    e.q = a.q; moved++;
    if (swap) { const id = idOf(e.team); if (id) { e.team = nameOf(otherId(id)); e.tid = otherId(id); } }
  }
  for (const x of sp) if (S.quarters[x.q]) S.quarters[x.q].span = { start: x.start, end: x.end };
  S.history.push({ at: new Date().toISOString(), action: '쿼터 경계', id: null, before: '', after: sp.map((x) => `${Stats.quarterName(x.q)} ${x.start}~${x.end}초`).join(', ') });
  status(`쿼터 경계를 바꿈: 기록 ${moved}개의 쿼터가 바뀜.`);
  renderSpans();
  changed();
}
$('video_layout').addEventListener('change', () => { applyLayout(); save(); });
$('spanAdd').addEventListener('click', () => {
  const sp = (S.spans && S.spans.spans) || [], last = sp[sp.length - 1];
  editSpan(null, { q: last ? Math.min(7, last.q + 1) : 1, start: last ? last.end : 0, end: S.vids.A.duration ? Math.round(S.vids.A.duration) : null });
});
$('spanAuto').addEventListener('click', () => {
  const sg = suggestSpans();
  if (!sg) { alert('슛이 오래 없는 휴식 구간을 쿼터 수만큼 찾지 못했습니다. 영상 보며 시작·끝을 지정해 주세요.'); return; }
  S.spans = { ...sg, video: S.spans && S.spans.video };
  reassignQuarters();
});
/** suggested spans from the record's shots and the camera motion saved with the analysis */
function suggestSpans(shotTimes, motion) {
  const shots = shotTimes || S.events.filter((e) => isShot(e)).map((e) => e.release ?? e.time);
  const nQ = Math.max(1, parseInt($('q_count').value, 10) || 4), qLen = (num($('q_len').value) || 10) * 60;
  const duration = S.vids.A.duration || Math.max(0, ...shots) + 30;
  const r = Stats.suggestQuarters({ shots, duration, nQ, qLen, motion });
  return r ? { spans: r.spans, source: '자동', why: r.why } : null;
}
$('spanView').addEventListener('click', () => {
  if (!S.vids.A.url) { alert('1단계에서 경기 영상을 먼저 고르세요.'); return; }
  const v = $('spanVideo');
  if (v.src !== S.vids.A.url) v.src = S.vids.A.url;
  const sp = (S.spans && S.spans.spans) || [];
  $('spanQ').replaceChildren(...[...new Set([...sp.map((x) => x.q), 1, 2, 3, 4])].sort((a, b) => a - b).map((q) => new Option(Stats.quarterName(q), String(q))));
  $('spanDlg').showModal();
});
$('spanVideo').addEventListener('timeupdate', () => { $('spanPos').textContent = `영상 ${$('spanVideo').currentTime.toFixed(1)}초`; });
for (const [id, k] of [['spanSetStart', 'start'], ['spanSetEnd', 'end']]) {
  $(id).addEventListener('click', () => {
    const q = Number($('spanQ').value), t = Math.round($('spanVideo').currentTime * 10) / 10;
    const sp = (S.spans && S.spans.spans) || [], i = sp.findIndex((x) => x.q === q);
    if (i < 0) editSpan(null, { q, start: k === 'start' ? t : null, end: k === 'end' ? t : null }); else editSpan(i, { [k]: t });
  });
}

/* ------------------------------------------------------------------ teams and attack direction (step 1) */
function tdOf(el) { const td = document.createElement('td'); td.append(el); return td; }
function renderTeams() {
  for (const [side, id] of [['left', 'A'], ['right', 'B']]) {
    const t = S.teamInfo[id] || {}, sw = $(`swatch_${side}`), info = $(`teamInfo_${side}`);
    if (t.hex) { sw.style.background = t.hex; sw.title = `영상에서 찾은 색 ${t.hex}`; } else sw.removeAttribute('style');
    info.textContent = t.hex ? `${t.colourSource === '사람' ? '색은 사람이 고름' : '색 자동'} · 영상에서 본 색 ${t.colourSeen} · ${t.evidence} · 신뢰도 ${t.confidence}` : '';
    info.classList.toggle('warn', t.confidence === '낮음');
  }
  const qs = [...new Set([...Stats.quartersIn(S.events), ...Object.keys(S.quarters).map(Number), curQ()])].sort((x, y) => x - y);
  const [a, b] = teams();
  $('dirTable').tBodies[0].replaceChildren(...qs.map((q) => {
    const d = dirFor(q), tr = document.createElement('tr');
    const sel = document.createElement('select');
    sel.append(new Option(a, 'A'), new Option(b, 'B')); sel.value = d.left;
    sel.setAttribute('aria-label', `${Stats.quarterName(q)} 왼쪽 골대 공격 팀`);
    sel.addEventListener('change', () => setDirection(q, { left: sel.value }));
    const sw = document.createElement('input');
    sw.inputMode = 'decimal'; sw.size = 7; sw.placeholder = '없음'; sw.value = d.switchT ?? '';
    sw.setAttribute('aria-label', `${Stats.quarterName(q)} 두 팀이 골대를 바꾸는 시각`);
    sw.addEventListener('change', () => setDirection(q, { switchT: num(sw.value) }));
    const src = d.source === '사람' ? '사람이 정함' : d.source === '자동' ? `영상: ${d.how}` : d.how;
    tr.append(cell(Stats.quarterName(q)), tdOf(sel), cell(nameOf(otherId(d.left))), tdOf(sw),
      cell(`${src}${d.switchT != null ? ` · ${d.switchT}초부터 반대(${d.switchSource === '사람' ? '사람' : '자동'})` : ''}`, 'l'));
    if (d.source === '기본') tr.className = 'warn';
    return tr;
  }));
}
/** The user sets a quarter's attack direction or switch time. Records whose team came from the hoop (automatic
    shots, free throws, fouls, whistle guesses) change team where the left hoop now has the other team; records a
    person confirmed or edited change only when the user agrees (they are listed). Numbers put in automatically go:
    they were looked up in the other team's list (a new analysis finds them again). */
function setDirection(q, change) {
  const before = settingsFor(q), old = dirFor(q);
  const nd = { ...old, ...change, source: '사람', how: '사람이 정함' };
  if ('switchT' in change) nd.switchSource = change.switchT == null ? null : '사람';
  S.quarters[q] = { ...(S.quarters[q] || {}), dir: nd };
  const after = settingsFor(q);
  const moved = (e) => Stats.teamFor('왼쪽', e.time, before) !== Stats.teamFor('왼쪽', e.time, after);
  const list = S.events.filter((e) => qOf(e) === q && e.team && !e.derived && moved(e));
  const autoOnes = list.filter((e) => e.source === '자동' && !e.checked && !e.edited), confirmed = list.filter((e) => !autoOnes.includes(e));
  const also = confirmed.length > 0 && confirm(`${Stats.quarterName(q)}: 자동 기록 ${autoOnes.length}개는 팀이 바뀝니다. 사람이 확인하거나 고친 기록 ${confirmed.length}개도 바꿀까요?\n${confirmed.slice(0, 8).map(brief).join('\n')}${confirmed.length > 8 ? '\n…' : ''}`);
  const swapTeam = (e) => {
    const id = idOf(e.team); if (!id) return;
    e.team = nameOf(otherId(id)); e.tid = otherId(id);
    if (e.playerAuto) { e.player = ''; e.playerAuto = false; e.playerGuess = false; }
  };
  for (const e of autoOnes) swapTeam(e);
  if (also) for (const e of confirmed) swapTeam(e);
  S.history.push({ at: new Date().toISOString(), action: '공격 방향', id: null,
    before: `${Stats.quarterName(q)} 왼쪽 ${nameOf(old.left)}${old.switchT != null ? `, ${old.switchT}초부터 반대` : ''}`,
    after: `${Stats.quarterName(q)} 왼쪽 ${nameOf(nd.left)}${nd.switchT != null ? `, ${nd.switchT}초부터 반대` : ''}` });
  status(`${Stats.quarterName(q)} 공격 방향을 바꿈: 자동 기록 ${autoOnes.length}개의 팀을 바꿈${confirmed.length ? `, 확인된 기록 ${confirmed.length}개는 ${also ? '함께 바꿈' : '그대로 둠'}` : ''}. 자동으로 넣은 번호는 지웠습니다(다시 분석하면 그 팀 명단에서 다시 찾음).`);
  changed();
}

/* ------------------------------------------------------------------ tables */
function cell(text, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; }
const selIndex = () => S.events.findIndex((e) => e.id === S.selId);
function render() {
  knownTeams = teams();
  renderTeams();          // names set by the app (loading, team finding) are what the records use
  S.events.sort(Stats.byTime);
  const manyQ = Stats.quartersIn(S.events).length > 1 || S.events.some((e) => qOf(e) > 1);
  // which records the table shows: all, one quarter, or those whose quarter is unsure (a break, near a boundary)
  const fsel = $('evFilter'), fwant = fsel.value, qsAll = Stats.quartersIn(S.events);
  const nUnsure = S.events.filter((e) => e.qUnsure).length;
  fsel.replaceChildren(new Option('모든 기록', ''), ...qsAll.map((q) => new Option(Stats.quarterName(q), `q${q}`)), ...(nUnsure ? [new Option(`쿼터 확인 필요 ${nUnsure}개(경계 근처·휴식 중)`, 'unsure')] : []));
  fsel.value = [...fsel.options].some((o) => o.value === fwant) ? fwant : '';
  const shown = (e) => (!fsel.value ? true : fsel.value === 'unsure' ? !!e.qUnsure : qOf(e) === Number(fsel.value.slice(1)));
  const spanOf = (q) => (S.quarters[q] && S.quarters[q].span) || null;
  const timeText = (e) => {
    const sp = spanOf(qOf(e)), qn = qOf(e) <= 4 ? `${qOf(e)}Q` : `OT${qOf(e) - 4}`;
    if (sp && sp.start != null) return `${qn} ${fmtClock(e.time - sp.start)}${e.qUnsure ? '?' : ''} (영상 ${Number(e.time).toFixed(1)})`;
    return `${manyQ ? `${qn} ` : ''}${Number(e.time).toFixed(1)}`;
  };
  const tb = $('eventTable').tBodies[0];
  tb.replaceChildren(...S.events.filter(shown).map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    if (e.id === S.selId) tr.className = 'sel';
    const src = cell(''); const pill = document.createElement('span');
    pill.className = `pill ${e.source === '자동' ? 'auto' : 'manual'}`; pill.textContent = e.source || '수동'; src.append(pill);
    tr.append(cell(timeText(e)), cell(e.teamGuess && e.team ? `${e.team} (추정)` : e.team), cell(e.playerAuto && e.player ? `${e.player} (${e.playerGuess ? '추정' : '자동'})` : e.player), cell(e.type), cell(e.detail),
      cell(e.result, e.result === '성공' ? 'made' : ''), src, cell(e.confidence), cell(e.note, 'note'));
    return tr;
  }));
  $('emptyEvents').hidden = S.events.length > 0;
  const oc = openCounts(null), nOpen = Object.values(oc).reduce((a, b) => a + b, 0);
  const auto = S.events.filter((e) => e.source === '자동' || e.origin).length;
  $('reviewSummary').textContent = S.events.length
    ? `기록 ${S.events.length}개(자동 ${auto}) · 사람이 확인하지 않은 것 ${nOpen ? countsText(oc) : '없음'} · 번호: 읽음 ${S.events.filter((e) => Stats.playerState(e) === '읽음').length}, 추정 ${S.events.filter((e) => Stats.playerState(e) === '추정').length}, 사람 ${S.events.filter((e) => Stats.playerState(e) === '사람').length}`
    : '';
  renderBox();
  $('checks').replaceChildren(...Stats.checks(S.events).map((m) => Object.assign(document.createElement('li'), { textContent: m })));
}
function teamColor(t) {
  const s = settings(), [a, b] = teams();
  return t === a ? Export.TEAM_COLORS[s.color_left] : t === b ? Export.TEAM_COLORS[s.color_right] : '#8a8f99';
}
function chipFor(t) { const c = document.createElement('span'); c.className = 'chip'; c.style.background = teamColor(t) || '#8a8f99'; return c; }
function statHead(first) {
  const head = document.createElement('tr');
  head.append(Object.assign(document.createElement('th'), { textContent: first }));
  for (const k of Stats.COLS) {
    const th = document.createElement('th'); th.textContent = k;
    if (Stats.KO[k]) { const sm = document.createElement('small'); sm.textContent = Stats.KO[k]; th.append(sm); }
    head.append(th);
  }
  return head;
}
function statRow(label, st, cls) {
  const tr = document.createElement('tr'); if (cls) tr.className = cls;
  tr.append(cell(label));
  for (const k of Stats.COLS) tr.append(cell(Stats.fmt(k, st[k]), k === 'PTS' ? 'pts' : st[k] === 0 ? 'zero' : ''));
  return tr;
}
function renderBox() {
  const tm = teams(), qs = Stats.quartersIn(S.events);
  // points per quarter (shown once a second quarter is there)
  const ls = Stats.linescore(S.events, tm), many = qs.length > 1 || qs.some((q) => q > 1);
  $('lineWrap').hidden = !many;
  if (many) {
    const hr = document.createElement('tr');
    hr.append(Object.assign(document.createElement('th'), { textContent: '팀' }), ...ls.qs.map((q) => Object.assign(document.createElement('th'), { textContent: Stats.quarterName(q) })),
      Object.assign(document.createElement('th'), { textContent: '합계' }));
    $('lineTable').tHead.replaceChildren(hr);
    const top = Math.max(...ls.rows.map((r) => r.total));
    $('lineTable').tBodies[0].replaceChildren(...ls.rows.map((r) => {
      const tr = document.createElement('tr'), name = cell(''); name.append(chipFor(r.team), document.createTextNode(r.team));
      tr.append(name, ...r.pts.map((p) => cell(p)), cell(r.total, r.total === top && ls.rows.some((x) => x.total !== top) ? 'lead' : ''));
      return tr;
    }));
  }
  // which part of the game the tables show: the whole game or one quarter
  const sel = $('boxQuarter'), want = sel.value;
  sel.replaceChildren(new Option('경기 전체', ''), ...qs.map((q) => new Option(Stats.quarterName(q), String(q))));
  sel.value = qs.includes(Number(want)) ? want : '';
  $('boxQuarterWrap').hidden = !many;
  const part = sel.value ? S.events.filter((e) => qOf(e) === Number(sel.value)) : S.events;
  const box = Stats.boxScore(part, tm, { guess: $('boxGuess').checked });
  // team comparison
  const h = document.createElement('tr');
  h.append(Object.assign(document.createElement('th'), { textContent: '항목' }));
  for (const t of tm) { const th = document.createElement('th'); th.append(chipFor(t), document.createTextNode(t)); h.append(th); }
  $('teamTable').tHead.replaceChildren(h);
  $('teamTable').tBodies[0].replaceChildren(...Stats.teamCompare(box, tm).map((r) => {
    const tr = document.createElement('tr');
    const lead = r.key === 'PTS' && r.va !== r.vb ? (r.va > r.vb ? 0 : 1) : -1;
    tr.append(cell(r.label), cell(r.a, lead === 0 ? 'lead' : ''), cell(r.b, lead === 1 ? 'lead' : ''));
    return tr;
  }));
  // one table per team: players, then the team total
  const T = Object.fromEntries(box.teams);
  const blocks = box.teams.map(([t]) => {
    const div = document.createElement('div'); div.className = 'team-block';
    const h4 = document.createElement('h4'); h4.append(chipFor(t), document.createTextNode(`${t} · ${T[t].PTS}점`));
    const table = document.createElement('table'); table.className = 'grid stats';
    table.createTHead().append(statHead('등번호'));
    const body = table.createTBody();
    for (const [p, ps] of box.players[t] || []) body.append(statRow(/^\d+$/.test(p) ? `#${p}` : p, ps, 'player-row'));
    body.append(statRow('팀 합계', T[t], 'total'));
    const sc = document.createElement('div'); sc.className = 'scroll'; sc.append(table);
    div.append(h4, sc);
    return div;
  });
  $('playerTables').replaceChildren(...blocks);
}
$('boxQuarter').addEventListener('change', renderBox);
$('evFilter').addEventListener('change', render);
$('boxGuess').addEventListener('change', () => { lsSet('hoopstat.boxGuess', $('boxGuess').checked); renderBox(); });
$('boxGuess').checked = lsGet('hoopstat.boxGuess', true) !== false;
$('eventTable').tBodies[0].addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr'); if (!tr) return;
  S.selId = tr.dataset.id; render();
});
$('eventTable').tBodies[0].addEventListener('dblclick', (ev) => {
  const tr = ev.target.closest('tr'); if (!tr) return;
  S.selId = tr.dataset.id; openEvent(S.events[selIndex()], S.selId);
});
function needSel() {
  if (selIndex() < 0) { alert('표에서 줄을 하나 고르세요.'); return false; }
  return true;
}
for (const [id, pane] of [['tabEvents', 'paneEvents'], ['tabBox', 'paneBox']]) {
  $(id).addEventListener('click', () => {
    for (const [i2, p2] of [['tabEvents', 'paneEvents'], ['tabBox', 'paneBox']]) {
      $(i2).setAttribute('aria-selected', String(i2 === id)); $(p2).hidden = p2 !== pane;
    }
  });
}

/* ------------------------------------------------------------------ event dialog */
let evId = null;
function syncDetail(keep) {
  const type = $('evType').value, opts = Stats.DETAILS[type] || [];
  const cur = keep ?? $('evDetail').value;
  $('evDetail').replaceChildren(new Option('', ''), ...opts.map((o) => new Option(o, o)));
  $('evDetail').value = opts.includes(cur) ? cur : (opts[0] || '');
  const hasResult = type === '야투' || type === '자유투';
  $('evResult').disabled = !hasResult;
  if (!hasResult) $('evResult').value = '';
  else if (!$('evResult').value) $('evResult').value = '실패';
}
function openEvent(e, id) {
  evId = id;
  $('eventTitle').textContent = id == null ? '사건 추가' : '사건 수정';
  $('evTeam').replaceChildren(...teams().map((t) => new Option(t, t)));
  $('evType').replaceChildren(...Stats.TYPES.map((t) => new Option(t, t)));
  $('evTime').value = Number(e.time).toFixed(1);
  $('evQuarter').value = String(e.q != null ? qOf(e) : curQ());
  if (e.team && ![...$('evTeam').options].some((o) => o.value === e.team)) $('evTeam').append(new Option(e.team, e.team));
  $('evTeam').value = e.team || teams()[0];
  $('evPlayer').value = e.player || '';
  $('evType').value = e.type || '리바운드';
  $('evResult').value = e.result || '';
  syncDetail(e.detail || '');
  $('evNote').value = e.note || '';
  $('eventDlg').showModal();
}
$('evType').addEventListener('change', () => syncDetail());
$('eventDlg').addEventListener('close', () => {
  if ($('eventDlg').returnValue !== 'ok') return;
  const t = num($('evTime').value);
  if (t == null) { alert('시각은 초 단위 숫자로 적어 주세요. 예: 83.5'); return; }
  const i = evId == null ? -1 : S.events.findIndex((x) => x.id === evId);
  const base = i < 0 ? {} : S.events[i];
  const e = { ...base, id: base.id || uid(), q: Number($('evQuarter').value) || 1, time: Math.round(t * 10) / 10, team: $('evTeam').value, player: $('evPlayer').value.trim(), type: $('evType').value,
    detail: $('evDetail').value, result: $('evResult').disabled ? '' : $('evResult').value, note: $('evNote').value.trim(), source: '수동',
    confidence: base.confidence || '', derived: false, checked: true };
  e.playerAuto = !!base.playerAuto && e.player === base.player;
  e.playerGuess = e.playerAuto && !!base.playerGuess;
  if (base.time != null && Math.abs(base.time - e.time) > 0.05) delete e.end;      // the old end no longer fits
  if (i >= 0 && (base.source === '자동' || base.origin)) e.edited = true;
  logChange(i < 0 ? '추가' : '수정', i < 0 ? null : base, e);
  if (i < 0) S.events.push(e); else S.events[i] = e;
  S.selId = e.id;
  changed();
});
$('editBtn').addEventListener('click', () => { if (needSel()) openEvent(S.events[selIndex()], S.selId); });
$('addBtn').addEventListener('click', () => {
  const base = selIndex() >= 0 ? S.events[selIndex()] : null;
  openEvent({ time: base ? base.time + 1 : 0, q: base ? qOf(base) : curQ(), team: teams()[0], type: '리바운드', detail: '수비' }, null);
});
$('delBtn').addEventListener('click', () => {
  if (!needSel()) return;
  const e = S.events[selIndex()];
  if (!confirm(`${e.time}초 ${e.team} ${e.type} 기록을 지울까요?${e.source === '자동' ? ' 다시 분석해도 다시 넣지 않습니다.' : ''}`)) return;
  removeEvent(e); S.selId = null;
  changed();
});

/* ------------------------------------------------------------------ scene viewer + quick review */
const NO_PLAYER = new Set(['휘슬']);
const isShot = (e) => e.type === '야투' || e.type === '자유투';
/** still to do in the quick review: an automatic shot nobody confirmed (unless its shooter's number was read automatically), or a record without a jersey number */
/** still open in the quick review (Stats.openItems: result not confirmed, number guessed or missing, whistle not
    judged), limited to what is chosen beside the quick-review button */
function needsReview(e) {
  const items = Stats.openItems(e), want = $('reviewWhat').value;
  if (!want) return items.length > 0;
  return items.some((x) => x.startsWith(want));
}
/** open items of the chosen quarter (or all), counted by kind */
function openCounts(q) {
  const c = {};
  for (const e of S.events) if (q == null || qOf(e) === q) for (const x of Stats.openItems(e)) c[x] = (c[x] || 0) + 1;
  return c;
}
const countsText = (c) => Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ');
function rosterOf(team) {
  const s = settings(), [a, b] = teams();
  const raw = team === a ? s.roster_left : team === b ? s.roster_right : '';
  const list = (raw || '').split(/[\s,·/]+/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean);
  // numbers already used for this team, so the buttons also work without a roster
  for (const e of S.events) if (e.team === team && /^\d+$/.test((e.player || '').trim()) && !list.includes(e.player.trim())) list.push(e.player.trim());
  return list.sort((x, y) => (/^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y, 'ko')));
}
/** id of the next record to review after the record with this id (or from the start) */
function nextToReview(afterId) {
  const n = S.events.length, from = afterId == null ? 0 : S.events.findIndex((e) => e.id === afterId) + 1, q = curQ();
  for (let k = 0; k < n; k++) {
    const e = S.events[(from + k) % n];
    if (qOf(e) === q && needsReview(e) && !S.skipped.has(e.id)) return e.id;
  }
  return null;
}
/** the chosen videos are this quarter's (or nothing says otherwise) */
function videosOfQuarter(q) {
  const x = S.quarters[q];
  if (q !== curQ()) return false;
  return !x || !x.video_name || !S.vids.A.name || x.video_name === S.vids.A.name;
}
async function showScene(id, keepCam) {
  const e = S.events.find((x) => x.id === id);
  if (!e) { $('sceneDlg').close(); return; }
  if (!videosOfQuarter(qOf(e))) {
    const x = S.quarters[qOf(e)];
    alert(`이 기록은 ${Stats.quarterName(qOf(e))} 영상${x && x.video_name ? `(${x.video_name})` : ''}에 있습니다. 2단계 '이 영상의 쿼터'를 ${Stats.quarterName(qOf(e))}로 하고 1단계에서 그 영상을 고르면 장면을 볼 수 있습니다.`);
    if ($('sceneDlg').open) $('sceneDlg').close();
    return;
  }
  S.selId = id; render();
  if (!keepCam) S.sceneCam = camOf(e);
  let cam = S.sceneCam;
  if (!S.vids[cam].ok) cam = S.sceneCam = cam === 'A' ? 'B' : 'A';
  const token = ++S.sceneToken;
  const vt = e.time - camOffset(cam);              // the moment in that camera's own video
  const what = `${Number(e.time).toFixed(1)}초 ${e.team} ${e.type}${e.detail ? ` ${e.detail}` : ''}${e.result ? ` ${e.result}` : ''}`;
  $('sceneTitle').textContent = `${S.reviewing ? '빠른 검토' : '장면 보기'} · ${what}${twoCam() ? ` · ${cam === 'A' ? '왼쪽' : '오른쪽'} 카메라` : ''}`;
  $('sceneCam').hidden = !(twoCam() && S.vids.A.ok && S.vids.B.ok);
  $('numBar').hidden = !S.reviewing;
  if (S.reviewing) {
    const left = S.events.filter((x) => qOf(x) === curQ() && needsReview(x) && !S.skipped.has(x.id)).length;
    const wh = e.type === '휘슬';
    $('resBar').hidden = !isShot(e);
    $('whBar').hidden = !wh;
    $('numRow').hidden = $('numButtons').hidden = $('numTools').hidden = wh;
    $('resMade').setAttribute('aria-pressed', String(e.result === '성공'));
    $('resMiss').setAttribute('aria-pressed', String(e.result === '실패'));
    $('kind2').setAttribute('aria-pressed', String(e.type === '야투' && e.detail !== '3점'));
    $('kind3').setAttribute('aria-pressed', String(e.type === '야투' && e.detail === '3점'));
    $('kindFt').setAttribute('aria-pressed', String(e.type === '자유투'));
    const [ta, tb] = teams();
    $('whA').textContent = `${ta} 파울`; $('whB').textContent = `${tb} 파울`;
    // the team the app guessed is marked (one press confirms it)
    $('whA').setAttribute('aria-pressed', String(wh && !!e.teamGuess && e.team === ta));
    $('whB').setAttribute('aria-pressed', String(wh && !!e.teamGuess && e.team === tb));
    $('numAsk').textContent = `${e.team} ${isShot(e) ? '슛한' : e.type === '리바운드' ? '공을 잡은' : e.type === '턴오버' ? '공을 잃은' : e.type === '파울' ? '파울한' : ''} 선수 등번호`;
    $('numLeft').textContent = `· 남은 기록 ${left}개`;
    const btns = rosterOf(e.team).map((p) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = /^\d+$/.test(p) ? `#${p}` : p;
      b.addEventListener('click', () => setNumber(p));
      return b;
    });
    if (!btns.length) btns.push(Object.assign(document.createElement('span'), { className: 'muted', textContent: '1단계에 팀 등번호 명단을 적으면 번호 버튼이 생깁니다. 지금은 아래 칸에 번호를 적으세요.' }));
    $('numButtons').replaceChildren(...btns);
    $('numInput').value = '';
  }
  const sv = $('sceneVideo');
  const start = Math.max(0, vt - 2);
  const go = () => { sv.currentTime = start; if (S.reviewing) sv.play().catch(() => {}); };
  if (sv.dataset.cam !== cam || sv.src !== S.vids[cam].url) { sv.dataset.cam = cam; sv.src = S.vids[cam].url; sv.onloadedmetadata = go; } else if (sv.readyState >= 1) go(); else sv.onloadedmetadata = go;
  if (!$('sceneDlg').open) $('sceneDlg').showModal();
  const figs = [];
  for (const dt of [-1, -0.5, 0, 0.5, 1, 1.5]) {
    const t = Math.max(0, vt + dt);
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    fig.append(c, Object.assign(document.createElement('figcaption'), { textContent: `${(e.time + dt).toFixed(1)}초` }));
    figs.push([t, c, fig]);
  }
  $('sceneGrid').replaceChildren(...figs.map((f) => f[2]));
  for (const [t, c] of figs) queueGrab(t, c, token, cam);
}
function reviewNext(afterId) {
  const next = nextToReview(afterId);
  if (next == null) {
    $('sceneDlg').close();
    status('검토할 기록이 더 없습니다. 박스스코어 탭에서 팀·선수 기록을 확인하세요.');
    return;
  }
  showScene(next);
}
function setResult(result) {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e || !isShot(e)) return;
  Object.assign(e, { result, checked: true, confidence: '확인' });
  changed();                                         // rebounds follow the corrected result
  showScene(e.id, true);
}
function setNumber(p) {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e) return;
  e.player = String(p).trim(); e.playerAuto = false; e.playerGuess = false;
  if (isShot(e) && !e.checked) Object.assign(e, { checked: true, confidence: '확인' });   // a number means the result shown was accepted
  changed();
  reviewNext(e.id);
}
function videosOk() {
  if (!S.vids.A.ok && !(twoCam() && S.vids.B.ok)) { alert('영상을 찾을 수 없습니다. 1단계에서 경기 영상을 다시 골라 주세요.'); return false; }
  return true;
}
$('sceneBtn').addEventListener('click', () => {
  if (!needSel() || !videosOk()) return;
  S.reviewing = false; showScene(S.selId);
});
$('numBtn').addEventListener('click', () => {
  if (!videosOk()) return;
  S.skipped = new Set();
  const cur = S.events[selIndex()];
  const start = cur && qOf(cur) === curQ() && needsReview(cur) ? cur.id : nextToReview(null);
  if (start == null) { alert(`${Stats.quartersIn(S.events).length > 1 ? `${Stats.quarterName(curQ())}에 ` : ''}검토할 기록이 없습니다. 바꾸려면 줄을 두 번 눌러 수정하세요.`); return; }
  S.reviewing = true; showScene(start);
});
$('resMade').addEventListener('click', () => setResult('성공'));
$('resMiss').addEventListener('click', () => setResult('실패'));
$('resNot').addEventListener('click', () => {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e) return;
  const after = S.events[selIndex() - 1];
  removeEvent(e);
  changed();
  reviewNext(after ? after.id : null);
});
/** 2-point / 3-point field goal or free throw (team rule: one free throw, worth the fouled shot's 2 or 3) */
function setKind(kind) {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e || !isShot(e)) return;
  if (kind === 'ft') Object.assign(e, { type: '자유투', detail: e.detail === '3점' || e.detail === '3점슛 파울' ? '3점슛 파울' : '2점슛 파울' });
  else Object.assign(e, { type: '야투', detail: kind === '3' ? '3점' : '2점' });
  e.userKind = true;
  changed();
  showScene(e.id, true);
}
$('kind2').addEventListener('click', () => setKind('2'));
$('kind3').addEventListener('click', () => setKind('3'));
$('kindFt').addEventListener('click', () => setKind('ft'));
function whistleIsFoul(team) {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e) return;
  const detail = e.teamGuess && e.team === team && e.guessDetail ? e.guessDetail : '개인파울';
  Object.assign(e, { type: '파울', team, detail, teamGuess: false, source: '수동', checked: true, confidence: '확인', note: `휘슬 소리를 듣고 사람이 파울로 판단. ${e.noteBase ?? e.note ?? ''}`.slice(0, 200) });
  changed();
  showScene(e.id, true);                              // now ask who fouled
}
$('whA').addEventListener('click', () => whistleIsFoul(teams()[0]));
$('whB').addEventListener('click', () => whistleIsFoul(teams()[1]));
$('whNot').addEventListener('click', () => $('resNot').click());
$('numEnter').addEventListener('click', () => { const v = $('numInput').value.replace(/^#/, '').trim(); if (v) setNumber(v); });
$('numInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('numEnter').click(); }
});
$('numUnknown').addEventListener('click', () => setNumber('미상'));
$('numSkip').addEventListener('click', () => { S.skipped.add(S.selId); reviewNext(S.selId); });
$('sceneCam').addEventListener('click', () => { S.sceneCam = S.sceneCam === 'A' ? 'B' : 'A'; showScene(S.selId, true); });
$('sceneReplay').addEventListener('click', () => {
  const e = S.events.find((x) => x.id === S.selId); const sv = $('sceneVideo');
  if (!e) return;
  sv.currentTime = Math.max(0, e.time - camOffset(S.sceneCam || 'A') - 2); sv.play();
});
$('sceneDlg').addEventListener('close', () => { $('sceneVideo').pause(); S.reviewing = false; S.sceneToken++; render(); });

/* ------------------------------------------------------------------ saving */
function baseName() {
  const n = S.vids.A.file ? S.vids.A.file.name.replace(/\.[^.]+$/, '') : '박스스코어';
  return `${n}_박스스코어`;
}
$('xlsxBtn').addEventListener('click', () => {
  if (typeof XLSX === 'undefined') { alert('엑셀 도구를 아직 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.'); return; }
  Export.download(`${baseName()}.xlsx`, Export.xlsxBlob(S.events, settings()));
});
$('htmlBtn').addEventListener('click', () => Export.download(`${baseName()}.html`, new Blob([Export.htmlText(S.events, settings())], { type: 'text/html' })));
$('csvBtn').addEventListener('click', () => Export.download(`${baseName()}.csv`, new Blob([Export.csvText(S.events)], { type: 'text/csv' })));
$('saveWorkBtn').addEventListener('click', () => {
  // everything needed to go on on another PC: settings (teams, directions, quarters, spans, sync, the files of each
  // quarter by name and size), the records with their states, deletions and edit history, and the gym profile
  const st = settings();
  const data = { app: 'HoopStat', version: 3, appVersion: APP_VERSION, saved: new Date().toISOString(), settings: st, events: S.events,
    profile: st.profile && profiles()[st.profile] ? { name: st.profile, data: profiles()[st.profile] } : null };
  Export.download(`${baseName()}.hoopstat.json`, new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
});
$('openWork').addEventListener('change', async () => {
  const f = $('openWork').files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'HoopStat') throw new Error('HoopStat 작업 파일이 아닙니다.');
    // the gym profile travels with the work file: add it here when this browser does not have it
    if (d.profile && d.profile.name && d.profile.data && !profiles()[d.profile.name]) { const all = profiles(); all[d.profile.name] = d.profile.data; lsSet(LS_PROFILES, all); reloadProfiles(d.profile.name); }
    applyWork(d.settings || {}, d.events || []);
    const files = Object.entries(S.quarters).filter(([, x]) => x && (x.video || x.video_name)).map(([q, x]) => `${Stats.quarterName(Number(q))}: ${(x.video && x.video.name) || x.video_name}${x.video_b || x.video_name_b ? ` + ${(x.video_b && x.video_b.name) || x.video_name_b}` : ''}`);
    status(`작업을 열었습니다: ${f.name}. 장면을 보거나 다시 분석하려면 같은 영상을 1단계에서 다시 고르세요(이름·크기로 알아봄)${files.length ? ` — ${files.join(' · ')}` : ''}.`);
  } catch (err) {
    alert(`작업 파일을 열지 못했습니다: ${err.message}`);
  }
  $('openWork').value = '';
});
function applyWork(s, events) {
  S.runId++; stopWorkers(); finish();
  for (const id of SETTING_IDS) if (s[id] != null) $(id).value = s[id];
  if (!$('cam_mode').value) $('cam_mode').value = 'pan';
  applyMode();
  if (s.profile) reloadProfiles(s.profile);
  S.vids.A.name = s.video_name || ''; S.vids.B.name = s.video_name_b || '';
  if (!S.vids.A.duration) S.vids.A.duration = s.duration || 0;
  S.ctx = s.flow || null;
  S.analysis = s.analysis || null;
  S.coloursKnown = !!s.colours_known;
  S.removed = Array.isArray(s.removed) ? s.removed : [];
  S.teamInfo = s.teamInfo && typeof s.teamInfo === 'object' ? { A: {}, B: {}, ...s.teamInfo } : { A: {}, B: {} };
  S.spans = s.spans && Array.isArray(s.spans.spans) ? s.spans : null;
  if (!$('video_layout').value) $('video_layout').value = 'per';
  if (!$('sync_mode').value) $('sync_mode').value = 'auto';
  applyLayout();
  S.history = Array.isArray(s.history) ? s.history : [];
  // quarters: a record from before them is all the 1st quarter, analysed from the videos it names
  S.quarters = s.quarters && typeof s.quarters === 'object' ? s.quarters
    : (s.video_name || s.flow ? { 1: { ctx: s.flow || null, video_name: s.video_name || '', video_name_b: s.video_name_b || '' } } : {});
  // saves from before teams A/B: the first team was the one attacking the left hoop (sides) and one switch time
  for (const [k, x] of Object.entries(S.quarters)) {
    if (!x || x.dir) continue;
    if (x.sides) x.dir = { left: x.sides[0] === (s.team_right || '') ? 'B' : 'A', switchT: x.switch_time ?? null, source: '자동', how: '이전 판에서 정함' };
    else if (Number(k) === 1 && s.switch_time != null && s.switch_time !== '') x.dir = { left: 'A', switchT: Number(s.switch_time), switchSource: '사람', source: '사람', how: '이전 판의 설정' };
  }
  S.events = events; S.selId = null;
  for (const e of S.events) { if (!e.id) e.id = uid(); if (e.q == null) e.q = 1; }
  // a record saved before team renames were carried over can hold a third team in its rebounds/turnovers: rebuild them
  const names = teams();
  if (S.events.some((e) => e.derived && e.team && !names.includes(e.team))) S.events = Flow.deriveQuarters(S.events, settings(), ctxFor);
  for (const e of S.events) if (!e.id) e.id = uid();
  render(); save();
}
// Team names as the records know them (kept by render): a name changed after the analysis is changed in the
// records too (otherwise the rebuilt rebounds and turnovers go to a third team with the new name).
/** a quarter was chosen: its camera offset and which team attacked which hoop come back (when it was analysed) */
function restoreQuarter() {
  const x = S.quarters[curQ()];
  if (!x) return;
  if (twoCam() && x.cam_offset != null) $('cam_offset').value = Number(x.cam_offset).toFixed(2);
}
function renameTeams() {
  const now = teams(), map = new Map();
  if (!knownTeams) { knownTeams = now; return false; }
  knownTeams.forEach((old, i) => { if (old && now[i] && old !== now[i] && now[1 - i] !== old) map.set(old, now[i]); });
  knownTeams = now;
  if (!map.size) return false;
  for (const e of S.events) {
    if (map.has(e.team)) e.team = map.get(e.team);
    if (e.reb) e.reb = Object.fromEntries(Object.entries(e.reb).map(([k, v]) => [map.get(k) || k, v]));
  }
  return true;
}
for (const id of SETTING_IDS) {
  $(id).addEventListener('change', () => {
    if (id === 'cam_mode') applyMode();
    if (id === 'team_left' || id === 'team_right') { if (renameTeams()) { changed(); return; } }
    if (id === 'quarter') restoreQuarter();
    if (id === 'color_left' || id === 'color_right') S.coloursKnown = true;
    if (id === 'cam_offset') {
      const x = S.quarters[curQ()], nv = settings().cam_offset, old = x && x.cam_offset != null ? Number(x.cam_offset) : null;
      $('sync_mode').value = 'manual';
      if (x && old != null && Math.abs(nv - old) > 0.005) {
        const vk = x.vk, d = nv - old;
        let n = 0;
        for (const e of S.events) {
          if (e.cam !== 'B' || (vk ? e.vk !== vk : qOf(e) !== curQ())) continue;
          e.time = Math.round((e.time + d) * 10) / 10;
          if (e.end != null) e.end = Math.round((e.end + d) * 10) / 10;
          if (e.release != null) e.release = Math.round((e.release + d) * 10) / 10;
          n++;
        }
        for (const q of Object.keys(S.quarters)) if (!vk || S.quarters[q].vk === vk) S.quarters[q].cam_offset = nv;
        status(`두 영상 시작 차이를 ${old.toFixed(2)} → ${nv.toFixed(2)}초로 바꿈: 오른쪽 카메라 기록 ${n}개의 시각을 ${d > 0 ? '+' : ''}${d.toFixed(2)}초 옮김. 슛 찾기는 바뀌지 않으니, 크게 바꿨으면 다시 분석하세요.`);
        if (S.spans && S.spans.spans.length && wholeVideo()) { reassignQuarters(); return; }
        changed(); return;
      }
      if (x) x.cam_offset = nv;
    }
    if (id === 'color_left' || id === 'color_right') { const t = S.teamInfo[id === 'color_left' ? 'A' : 'B'] = S.teamInfo[id === 'color_left' ? 'A' : 'B'] || {}; t.colourSource = '사람'; }
    render(); save();
  });
}
$('profileSel').addEventListener('change', save);

/* ------------------------------------------------------------------ install (PWA) */
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null; $('installBtn').hidden = true;
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ------------------------------------------------------------------ start */
fillColors();
reloadProfiles();
checkBrowser();
applyMode();
const prev = lsGet(LS_WORK, null);
if (prev && (prev.events || []).length) {
  applyWork(prev.settings || {}, prev.events || []);
  status(`이전 작업(${(prev.events || []).length}건)을 불러왔습니다. 장면을 보거나 다시 분석하려면 영상을 다시 골라 주세요.`);
} else {
  if (prev && prev.settings) { for (const id of SETTING_IDS) if (prev.settings[id] != null && id !== 'cam_offset') $(id).value = prev.settings[id]; applyMode(); if (prev.settings.profile) reloadProfiles(prev.settings.profile); }
  render();
}
