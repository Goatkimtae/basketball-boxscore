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
const S = { vids: { A: newVid(), B: newVid() }, events: [], selId: null, workers: [], ctx: null, quarters: {},
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
const SETTING_IDS = ['cam_mode', 'team_left', 'color_left', 'team_right', 'color_right', 'roster_left', 'roster_right', 'team_size', 'switch_time', 'cam_offset', 'title', 'quarter'];
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const twoCam = () => $('cam_mode').value === 'two';
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
  return s;
}
/** the quarter of the videos chosen now (step 2): analyses, the quick review and new records go there */
const curQ = () => Number($('quarter').value) || 1;
// qOf(e): the record's quarter (stats.js, shared by the page's scripts)
function teams() { const s = settings(); return [s.team_left || '팀 A', s.team_right || '팀 B']; }
let knownTeams = null;
const flowCtx = () => S.ctx || { mode: twoCam() ? 'two' : 'pan', segs: [] };
/** the play-flow ctx of a quarter (filming mode, camera looks): the one saved with its analysis */
const ctxFor = (q) => (S.quarters[q] && S.quarters[q].ctx) || flowCtx();

function save() {
  lsSet(LS_WORK, { settings: settings(), events: S.events, saved: new Date().toISOString() });
}

/** After any change to the record: rebuild rebounds/turnovers from the shots as they are now. */
function changed() {
  for (const e of S.events) if (!e.id) e.id = uid();
  S.events = Flow.deriveQuarters(S.events, settings(), ctxFor);
  for (const e of S.events) if (!e.id) e.id = uid();
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
  return Stats.teamFor('왼쪽', e.time, settings()) === e.team ? 'A' : 'B';
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
/** a video was chosen: pick its quarter. A video analysed before goes back to its quarter; a quarter written in
    the file name (2쿼터, 2Q, Q2) is used; otherwise a new video while the chosen quarter has records goes to the
    quarter after the last one with records. */
function autoQuarter(name) {
  const before = curQ();
  const known = Object.entries(S.quarters).find(([, x]) => x && (x.video_name === name || x.video_name_b === name));
  const m = name.match(/(?:^|[^0-9])([1-4])\s*(?:쿼터|q)(?![a-z])/i) || name.match(/(?:^|[^a-z])q\s*([1-4])(?![0-9])/i);
  if (known) $('quarter').value = known[0];
  else if (m) $('quarter').value = m[1];
  else if (S.events.some((e) => qOf(e) === before)) $('quarter').value = String(Math.min(7, Math.max(...Stats.quartersIn(S.events)) + 1));
  if (curQ() !== before) restoreQuarter();
  if (curQ() !== before) $('quarterNote').textContent = `이 영상을 ${Stats.quarterName(curQ())}로 정했습니다(${known ? '전에 분석한 영상' : m ? '파일 이름' : `${Stats.quarterName(before)}에 이미 기록이 있음`}). 다르면 바꾸세요.`;
}
$('videoInput').addEventListener('change', () => { const f = $('videoInput').files[0]; if (f) { autoQuarter(f.name); setVideo('A', f); } });
$('videoInputB').addEventListener('change', () => { const f = $('videoInputB').files[0]; if (f) { autoQuarter(f.name); setVideo('B', f); } });

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
async function findPlayers(jobs, res, off, onProgress) {
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
  const results = out.flatMap((r) => r.shots);
  const byId = new Map(results.filter((x) => x.kind !== 'rebound').map((x) => [x.id, x]));
  const rebById = new Map(results.filter((x) => x.kind === 'rebound').map((x) => [x.id, x]));
  const found = Players.findTeams(out.flatMap((r) => r.people));
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
  }).filter(Boolean) : [];
  // a video holding both halves: the time the teams changed ends (filled in when the box is empty)
  if (found && settings().switch_time == null) {
    const sw = Players.findSwitch(Players.directionItems(found, shotList, camsDir));
    if (sw) { $('switch_time').value = String(Math.round(sw.t)); notes.push(`공격 방향이 ${Math.round(sw.t)}초쯤 바뀜(전반·후반이 한 영상에 있음) — '공격 방향 바뀌는 시각'에 넣음`); }
  }
  const swNow = settings().switch_time;
  const more = found ? camsDir.map((c) => Players.defenceScore(found, c.people, c.hoop, c.side, swNow)) : [];
  let dir = found ? Players.attackDirection(found, shotList, swNow, more) : null, dirHow = '';
  if (dir) {
    const pics = more.reduce((a, m) => a + m.pictures, 0);
    dirHow = `슈터 ${Math.abs(dir.shooters)}표${pics ? `, 수비 위치 ${Math.abs(more.reduce((a, m) => a + m.score, 0))}표(사진 ${pics}장)` : ''}`;
  }
  // which found team is the page's left team now: typed number lists first, then the team colours
  const ident = found ? identify(found) : null;
  if (found && !dir) {
    // the same game's other quarters: the same ends in the same half, the other ends after half time (FIBA 9.5;
    // overtime goes on like the 4th quarter)
    const q = curQ(), half = (x) => (x <= 2 ? 1 : 2);
    const ref = Object.entries(S.quarters).map(([k, x]) => [Number(k), x]).filter(([k, x]) => k !== q && x && x.sides)
      .sort((a, b) => Math.abs(a[0] - q) - Math.abs(b[0] - q))[0];
    const [pl, pr] = teams();
    if (ref && ident != null && ref[1].sides.includes(pl) && ref[1].sides.includes(pr)) {
      const same = half(ref[0]) === half(q), leftName = same ? ref[1].sides[0] : ref[1].sides[1];
      dir = { left: leftName === pl ? ident : 1 - ident };
      dirHow = `${Stats.quarterName(ref[0])}${same ? '와 같은 방향' : '의 반대(후반에 골대를 바꿈)'}으로 추정`;
    } else if (ident != null) {
      dir = { left: ident }; dirHow = '고른 팀 색·명단(영상으로는 정하지 못함)';
    }
  }
  console.info('[players]', JSON.stringify({ teams: found && found.teams.map((t) => ({ colour: t.colour, numbers: t.numbers, seen: t.seen })),
    others: found && found.others.map((t) => ({ colour: t.colour, numbers: t.numbers })), direction: dir && dir.votes, dirScore: dir && dir.score,
    defence: more.map((m) => ({ score: m.score, near: m.near, pictures: m.pictures })), how: dirHow, ident,
    shots: shotList.map((x) => [x.cam, Math.round(x.sh.start * 10) / 10, x.side, x.number, x.r.gap, x.r.runReads, x.r.reads.length]) }));
  if (found && dir) {
    const left = found.teams[dir.left], right = found.teams[1 - dir.left];
    // the page's teams follow the video: the page's left team was found attacking the right hoop -> they change places
    const moved = ident != null && ident !== dir.left;
    if (moved) swapSides();
    const filled = [];
    for (const [side, team] of [['left', left], ['right', right]]) {
      $(`color_${side}`).value = colourName(team.lab);            // the colour seen in the video
      if ($(`roster_${side}`).value.trim()) continue;             // numbers typed by the user stay
      $(`roster_${side}`).value = team.numbers.join(' ');
      filled.push(side);
    }
    S.coloursKnown = true;
    if ($('team_left').value.trim() === DEFAULT_TEAMS[0] && $('team_right').value.trim() === DEFAULT_TEAMS[1]) {
      let [nl, nr] = [$('color_left').value, $('color_right').value];
      if (nl === nr) { nl += ' A'; nr += ' B'; }
      $('team_left').value = nl; $('team_right').value = nr;
    }
    knownTeams = teams();
    const [ta, tb] = teams();
    notes.push(`팀 자동 찾기(공격 방향: ${dirHow}): 왼쪽 골대 공격 ${ta}(${left.numbers.join('·') || '번호 없음'}), 오른쪽 ${tb}(${right.numbers.join('·') || '번호 없음'})`
      + (moved ? ' — 영상에 맞춰 두 팀의 왼쪽·오른쪽을 바꿈' : '') + (filled.length < 2 ? ' — 이미 적힌 등번호 명단은 그대로 둠' : ''));
  } else {
    notes.push(found ? `공격 방향을 정하지 못함(슛·사람이 적게 보임). 찾은 두 팀 색: ${found.teams.map((t) => colourName(t.lab)).join('·')} — 팀 색을 이 색으로 골라 두면 다음 분석에서 방향을 정함` : '팀을 셔츠 색으로 가리지 못함(사람이 적게 보임)');
  }
  // shooters: a number read surely and on the attacking team's list; otherwise (when allowed) the most likely number of that list
  const guessing = $('auto_guess').checked;
  const prof = Players.lookProfiles(out.flatMap((r) => r.people), [...rosterList(teams()[0]), ...rosterList(teams()[1])]);
  // the fallback guess for somebody nobody could see: the team's most often seen number
  const mostSeen = (list) => [...list].sort((a, b) => ((prof[b] && prof[b].seen) || 0) - ((prof[a] && prof[a].seen) || 0))[0] || null;
  S.mostSeen = guessing ? Object.fromEntries(teams().map((t) => [t, mostSeen(rosterList(t))]).filter(([, n]) => n)) : null;
  const guessIn = (look, reads, list) => (guessing ? (Players.guessNumber(look, reads, list, prof) || (mostSeen(list) ? { number: mostSeen(list) } : null)) : null);
  let auto = 0, guessed = 0;
  for (const x of shotList) {
    const team = Stats.teamFor(x.side, x.t, settings()), list = rosterList(team);
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
      if (next && next.sh.player && Stats.teamFor(next.side, next.t, settings()) === team) { reb[team] = { number: next.sh.player, guess: !!next.sh.playerGuess, how: '연속 슛' }; continue; }
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
  if (two && !(tpl['왼쪽'] && tpl['오른쪽'])) { alert("카메라 2대 분석에는 왼쪽·오른쪽 골대가 모두 표시된 체육관 설정이 필요합니다. '새로 만들기'로 두 영상에서 골대를 하나씩 표시해 주세요."); return; }
  if (!('VideoDecoder' in window)) { alert('이 브라우저는 분석 기능을 지원하지 않습니다. 최신 Edge 또는 Chrome을 쓰세요.'); return; }
  const jobs = two
    ? [{ cam: 'A', name: '왼쪽 골대 영상', file: S.vids.A.file, tpl: { 왼쪽: tpl['왼쪽'] } }, { cam: 'B', name: '오른쪽 골대 영상', file: S.vids.B.file, tpl: { 오른쪽: tpl['오른쪽'] } }]
    : [{ cam: 'A', name: '', file: S.vids.A.file, tpl }];
  const withPlayers = $('auto_players').checked;
  S.mostSeen = null;
  $('runBtn').disabled = true; $('cancelBtn').disabled = false; $('bar').value = 0;
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
    res = await Promise.all(jobs.map((j, i) => runWorker('worker.js', { cmd: 'analyze', file: j.file, templates: j.tpl },
      (m) => { prog[i] = { frac: m.frac, eta: m.eta ?? null, label: m.label }; show(); })));
  } catch (err) {
    stopWorkers(); finish();
    if (err.message !== 'cancelled') { status('분석하지 못했습니다.'); alert(err.message); }
    return;
  }
  let syncNote = '', off = 0;
  if (two) {
    const [a, b] = res;
    const sy = Sync.offset(a.env, b.env);
    if (sy.ok) {
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
  let playersNote = '';
  if (withPlayers) {
    const tp = performance.now();
    status('2/2 선수 번호·팀 찾는 중… (처음에는 모델 약 30MB를 내려받습니다)');
    try {
      playersNote = await findPlayers(jobs, res, off, (frac) => {
        $('bar').value = stage1 + (1 - stage1) * frac;
        const el = (performance.now() - tp) / 1000, eta = frac > 0.05 ? (el / frac) * (1 - frac) : null;
        status(`2/2 선수 번호·팀 찾는 중 ${(frac * 100).toFixed(0)}%${eta != null ? ` · 남은 시간 약 ${fmtSec(eta)}` : ''}`);
      });
    } catch (err) {
      if (err.message === 'cancelled') { finish(); return; }
      stopWorkers();
      playersNote = `선수 번호를 찾지 못함(${err.message})`;
    }
  }
  finish();
  let result;
  if (two) {
    const [a, b] = res;
    const shift = (sh) => ({ ...sh, start: sh.start + off, end: sh.end + off, made_t: sh.made_t == null ? null : sh.made_t + off });
    result = {
      shots: [...a.shots.map((sh) => ({ ...sh, cam: 'A' })), ...b.shots.map((sh) => ({ ...shift(sh), cam: 'B' }))],
      cams: [{ id: 'A', side: '왼쪽', track: a.track, offset: 0 }, { id: 'B', side: '오른쪽', track: b.track, offset: off }],
      whistles: mergeWhistles(a.whistles || [], b.whistles || [], off),
    };
    S.vids.A.duration = S.vids.A.duration || a.duration;
  } else {
    result = res[0];
  }
  if (withPlayers && S.mostSeen) result.mostSeen = S.mostSeen;
  const s2 = settings(), q = curQ();
  const out = Flow.infer(result, s2);
  S.ctx = out.ctx;
  S.events = Stats.mergeReanalysis(S.events, out.events, q);
  S.quarters[q] = { ctx: out.ctx, video_name: s2.video_name, video_name_b: two ? s2.video_name_b : '', cam_offset: two ? off : 0,
    sides: teams(), switch_time: s2.switch_time, duration: S.vids.A.duration || 0, at: new Date().toISOString() };
  const n = out.summary;
  const noSound = res.map(soundText).filter(Boolean)[0];
  const sound = noSound ? `${noSound}(파울·자유투는 판정하지 않음)`
    : n.mode === 'pan' ? `휘슬로 보이는 소리 ${n.whistles}번 중 경기가 멈춘 ${n.fouls}번을 파울로 판단`
      : n.mode === 'two' ? `휘슬 같은 소리 ${n.whistles}번 중 슛 순간 휘슬 뒤 같은 골대에서 자유투가 나온 ${n.pf}번을 슈팅파울로 판단(나머지는 파울로 세지 않음)`
        : `휘슬 같은 소리 ${n.unknownWhistles}개를 검토 목록에 올림(고정 카메라 1대에서는 파울을 자동으로 가리지 않음)`;
  const vis = res.map((r, i) => `${two ? (i ? '오른쪽 영상 ' : '왼쪽 영상 ') : ''}골대 보임 ${(100 * (1 - r.visibility['없음'])).toFixed(0)}%`).join(', ');
  status(`${Stats.quarterName(q)} 분석 끝(${fmtSec((performance.now() - t0) / 1000)}): 야투 ${n.fg}개(성공 ${n.made}) · 자유투 ${n.ft}개 · 리바운드 ${n.reb}개(공격 ${n.oreb}) · `
    + `턴오버 ${n.to}개 · 파울 ${n.pf}개 · ${sound}. ${vis}.${syncNote}${practiceNote}${playersNote ? ` ${playersNote}.` : ''} 다음은 '빠른 검토'.`);
  S.analysis = { version: APP_VERSION, at: new Date().toISOString(), mode: two ? '카메라 2대' : '카메라 1대', players: withPlayers ? '켜짐' : '꺼짐', status: $('status').textContent };
  if (res.some((r) => r.visibility['없음'] > 0.7)) alert("골대를 거의 찾지 못한 영상이 있습니다. 다른 체육관이나 다른 카메라 위치라면 '새로 만들기'로 체육관 설정을 새로 만들어 주세요.");
  changed();
  // with everything filled in automatically nothing may be left to check
  const left = S.events.filter((e) => qOf(e) === q && needsReview(e)).length;
  status($('status').textContent.replace("다음은 '빠른 검토'.", left ? `확인이 필요한 기록 ${left}개('빠른 검토'). 번호의 '(추정)'은 가장 가능성 높은 선수.` : "모든 기록에 팀·번호·판정이 자동으로 들어감(번호의 '(추정)'은 가장 가능성 높은 선수). 검토 없이 박스스코어를 쓸 수 있음."));
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
}
$('cancelBtn').addEventListener('click', () => { stopWorkers(); finish(); status('분석을 취소했습니다.'); });

/* ------------------------------------------------------------------ tables */
function cell(text, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; }
const selIndex = () => S.events.findIndex((e) => e.id === S.selId);
function render() {
  knownTeams = teams();          // names set by the app (loading, team finding) are what the records use
  S.events.sort(Stats.byTime);
  const manyQ = Stats.quartersIn(S.events).length > 1 || S.events.some((e) => qOf(e) > 1);
  const tb = $('eventTable').tBodies[0];
  tb.replaceChildren(...S.events.map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    if (e.id === S.selId) tr.className = 'sel';
    const src = cell(''); const pill = document.createElement('span');
    pill.className = `pill ${e.source === '자동' ? 'auto' : 'manual'}`; pill.textContent = e.source || '수동'; src.append(pill);
    tr.append(cell(`${manyQ ? `${qOf(e) <= 4 ? `${qOf(e)}Q` : `OT${qOf(e) - 4}`} ` : ''}${Number(e.time).toFixed(1)}`), cell(e.teamGuess && e.team ? `${e.team} (추정)` : e.team), cell(e.playerAuto && e.player ? `${e.player} (${e.playerGuess ? '추정' : '자동'})` : e.player), cell(e.type), cell(e.detail),
      cell(e.result, e.result === '성공' ? 'made' : ''), src, cell(e.confidence), cell(e.note, 'note'));
    return tr;
  }));
  $('emptyEvents').hidden = S.events.length > 0;
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
  sel.parentElement.hidden = !many;
  const part = sel.value ? S.events.filter((e) => qOf(e) === Number(sel.value)) : S.events;
  const box = Stats.boxScore(part, tm);
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
  if (!confirm(`${e.time}초 ${e.team} ${e.type} 기록을 지울까요?`)) return;
  S.events = S.events.filter((x) => x.id !== e.id); S.selId = null;
  changed();
});

