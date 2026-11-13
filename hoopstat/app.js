/* HoopStat web app: screens, gym profiles, running the analysis worker, review and saving. */
'use strict';

const $ = (id) => document.getElementById(id);
const SIDES = ['왼쪽', '오른쪽'];
const PROC_W = 768, TW = 84, TH = 70, RIM_DY = 0.30;
const LS_PROFILES = 'hoopstat.profiles.v1';
const LS_WORK = 'hoopstat.work.v1';

const S = { file: null, url: null, duration: 0, events: [], selected: -1, worker: null, videoOk: false, numbering: false, skipped: new Set(), sceneToken: 0, grabChain: Promise.resolve() };

/* ------------------------------------------------------------------ storage */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function profiles() { return lsGet(LS_PROFILES, {}); }
function profileTemplates(name) {
  const p = profiles()[name];
  if (!p) return null;
  const out = {};
  for (const side of SIDES) if (p[side]) out[side] = { w: p[side].w, h: p[side].h, data: unb64(p[side].b64) };
  return out;
}

/* ------------------------------------------------------------------ settings */
const SETTING_IDS = ['team_left', 'color_left', 'team_right', 'color_right', 'roster_left', 'roster_right', 'switch_time', 'title'];
function settings() {
  const s = {};
  for (const id of SETTING_IDS) s[id] = $(id).value.trim();
  const sw = parseFloat(s.switch_time.replace(',', '.'));
  s.switch_time = Number.isFinite(sw) ? sw : null;
  s.profile = $('profileSel').value;
  s.video_name = S.file ? S.file.name : (S.videoName || '');
  s.duration = S.duration;
  return s;
}
function teams() { const s = settings(); return [s.team_left || '팀 A', s.team_right || '팀 B']; }

function save() {
  lsSet(LS_WORK, { settings: settings(), events: S.events, saved: new Date().toISOString() });
}

