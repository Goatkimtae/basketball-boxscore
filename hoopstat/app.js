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
const S = { vids: { A: newVid(), B: newVid() }, events: [], selId: null, workers: [], ctx: null,
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
const SETTING_IDS = ['cam_mode', 'team_left', 'color_left', 'team_right', 'color_right', 'roster_left', 'roster_right', 'switch_time', 'cam_offset', 'title'];
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
  return s;
}
function teams() { const s = settings(); return [s.team_left || '팀 A', s.team_right || '팀 B']; }
const flowCtx = () => S.ctx || { mode: twoCam() ? 'two' : 'pan', segs: [] };

function save() {
  lsSet(LS_WORK, { settings: settings(), events: S.events, saved: new Date().toISOString() });
}

/** After any change to the record: rebuild rebounds/turnovers from the shots as they are now. */
function changed() {
  for (const e of S.events) if (!e.id) e.id = uid();
  S.events = Flow.derive(S.events, settings(), flowCtx());
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
  const near = S.events.filter((x) => x.cam && Math.abs(x.time - e.time) <= 6).sort((a, b) => Math.abs(a.time - e.time) - Math.abs(b.time - e.time))[0];
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
$('videoInput').addEventListener('change', () => { const f = $('videoInput').files[0]; if (f) setVideo('A', f); });
$('videoInputB').addEventListener('change', () => { const f = $('videoInputB').files[0]; if (f) setVideo('B', f); });

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
  PF.t = 0; PF.cam = 'A'; PF.tBy = { A: 0, B: 0 }; PF.marks = {};
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
  const x = Math.round((ev.offsetX * c.width) / c.clientWidth), y = Math.round((ev.offsetY * c.height) / c.clientHeight);
  const side = pfSide(), cam = PF.cam, t = PF.t;
  // template = TW x TH gray patch whose centre sits RIM_DY*TH above the clicked rim centre
  const cx = x, cy = y - RIM_DY * TH;
  const x0 = Math.round(Math.min(Math.max(cx - TW / 2, 0), c.width - TW));
  const y0 = Math.round(Math.min(Math.max(cy - TH / 2, 0), c.height - TH));
  // re-grab without marks drawn
  grab(t, document.createElement('canvas'), cam).then((clean) => {
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
/** One worker per video; with two cameras both run at the same time. */
function runWorker(file, templates, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker('worker.js');
    const end = () => { w.terminate(); S.workers = S.workers.filter((x) => x.w !== w); };
    S.workers.push({ w, reject });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') { end(); resolve(m.result); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { end(); reject(new Error(`분석 중 오류가 났습니다: ${e.message}`)); };
    w.postMessage({ cmd: 'analyze', file, templates });
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
  $('runBtn').disabled = true; $('cancelBtn').disabled = false; $('bar').value = 0;
  status('분석 준비 중… (처음에는 분석 도구를 내려받느라 조금 걸립니다)');
  const t0 = performance.now(), prog = jobs.map(() => ({ frac: 0, eta: null, label: '영상 읽는 중' }));
  const show = () => {
    const frac = prog.reduce((a, p) => a + p.frac, 0) / prog.length, etas = prog.map((p) => p.eta).filter((x) => x != null);
    $('bar').value = frac;
    const slow = prog.reduce((a, p) => (p.frac < a.frac ? p : a));
    status(`${two ? '두 영상 함께 ' : ''}${slow.label} ${(frac * 100).toFixed(0)}%${etas.length === prog.length ? ` · 남은 시간 약 ${fmtSec(Math.max(...etas))}` : ''}`);
  };
  let res;
  try {
    res = await Promise.all(jobs.map((j, i) => runWorker(j.file, j.tpl, (m) => { prog[i] = { frac: m.frac, eta: m.eta ?? null, label: m.label }; show(); })));
  } catch (err) {
    stopWorkers(); finish();
    if (err.message !== 'cancelled') { status('분석하지 못했습니다.'); alert(err.message); }
    return;
  }
  finish();
  let result, syncNote = '';
  if (two) {
    const [a, b] = res;
    const sy = Sync.offset(a.env, b.env);
    if (sy.ok) {
      const off = Math.round((sy.offset + (a.envStart || 0) - (b.envStart || 0)) * 100) / 100;
      $('cam_offset').value = off.toFixed(2);
      $('syncInfo').textContent = `소리로 자동 맞춤(일치도 ${sy.score})`;
      syncNote = ` 두 영상 시작 차이 ${off.toFixed(2)}초(소리로 맞춤).`;
    } else {
      $('syncInfo').textContent = '소리로 맞추지 못함 — 직접 적어 주세요';
      syncNote = ` 두 영상의 시작 차이를 소리로 맞추지 못해 ${settings().cam_offset}초로 두었습니다. 다르면 '두 영상 시작 차이'를 고치고 다시 분석하세요.`;
    }
    const off = settings().cam_offset;
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
  const s2 = settings();
  const out = Flow.infer(result, s2);
  S.ctx = out.ctx;
  S.events = Stats.mergeReanalysis(S.events, out.events);
  const n = out.summary;
  const noSound = res.map(soundText).filter(Boolean)[0];
  const sound = noSound ? `${noSound}(파울·자유투는 판정하지 않음)`
    : n.mode === 'pan' ? `휘슬로 보이는 소리 ${n.whistles}번 중 경기가 멈춘 ${n.fouls}번을 파울로 판단`
      : `휘슬 같은 소리 ${n.unknownWhistles}개를 검토 목록에 올림(고정 카메라에서는 파울을 자동으로 가리지 않음)`;
  const vis = res.map((r, i) => `${two ? (i ? '오른쪽 영상 ' : '왼쪽 영상 ') : ''}골대 보임 ${(100 * (1 - r.visibility['없음'])).toFixed(0)}%`).join(', ');
  status(`분석 끝(${fmtSec((performance.now() - t0) / 1000)}): 야투 ${n.fg}개(성공 ${n.made}) · 자유투 ${n.ft}개 · 리바운드 ${n.reb}개(공격 ${n.oreb}) · `
    + `턴오버 ${n.to}개 · 파울 ${n.pf}개 · ${sound}. ${vis}.${syncNote} 다음은 '빠른 검토'.`);
  if (res.some((r) => r.visibility['없음'] > 0.7)) alert("골대를 거의 찾지 못한 영상이 있습니다. 다른 체육관이나 다른 카메라 위치라면 '새로 만들기'로 체육관 설정을 새로 만들어 주세요.");
  changed();
}
$('runBtn').addEventListener('click', runAnalysis);
function finish() {
  $('runBtn').disabled = false; $('cancelBtn').disabled = true;
}
$('cancelBtn').addEventListener('click', () => { stopWorkers(); finish(); status('분석을 취소했습니다.'); });

/* ------------------------------------------------------------------ tables */
function cell(text, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; }
const selIndex = () => S.events.findIndex((e) => e.id === S.selId);
function render() {
  S.events.sort((a, b) => a.time - b.time);
  const tb = $('eventTable').tBodies[0];
  tb.replaceChildren(...S.events.map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    if (e.id === S.selId) tr.className = 'sel';
    const src = cell(''); const pill = document.createElement('span');
    pill.className = `pill ${e.source === '자동' ? 'auto' : 'manual'}`; pill.textContent = e.source || '수동'; src.append(pill);
    tr.append(cell(Number(e.time).toFixed(1)), cell(e.team), cell(e.player), cell(e.type), cell(e.detail),
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
  const tm = teams(), box = Stats.boxScore(S.events, tm);
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
  const e = { ...base, id: base.id || uid(), time: Math.round(t * 10) / 10, team: $('evTeam').value, player: $('evPlayer').value.trim(), type: $('evType').value,
    detail: $('evDetail').value, result: $('evResult').disabled ? '' : $('evResult').value, note: $('evNote').value.trim(), source: '수동',
    confidence: base.confidence || '', derived: false, checked: true };
  if (base.time != null && Math.abs(base.time - e.time) > 0.05) delete e.end;      // the old end no longer fits
  if (i < 0) S.events.push(e); else S.events[i] = e;
  S.selId = e.id;
  changed();
});
$('editBtn').addEventListener('click', () => { if (needSel()) openEvent(S.events[selIndex()], S.selId); });
$('addBtn').addEventListener('click', () => {
  const base = selIndex() >= 0 ? S.events[selIndex()] : null;
  openEvent({ time: base ? base.time + 1 : 0, team: teams()[0], type: '리바운드', detail: '수비' }, null);
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
/** still to do in the quick review: an automatic shot nobody confirmed, or a record without a jersey number */
const needsReview = (e) => e.type === '휘슬' || (e.team && !NO_PLAYER.has(e.type) && ((isShot(e) && e.source === '자동' && !e.checked) || !(e.player || '').trim()));
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
  const n = S.events.length, from = afterId == null ? 0 : S.events.findIndex((e) => e.id === afterId) + 1;
  for (let k = 0; k < n; k++) {
    const e = S.events[(from + k) % n];
    if (needsReview(e) && !S.skipped.has(e.id)) return e.id;
  }
  return null;
}
async function showScene(id, keepCam) {
  const e = S.events.find((x) => x.id === id);
  if (!e) { $('sceneDlg').close(); return; }
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
    const left = S.events.filter((x) => needsReview(x) && !S.skipped.has(x.id)).length;
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
  e.player = String(p).trim();
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
  const start = cur && needsReview(cur) ? cur.id : nextToReview(null);
  if (start == null) { alert('검토할 기록이 없습니다. 바꾸려면 줄을 두 번 눌러 수정하세요.'); return; }
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
  Object.assign(e, { type: '파울', team, detail: '개인파울', source: '수동', checked: true, confidence: '확인', note: `휘슬 소리를 듣고 사람이 파울로 판단. ${e.note || ''}`.slice(0, 200) });
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
  S.events = events; S.selId = null;
  for (const e of S.events) if (!e.id) e.id = uid();
  render(); save();
}
for (const id of SETTING_IDS) $(id).addEventListener('change', () => { if (id === 'cam_mode') applyMode(); render(); save(); });
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