/* ------------------------------------------------------------------ scene viewer + quick review */
const NO_PLAYER = new Set(['휘슬']);
const isShot = (e) => e.type === '야투' || e.type === '자유투';
/** still to do in the quick review: an automatic shot nobody confirmed (unless its shooter's number was read automatically), or a record without a jersey number */
const needsReview = (e) => (e.type === '휘슬' && !e.checked) || (e.team && !NO_PLAYER.has(e.type) && ((isShot(e) && e.source === '자동' && !e.checked && !e.playerAuto) || !(e.player || '').trim()));
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
  S.events = S.events.filter((x) => x.id !== e.id);
  changed();
  reviewNext(after ? after.id : null);
});
/** 2-point / 3-point field goal or free throw (team rule: one free throw, worth the fouled shot's 2 or 3) */
function setKind(kind) {
  const e = S.events.find((x) => x.id === S.selId);
  if (!e || !isShot(e)) return;
  if (kind === 'ft') Object.assign(e, { type: '자유투', detail: e.detail === '3점' || e.detail === '3점슛 파울' ? '3점슛 파울' : '2점슛 파울' });
  else Object.assign(e, { type: '야투', detail: kind === '3' ? '3점' : '2점' });
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
  const data = { app: 'HoopStat', version: 2, settings: settings(), events: S.events };
  Export.download(`${baseName()}.hoopstat.json`, new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
});
$('openWork').addEventListener('change', async () => {
  const f = $('openWork').files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'HoopStat') throw new Error('HoopStat 작업 파일이 아닙니다.');
    applyWork(d.settings || {}, d.events || []);
    status(`작업을 열었습니다: ${f.name}. 장면을 보려면 같은 영상을 1단계에서 골라 주세요.`);
  } catch (err) {
    alert(`작업 파일을 열지 못했습니다: ${err.message}`);
  }
  $('openWork').value = '';
});
function applyWork(s, events) {
  for (const id of SETTING_IDS) if (s[id] != null) $(id).value = s[id];
  if (!$('cam_mode').value) $('cam_mode').value = 'pan';
  applyMode();
  if (s.profile) reloadProfiles(s.profile);
  S.vids.A.name = s.video_name || ''; S.vids.B.name = s.video_name_b || '';
  if (!S.vids.A.duration) S.vids.A.duration = s.duration || 0;
  S.ctx = s.flow || null;
  S.analysis = s.analysis || null;
  S.coloursKnown = !!s.colours_known;
  // quarters: a record from before them is all the 1st quarter, analysed from the videos it names
  S.quarters = s.quarters && typeof s.quarters === 'object' ? s.quarters
    : (s.video_name || s.flow ? { 1: { ctx: s.flow || null, video_name: s.video_name || '', video_name_b: s.video_name_b || '' } } : {});
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
/** the two teams change ends: names, colours and number lists swap sides (not a rename) */
function swapSides() {
  for (const k of ['team', 'color', 'roster']) { const l = $(`${k}_left`).value; $(`${k}_left`).value = $(`${k}_right`).value; $(`${k}_right`).value = l; }
  knownTeams = teams();
}
/** a quarter was chosen: its camera offset and which team attacked which hoop come back (when it was analysed) */
function restoreQuarter() {
  const x = S.quarters[curQ()];
  if (!x) return;
  if (twoCam() && x.cam_offset != null) $('cam_offset').value = Number(x.cam_offset).toFixed(2);
  const [l, r] = teams();
  if (x.sides && x.sides[0] === r && x.sides[1] === l) swapSides();
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
  for (const x of Object.values(S.quarters)) if (x && x.sides) x.sides = x.sides.map((t) => map.get(t) || t);
  return true;
}
for (const id of SETTING_IDS) {
  $(id).addEventListener('change', () => {
    if (id === 'cam_mode') applyMode();
    if (id === 'team_left' || id === 'team_right') { if (renameTeams()) { changed(); return; } }
    if (id === 'quarter') restoreQuarter();
    if (id === 'color_left' || id === 'color_right') S.coloursKnown = true;
    if (id === 'cam_offset' && S.quarters[curQ()]) S.quarters[curQ()].cam_offset = settings().cam_offset;
    if (id === 'switch_time') {
      // the teams of the automatic shots follow the new switch time (each shot knows its hoop)
      const s = settings();
      for (const e of S.events) if (qOf(e) === curQ() && e.side && e.source === '자동' && (e.type === '야투' || e.type === '자유투')) e.team = Stats.teamFor(e.side, e.time, s);
      changed(); return;
    }
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