/* ------------------------------------------------------------------ video helpers */
function frameSize() {
  const v = $('vid');
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
/** grabs run one at a time on the shared hidden video; a stale token skips the work */
function queueGrab(t, canvas, token) {
  S.grabChain = S.grabChain.then(() => (token === S.sceneToken ? grab(t, canvas) : null)).catch(() => null);
  return S.grabChain;
}
async function grab(t, canvas) {
  const v = $('vid');
  await seek(v, t);
  const [W, H] = frameSize();
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, W, H);
  return ctx;
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

function checkBrowser() {
  const msgs = [];
  if (!('VideoDecoder' in window)) msgs.push('이 브라우저는 영상 분석 기능(WebCodecs)이 없습니다. 최신 Microsoft Edge 또는 Chrome에서 열어 주세요.');
  if (location.protocol === 'file:') msgs.push('파일을 직접 열면 분석이 동작하지 않습니다. 인터넷 주소(https://…)로 열어 주세요.');
  if (msgs.length) { $('browserWarn').textContent = msgs.join(' '); $('browserWarn').hidden = false; }
}

/* ------------------------------------------------------------------ video input */
$('videoInput').addEventListener('change', () => {
  const f = $('videoInput').files[0];
  if (!f) return;
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = f; S.url = URL.createObjectURL(f); S.videoOk = false;
  const v = $('vid');
  v.src = S.url;
  $('videoInfo').textContent = `${(f.size / 1048576).toFixed(0)}MB · 확인 중…`;
  v.onloadedmetadata = () => {
    S.duration = v.duration; S.videoOk = true;
    $('videoInfo').textContent = `${(f.size / 1048576).toFixed(0)}MB · ${fmtSec(v.duration)} · ${v.videoWidth}×${v.videoHeight}`;
    status(`영상 길이 ${fmtSec(v.duration)}. 체육관 설정을 고르고 '분석 시작'을 누르세요.`);
    save();
  };
  v.onerror = () => {
    $('videoInfo').textContent = '이 브라우저에서 재생할 수 없는 형식입니다';
    status('이 영상은 브라우저에서 열리지 않습니다. 최신 Edge에서 열어 보거나, 영상을 H.264(mp4)로 변환해 주세요.');
  };
});

/* ------------------------------------------------------------------ gym profile dialog */
const PF = { t: 0, marks: {}, ctx: null };
async function pfShow() {
  PF.ctx = await grab(PF.t, $('pfCanvas'));
  const ctx = PF.ctx;
  for (const [side, m] of Object.entries(PF.marks)) {
    if (Math.abs(m.t - PF.t) < 0.05) {
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(m.x, m.y, 9, 5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#00e5ff'; ctx.font = '14px sans-serif'; ctx.fillText(side, m.x - 14, m.y - 10);
    }
  }
  $('pfTime').textContent = `${PF.t.toFixed(1)}초`;
  $('pfRange').value = PF.t;
}
$('newProfileBtn').addEventListener('click', async () => {
  if (!S.file || !S.videoOk) { alert('먼저 이 체육관에서 찍은 경기 영상을 고르세요. 그 영상에서 골대 위치를 표시합니다.'); return; }
  PF.t = 0; PF.marks = {};
  for (const side of SIDES) $(`thumb${side}`).getContext('2d').clearRect(0, 0, 168, 140);
  $('pfRange').max = S.duration.toFixed(1);
  $('pfSave').disabled = true;
  document.querySelector('input[name=pfSide][value=왼쪽]').checked = true;
  $('profileDlg').showModal();
  await pfShow();
});
let pfTimer = null;
$('pfRange').addEventListener('input', () => {
  PF.t = parseFloat($('pfRange').value);
  $('pfTime').textContent = `${PF.t.toFixed(1)}초`;
  clearTimeout(pfTimer);
  pfTimer = setTimeout(pfShow, 120);
});
for (const b of document.querySelectorAll('[data-jump]')) {
  b.addEventListener('click', () => { PF.t = Math.min(Math.max(0, PF.t + parseFloat(b.dataset.jump)), S.duration); pfShow(); });
}
$('pfCanvas').addEventListener('click', (ev) => {
  if (!PF.ctx) return;
  const c = $('pfCanvas');
  const x = Math.round((ev.offsetX * c.width) / c.clientWidth), y = Math.round((ev.offsetY * c.height) / c.clientHeight);
  const side = document.querySelector('input[name=pfSide]:checked').value;
  // template = TW x TH gray patch whose centre sits RIM_DY*TH above the clicked rim centre
  const cx = x, cy = y - RIM_DY * TH;
  const x0 = Math.round(Math.min(Math.max(cx - TW / 2, 0), c.width - TW));
  const y0 = Math.round(Math.min(Math.max(cy - TH / 2, 0), c.height - TH));
  // re-grab without marks drawn
  grab(PF.t, document.createElement('canvas')).then((clean) => {
    const g = grayCrop(clean, x0, y0, TW, TH);
    PF.marks[side] = { t: PF.t, x, y, tpl: g };
    const th = $(`thumb${side}`).getContext('2d');
    const img = th.createImageData(TW, TH);
    for (let i = 0; i < g.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g[i]; img.data[i * 4 + 3] = 255; }
    const tmp = document.createElement('canvas'); tmp.width = TW; tmp.height = TH; tmp.getContext('2d').putImageData(img, 0, 0);
    th.imageSmoothingEnabled = false; th.clearRect(0, 0, 168, 140); th.drawImage(tmp, 0, 0, 168, 140);
    if (side === '왼쪽' && !PF.marks['오른쪽']) document.querySelector('input[name=pfSide][value=오른쪽]').checked = true;
    $('pfSave').disabled = Object.keys(PF.marks).length < 2;
    pfShow();
  });
});
$('pfSave').addEventListener('click', () => {
  const name = $('pfName').value.trim().replace(/[\\/:*?"<>|]/g, '') || '체육관';
  const all = profiles();
  if (all[name] && !confirm(`'${name}' 설정이 이미 있습니다. 바꿀까요?`)) return;
  all[name] = { created: new Date().toISOString() };
  for (const side of SIDES) all[name][side] = { w: TW, h: TH, b64: b64(PF.marks[side].tpl) };
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
$('runBtn').addEventListener('click', () => {
  const s = settings();
  if (!S.file) { alert('분석할 경기 영상을 고르세요.'); return; }
  const tpl = profileTemplates(s.profile);
  if (!tpl || Object.keys(tpl).length < 2) { alert("체육관 설정이 없습니다. '새로 만들기'에서 양쪽 골대를 한 번 표시해 주세요."); return; }
  if (!('VideoDecoder' in window)) { alert('이 브라우저는 분석 기능을 지원하지 않습니다. 최신 Edge 또는 Chrome을 쓰세요.'); return; }
  const w = new Worker('worker.js');
  S.worker = w;
  $('runBtn').disabled = true; $('cancelBtn').disabled = false; $('bar').value = 0;
  status('분석 준비 중… (처음에는 분석 도구를 내려받느라 조금 걸립니다)');
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') {
      $('bar').value = m.frac;
      status(`${m.label} ${(m.frac * 100).toFixed(0)}%${m.eta != null ? ` · 남은 시간 약 ${fmtSec(m.eta)}` : ''}`);
    } else if (m.type === 'info') {
      S.duration = m.duration;
    } else if (m.type === 'done') {
      const r = m.result;
      const out = Flow.infer(r, s);
      S.events = Stats.mergeReanalysis(S.events, out.events);
      const n = out.summary, v = r.visibility;
      const sound = r.audio === 'ok' ? `휘슬로 보이는 소리 ${n.whistles}번 중 경기가 멈춘 ${n.fouls}번을 파울로 판단`
        : r.audio === 'none' ? '영상에 소리가 없어 파울·자유투는 판정하지 않음' : '이 브라우저가 소리 형식을 읽지 못해 파울·자유투는 판정하지 않음';
      status(`분석 끝(${fmtSec(r.seconds)}): 야투 ${n.fg}개(성공 ${n.made}) · 자유투 ${n.ft}개 · 리바운드 ${n.reb}개(공격 ${n.oreb}) · `
        + `턴오버 ${n.to}개 · 파울 ${n.pf}개 · ${sound}. 골대가 화면에 보인 비율 왼쪽 ${(v['왼쪽'] * 100).toFixed(0)}%, `
        + `오른쪽 ${(v['오른쪽'] * 100).toFixed(0)}%, 안 보임 ${(v['없음'] * 100).toFixed(0)}%. 다음은 '등번호 넣기'.`);
      if (v['왼쪽'] + v['오른쪽'] < 0.3) alert("골대를 거의 찾지 못했습니다. 다른 체육관 영상이라면 '새로 만들기'로 체육관 설정을 새로 만들어 주세요.");
      finish(); render(); save();
    } else if (m.type === 'error') {
      status('분석하지 못했습니다.');
      alert(m.message);
      finish();
    }
  };
  w.onerror = (e) => { status('분석 중 오류가 났습니다.'); alert(`분석 중 오류가 났습니다: ${e.message}`); finish(); };
  w.postMessage({ cmd: 'analyze', file: S.file, templates: tpl });
});
function finish() {
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  $('runBtn').disabled = false; $('cancelBtn').disabled = true;
}
$('cancelBtn').addEventListener('click', () => { finish(); status('분석을 취소했습니다.'); });

/* ------------------------------------------------------------------ tables */
function cell(text, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; }
function render() {
  S.events.sort((a, b) => a.time - b.time);
  const tb = $('eventTable').tBodies[0];
  tb.replaceChildren(...S.events.map((e, i) => {
    const tr = document.createElement('tr');
    tr.dataset.i = i;
    if (i === S.selected) tr.className = 'sel';
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
  S.selected = Number(tr.dataset.i); render();
});
$('eventTable').tBodies[0].addEventListener('dblclick', (ev) => {
  const tr = ev.target.closest('tr'); if (!tr) return;
  S.selected = Number(tr.dataset.i); openEvent(S.events[S.selected], S.selected);
});
function needSel() {
  if (S.selected < 0 || S.selected >= S.events.length) { alert('표에서 줄을 하나 고르세요.'); return false; }
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
let evIndex = null;
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
function openEvent(e, index) {
  evIndex = index;
  $('eventTitle').textContent = index == null ? '사건 추가' : '사건 수정';
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
  const t = parseFloat($('evTime').value.replace(',', '.'));
  if (!Number.isFinite(t)) { alert('시각은 초 단위 숫자로 적어 주세요. 예: 83.5'); return; }
  const base = evIndex == null ? {} : S.events[evIndex];
  const e = { ...base, time: Math.round(t * 10) / 10, team: $('evTeam').value, player: $('evPlayer').value.trim(), type: $('evType').value,
    detail: $('evDetail').value, result: $('evResult').disabled ? '' : $('evResult').value, note: $('evNote').value.trim(), source: '수동',
    confidence: base.confidence || '' };
  if (evIndex == null) S.events.push(e); else S.events[evIndex] = e;
  S.selected = -1; render(); save();
});
$('editBtn').addEventListener('click', () => { if (needSel()) openEvent(S.events[S.selected], S.selected); });
$('addBtn').addEventListener('click', () => {
  const base = S.selected >= 0 ? S.events[S.selected] : null;
  openEvent({ time: base ? base.time : 0, team: teams()[0], type: '리바운드', detail: '수비' }, null);
});
$('delBtn').addEventListener('click', () => {
  if (!needSel()) return;
  const e = S.events[S.selected];
  if (!confirm(`${e.time}초 ${e.team} ${e.type} 기록을 지울까요?`)) return;
  S.events.splice(S.selected, 1); S.selected = -1; render(); save();
});

/* ------------------------------------------------------------------ scene viewer + jersey numbers */
const NO_PLAYER = new Set(['휘슬']);
const needsNumber = (e) => e.team && !NO_PLAYER.has(e.type) && !(e.player || '').trim();
function rosterOf(team) {
  const s = settings(), [a, b] = teams();
  const raw = team === a ? s.roster_left : team === b ? s.roster_right : '';
  const list = (raw || '').split(/[\s,·/]+/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean);
  // numbers already used for this team, so the buttons also work without a roster
  for (const e of S.events) if (e.team === team && /^\d+$/.test((e.player || '').trim()) && !list.includes(e.player.trim())) list.push(e.player.trim());
  return list.sort((x, y) => (/^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y, 'ko')));
}
function nextToNumber(from) {
  for (let k = 0; k < S.events.length; k++) {
    const i = (from + k) % S.events.length;
    if (needsNumber(S.events[i]) && !S.skipped.has(S.events[i])) return i;
  }
  return -1;
}
async function showScene(i) {
  const e = S.events[i];
  S.selected = i; render();
  const token = ++S.sceneToken;
  const what = `${Number(e.time).toFixed(1)}초 ${e.team} ${e.type}${e.detail ? ` ${e.detail}` : ''}${e.result ? ` ${e.result}` : ''}`;
  $('sceneTitle').textContent = S.numbering ? `등번호 넣기 · ${what}` : `장면 보기 · ${what}`;
  $('numBar').hidden = !S.numbering;
  if (S.numbering) {
    const left = S.events.filter((x) => needsNumber(x) && !S.skipped.has(x)).length;
    $('numAsk').textContent = `${e.team} ${e.type === '야투' || e.type === '자유투' ? '슛한' : e.type === '리바운드' ? '공을 잡은' : e.type === '턴오버' ? '공을 잃은' : e.type === '파울' ? '파울한' : ''} 선수 등번호`;
    $('numLeft').textContent = `· 남은 기록 ${left}개`;
    const btns = rosterOf(e.team).map((p) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = /^\d+$/.test(p) ? `#${p}` : p;
      b.addEventListener('click', () => setNumber(p));
      return b;
    });
    if (!btns.length) btns.push(Object.assign(document.createElement('span'), { className: 'muted', textContent: "1단계에 팀 등번호 명단을 적으면 번호 버튼이 생깁니다. 지금은 아래 칸에 번호를 적으세요." }));
    $('numButtons').replaceChildren(...btns);
    $('numInput').value = '';
  }
  const sv = $('sceneVideo');
  if (sv.src !== S.url) sv.src = S.url;
  const start = Math.max(0, e.time - 2);
  if (sv.readyState >= 1) sv.currentTime = start; else sv.onloadedmetadata = () => { sv.currentTime = start; };
  if (!$('sceneDlg').open) $('sceneDlg').showModal();
  if (S.numbering) setTimeout(() => $('numInput').focus(), 0);
  const figs = [];
  for (const dt of [-1, -0.5, 0, 0.5, 1, 1.5]) {
    const t = Math.max(0, e.time + dt);
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    fig.append(c, Object.assign(document.createElement('figcaption'), { textContent: `${t.toFixed(1)}초` }));
    figs.push([t, c, fig]);
  }
  $('sceneGrid').replaceChildren(...figs.map((f) => f[2]));
  for (const [t, c] of figs) queueGrab(t, c, token);
}
function setNumber(p) {
  const i = S.selected;
  if (i < 0 || !S.events[i]) return;
  S.events[i] = { ...S.events[i], player: String(p).trim() };
  save();
  const next = nextToNumber(i + 1);
  if (next < 0) { $('sceneDlg').close(); S.numbering = false; render(); status('등번호가 빈 기록이 없습니다. 박스스코어 탭에서 선수별 기록을 확인하세요.'); return; }
  showScene(next);
}
function requireVideo() {
  if (!S.file || !S.videoOk) { alert('영상을 찾을 수 없습니다. 1단계에서 경기 영상을 다시 골라 주세요.'); return false; }
  return true;
}
$('sceneBtn').addEventListener('click', () => {
  if (!needSel() || !requireVideo()) return;
  S.numbering = false; showScene(S.selected);
});
$('numBtn').addEventListener('click', () => {
  if (!requireVideo()) return;
  S.skipped = new Set();
  const start = S.selected >= 0 && S.events[S.selected] && needsNumber(S.events[S.selected]) ? S.selected : nextToNumber(0);
  if (start < 0) { alert('등번호가 빈 기록이 없습니다. 바꾸려면 줄을 두 번 눌러 수정하세요.'); return; }
  S.numbering = true; showScene(start);
});
$('numEnter').addEventListener('click', () => { const v = $('numInput').value.replace(/^#/, '').trim(); if (v) setNumber(v); });
$('numInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('numEnter').click(); }
});
$('numUnknown').addEventListener('click', () => setNumber('미상'));
$('numSkip').addEventListener('click', () => {
  const e = S.events[S.selected]; if (e) S.skipped.add(e);
  const next = nextToNumber(S.selected + 1);
  if (next < 0) { $('sceneDlg').close(); return; }
  showScene(next);
});
$('sceneReplay').addEventListener('click', () => {
  const e = S.events[S.selected]; const sv = $('sceneVideo');
  if (!e) return;
  sv.currentTime = Math.max(0, e.time - 2); sv.play();
});
$('sceneDlg').addEventListener('close', () => { $('sceneVideo').pause(); S.numbering = false; S.sceneToken++; render(); });

/* ------------------------------------------------------------------ saving */
function baseName() {
  const n = S.file ? S.file.name.replace(/\.[^.]+$/, '') : '박스스코어';
  return `${n}_박스스코어`;
}
$('xlsxBtn').addEventListener('click', () => {
  if (typeof XLSX === 'undefined') { alert('엑셀 도구를 아직 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.'); return; }
  Export.download(`${baseName()}.xlsx`, Export.xlsxBlob(S.events, settings()));
});
$('htmlBtn').addEventListener('click', () => Export.download(`${baseName()}.html`, new Blob([Export.htmlText(S.events, settings())], { type: 'text/html' })));
$('csvBtn').addEventListener('click', () => Export.download(`${baseName()}.csv`, new Blob([Export.csvText(S.events)], { type: 'text/csv' })));
$('saveWorkBtn').addEventListener('click', () => {
  const data = { app: 'HoopStat', version: 1, settings: settings(), events: S.events };
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
  if (s.profile) reloadProfiles(s.profile);
  S.videoName = s.video_name || '';
  if (!S.duration) S.duration = s.duration || 0;
  S.events = events; S.selected = -1;
  render(); save();
}
for (const id of SETTING_IDS) $(id).addEventListener('change', () => { render(); save(); });
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
const prev = lsGet(LS_WORK, null);
if (prev && (prev.events || []).length) {
  applyWork(prev.settings || {}, prev.events || []);
  status(`이전 작업(${(prev.events || []).length}건)을 불러왔습니다. 장면을 보거나 다시 분석하려면 영상을 다시 골라 주세요.`);
} else {
  render();
}
