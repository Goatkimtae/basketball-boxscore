/* Events -> box score (same rules as the Windows prototype).
   event: {time, team, player, type, detail, result, source, confidence, note} */
'use strict';

const TYPES = ['야투', '자유투', '리바운드', '어시스트', '스틸', '블록', '턴오버', '파울', '휘슬'];   // 휘슬: review marker, not counted
const DETAILS = {
  야투: ['2점', '3점'],
  자유투: ['2점슛 파울', '3점슛 파울', '앤드원', '기타'],
  리바운드: ['공격', '수비'],
  파울: ['개인파울', '슈팅파울', '공격자파울'],
};
// Team rule: a shooting foul gives ONE free throw, worth the shot's value (2 or 3) if made.
// And-one follows KBL 34.2.2 (one FT, 1 point).
// The '…1구/2구' names are from files saved under the earlier 2+1 rule and keep their old values.
const FT_POINTS = { '2점슛 파울': 2, '3점슛 파울': 3, 앤드원: 1, 기타: 1, '2점슛 파울 1구': 2, '3점슛 파울 1구': 2, '3점슛 파울 2구': 1 };
const COLS = ['FGM', 'FGA', 'FG%', '2PM', '2PA', '2P%', '3PM', '3PA', '3P%', 'FTM', 'FTA', 'FT%',
  'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', 'PTS'];
const KO = { FGM: '야투 성공', FGA: '야투 시도', '2PM': '2점 성공', '2PA': '2점 시도', '3PM': '3점 성공', '3PA': '3점 시도',
  FTM: '자유투 성공', FTA: '자유투 시도', OREB: '공격 리바', DREB: '수비 리바', REB: '리바운드', AST: '어시스트',
  STL: '스틸', BLK: '블록', TO: '턴오버', PF: '파울', PTS: '득점' };

function points(e) {
  if (e.result !== '성공') return 0;
  if (e.type === '야투') return e.detail === '3점' ? 3 : 2;
  if (e.type === '자유투') return FT_POINTS[e.detail] ?? 1;
  return 0;
}

const pct = (m, a) => (a ? Math.round((m / a) * 1000) / 10 : null);

function tally(events) {
  const c = (f) => events.filter(f).length;
  const shot = (e) => e.type === '야투';
  const made = (e) => e.result === '성공';
  const s = {
    FGM: c((e) => shot(e) && made(e)), FGA: c(shot),
    '2PM': c((e) => shot(e) && e.detail !== '3점' && made(e)), '2PA': c((e) => shot(e) && e.detail !== '3점'),
    '3PM': c((e) => shot(e) && e.detail === '3점' && made(e)), '3PA': c((e) => shot(e) && e.detail === '3점'),
    FTM: c((e) => e.type === '자유투' && made(e)), FTA: c((e) => e.type === '자유투'),
    OREB: c((e) => e.type === '리바운드' && e.detail === '공격'), DREB: c((e) => e.type === '리바운드' && e.detail !== '공격'),
    AST: c((e) => e.type === '어시스트'), STL: c((e) => e.type === '스틸'), BLK: c((e) => e.type === '블록'),
    TO: c((e) => e.type === '턴오버'), PF: c((e) => e.type === '파울'),
  };
  s.REB = s.OREB + s.DREB;
  s['FG%'] = pct(s.FGM, s.FGA); s['2P%'] = pct(s['2PM'], s['2PA']); s['3P%'] = pct(s['3PM'], s['3PA']); s['FT%'] = pct(s.FTM, s.FTA);
  s.PTS = events.reduce((p, e) => p + points(e), 0);
  return s;
}

const playerOf = (e) => (e.player || '').trim() || '미상';
const playerOfNoGuess = (e) => (e.playerGuess ? '미상' : playerOf(e));
function playerSort(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b, 'ko');
}

/** opt.guess === false: a guessed number counts for the team but not for that player ('미상') */
function boxScore(events, teams, opt = {}) {
  events = events.filter((e) => e.type !== '휘슬');      // review markers are not counted, even with a guessed team
  const who = opt.guess === false ? playerOfNoGuess : playerOf;
  const names = [...teams, ...[...new Set(events.map((e) => e.team).filter(Boolean))].filter((t) => !teams.includes(t)).sort()];
  const out = { teams: [], players: {} };
  for (const t of names) {
    const ev = events.filter((e) => e.team === t);
    out.teams.push([t, tally(ev)]);
    const ps = [...new Set(ev.map(who))].sort(playerSort);
    out.players[t] = ps.map((p) => [p, tally(ev.filter((e) => who(e) === p))]);
  }
  return out;
}

/** Team comparison rows for the two teams: {label, key, a, b, va, vb} (a/b are display text) */
const COMPARE = [['득점', 'PTS'], ['야투', ['FGM', 'FGA', 'FG%']], ['2점슛', ['2PM', '2PA', '2P%']], ['3점슛', ['3PM', '3PA', '3P%']],
  ['자유투', ['FTM', 'FTA', 'FT%']], ['리바운드', 'REB'], ['공격 리바운드', 'OREB'], ['수비 리바운드', 'DREB'], ['어시스트', 'AST'],
  ['스틸', 'STL'], ['블록', 'BLK'], ['턴오버', 'TO'], ['파울', 'PF']];
function teamCompare(box, teams) {
  const T = Object.fromEntries(box.teams);
  const a = T[teams[0]] || tally([]), b = T[teams[1]] || tally([]);
  const text = (s, k) => (Array.isArray(k) ? `${s[k[0]]}/${s[k[1]]}${s[k[2]] == null ? '' : ` (${s[k[2]].toFixed(1)}%)`}` : String(s[k]));
  return COMPARE.map(([label, k]) => {
    const key = Array.isArray(k) ? k[0] : k;
    return { label, key, a: text(a, k), b: text(b, k), va: a[key], vb: b[key] };
  });
}

const fmt = (col, v) => (v == null ? '–' : col.endsWith('%') ? v.toFixed(1) : String(v));

function checks(events) {
  const msgs = [];
  const missed = events.filter((e) => e.type === '야투' && e.result === '실패').length;
  const lastFtMissed = events.filter((e) => e.type === '자유투' && e.result === '실패' && e.detail !== '3점슛 파울 1구').length;
  const reb = events.filter((e) => e.type === '리바운드').length;
  if (missed + lastFtMissed !== reb) {
    msgs.push(`실패한 슛(야투 ${missed}개 + 마지막 자유투 ${lastFtMissed}개)과 리바운드 ${reb}개의 수가 다릅니다. 보통은 같습니다(쿼터 종료 직전 등은 예외).`);
  }
  const unchecked = events.filter((e) => e.source === '자동' && (e.type === '야투' || e.type === '자유투') && !e.checked).length;
  if (unchecked) msgs.push(`아직 확인하지 않은 자동 슛이 ${unchecked}개 있습니다. 자동 슛은 모두 2점 야투로 기록되니, '빠른 검토'에서 성공/실패를 확인하고 3점슛·자유투는 버튼으로 바꿔 주세요.`);
  const autoFt = events.filter((e) => e.source === '자동' && e.type === '자유투' && e.detail === '2점슛 파울').length;
  if (autoFt) msgs.push(`자동으로 찾은 자유투 ${autoFt}개는 2점슛 파울(성공 시 2점)로 기록했습니다. 3점슛을 던지다 파울을 당했으면 세부를 '3점슛 파울'로 바꿔 주세요(성공 시 3점).`);
  const made = events.filter((e) => e.type === '야투' && e.result === '성공').length;
  const ast = events.filter((e) => e.type === '어시스트').length;
  if (made && !ast) msgs.push(`성공한 야투 ${made}개 중 어시스트가 있었는지는 자동으로 판정하지 않습니다. 장면을 보고 '사건 추가'로 넣어 주세요.`);
  const wh = events.filter((e) => e.type === '휘슬').length;
  if (wh) msgs.push(`판정하지 않은 휘슬 소리 ${wh}개(일반 파울·바이얼레이션·아웃·작전타임일 수 있음). '빠른 검토'에서 '휘슬 미판정'을 골라 파울이면 팀을, 아니면 '파울 아님'을 누르세요(휘슬 줄은 박스스코어에 들어가지 않음).`);
  const autoPf = events.filter((e) => e.source === '자동' && e.type === '파울').length;
  if (autoPf) msgs.push(`자동으로 찾은 파울 ${autoPf}개(고정 카메라: 슛 순간 휘슬 뒤 같은 골대 자유투, 따라 찍는 카메라: 휘슬 뒤 멈춤). 파울한 선수 번호는 대부분 추정이니 장면 보기로 확인해 주세요.`);
  const noNum = events.filter((e) => e.team && !['휘슬'].includes(e.type) && !(e.player || '').trim()).length;
  if (noNum) msgs.push(`등번호가 없는 기록 ${noNum}개는 선수별 기록에서 '미상'으로 묶입니다. '빠른 검토'로 채우면 개인 기록이 나옵니다.`);
  return msgs;
}

function teamFor(side, t, s) {
  const left = s.team_left || '팀 A', right = s.team_right || '팀 B';
  const sw = s.switch_time;
  const swapped = sw !== null && sw !== undefined && sw !== '' && t >= Number(sw);
  if (side === '왼쪽') return swapped ? right : left;
  return swapped ? left : right;
}

function shotsToEvents(shots, s) {
  return shots.map((sh) => ({
    time: Math.round(sh.start * 10) / 10, team: teamFor(sh.side, sh.start, s), player: '', type: '야투', detail: '2점',
    result: sh.made ? '성공' : '실패', source: '자동', confidence: sh.confidence, side: sh.side,
    note: '공이 림 높이에 처음 보인 시각(슛을 던진 순간보다 0.3~1초 늦음)'
      + (sh.made && sh.made_t != null ? `. 성공 근거: ${sh.made_t.toFixed(1)}초에 공이 림 가운데 아래로 지나감` : ''),
  }));
}

/* ------------------------------------------------------------------ quarters
   Each analysis (one video, or one pair with two cameras) is one quarter; every record keeps its quarter in q
   (records without one, from before quarters, are the 1st). Times are seconds in that quarter's video. */
const qOf = (e) => Number(e && e.q) || 1;
const quarterName = (q) => (q <= 4 ? `${q}쿼터` : `연장 ${q - 4}`);
/** the quarters that have records, in order */
function quartersIn(events) { return [...new Set(events.map(qOf))].sort((a, b) => a - b); }
/** points per quarter: {qs, rows: [{team, pts: [per quarter], total}]} */
function linescore(events, teams) {
  const qs = quartersIn(events);
  const rows = teams.map((team) => {
    const pts = qs.map((q) => events.filter((e) => qOf(e) === q && e.team === team).reduce((a, e) => a + points(e), 0));
    return { team, pts, total: pts.reduce((a, b) => a + b, 0) };
  });
  return { qs, rows };
}
/** records in time order: quarter by quarter */
const byTime = (a, b) => qOf(a) - qOf(b) || a.time - b.time;

/* ------------------------------------------------------------------ quarters inside one video
   A video holding several quarters has spans [{q, start, end}] in video seconds (camera A / the record's clock).
   The quarter of a moment is the span holding it; outside every span (a break, before the start) or within NEAR s
   of a span's edge it is marked unsure, so the user can check it. */
const QB = { NEAR: 15, MIN_BREAK: 60, MIN_SHARE: 0.6 };
function qAt(spans, t) {
  const list = (spans || []).filter((x) => x && x.start != null && x.end != null).sort((a, b) => a.start - b.start);
  if (!list.length) return null;
  const inside = list.find((x) => t >= x.start && t < x.end);
  if (inside) return { q: inside.q, unsure: t - inside.start < QB.NEAR || inside.end - t < QB.NEAR };
  // in a break or outside: the nearest span
  const near = list.reduce((a, x) => (Math.min(Math.abs(t - x.start), Math.abs(t - x.end)) < Math.min(Math.abs(t - a.start), Math.abs(t - a.end)) ? x : a));
  return { q: near.q, unsure: true };
}
/** Suggested quarter spans for a video holding nQ quarters: the nQ-1 longest breaks in play (no shot for at least
    MIN_BREAK s, quieter than usual when motion(t1, t2) -> share of the usual motion is given). A quarter is at least
    MIN_SHARE of qLen seconds of video (the clock stops, so a quarter takes longer than its game time, never much less).
    Returns {spans: [{q, start, end}], breaks: [{from, to, len, motion}], why} or null. */
function suggestQuarters({ shots, duration, nQ, qLen, motion }) {
  const ts = [...shots].sort((a, b) => a - b);
  if (nQ < 2 || ts.length < 2) return null;
  const gaps = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const len = ts[i + 1] - ts[i];
    if (len < QB.MIN_BREAK) continue;
    const m = motion ? motion(ts[i] + 5, ts[i + 1] - 5) : null;
    gaps.push({ from: ts[i], to: ts[i + 1], len, motion: m, score: len * (m == null ? 1 : Math.max(0.2, 1.5 - m)) });
  }
  // the best set of nQ-1 breaks that leaves every quarter long enough
  const minLen = QB.MIN_SHARE * qLen;
  const cand = [...gaps].sort((a, b) => b.score - a.score).slice(0, 12);
  let best = null;
  const choose = (k, start, picked) => {
    if (picked.length === nQ - 1) {
      const cuts = [...picked].sort((a, b) => a.from - b.from);
      const edges = [0, ...cuts.map((g) => (g.from + g.to) / 2), duration];
      if (edges.some((e, i) => i && e - edges[i - 1] < minLen)) return;
      const sc = cuts.reduce((a, g) => a + g.score, 0);
      if (!best || sc > best.sc) best = { sc, cuts };
      return;
    }
    for (let i = start; i < cand.length; i++) choose(k, i + 1, [...picked, cand[i]]);
  };
  choose(0, 0, []);
  if (!best) return null;
  const cuts = best.cuts;
  const spans = [];
  for (let i = 0; i < nQ; i++) {
    const start = i === 0 ? Math.max(0, ts[0] - 30) : Math.round((cuts[i - 1].from + cuts[i - 1].to) / 2);
    const end = i === nQ - 1 ? duration : Math.round((cuts[i].from + cuts[i].to) / 2);
    spans.push({ q: i + 1, start: Math.round(start), end: Math.round(end) });
  }
  const why = cuts.map((g, i) => `${quarterName(i + 1)}→${quarterName(i + 2)}: ${Math.round(g.from)}~${Math.round(g.to)}초 슛 없음 ${Math.round(g.len)}초${g.motion != null ? `, 움직임 평소의 ${Math.round(g.motion * 100)}%` : ''}`).join(' · ');
  return { spans, breaks: cuts.map(({ from, to, len, motion: m }) => ({ from, to, len, motion: m })), why };
}

/* ------------------------------------------------------------------ attack direction per quarter
   quarters[q].dir = {left: 'A'|'B', switchT, source, how}: team A or B attacks the left hoop in that quarter (until
   switchT, when the two change ends inside the quarter's video). Not set: the nearest quarter that has one (same
   half: same ends; the other half: the other ends, FIBA 9.5; overtime like the 4th), else team A on the left. */
function dirOf(quarters, q) {
  const x = quarters && quarters[q];
  if (x && x.dir) return x.dir;
  const half = (k) => (k <= 2 ? 1 : 2), flip = (id) => (id === 'A' ? 'B' : 'A');
  const ref = Object.entries(quarters || {}).map(([k, v]) => [Number(k), v]).filter(([k, v]) => k !== q && v && v.dir && v.dir.source !== '기본')
    .sort((a, b) => Math.abs(a[0] - q) - Math.abs(b[0] - q) || a[0] - b[0])[0];
  if (ref) {
    const same = half(ref[0]) === half(q);
    return { left: same ? ref[1].dir.left : flip(ref[1].dir.left), switchT: null, source: '규칙',
      how: `${quarterName(ref[0])}${same ? '와 같은 방향' : '의 반대(후반에 골대를 바꿈)'}으로 둠` };
  }
  return { left: 'A', switchT: null, source: '기본', how: '아직 정하지 않음(팀 A를 왼쪽으로 둠)' };
}

/* ------------------------------------------------------------------ review state
   Kept apart: was the result (made / missed, kind) confirmed by a person, and how did the number get there
   (read on the shirt, guessed, typed by a person, none). Returns the things still open for one record. */
const NO_PLAYER_TYPES = ['휘슬'];
function openItems(e) {
  const out = [];
  if (e.type === '휘슬') { if (!e.checked) out.push('휘슬 미판정'); return out; }
  const isShot = e.type === '야투' || e.type === '자유투';
  if (isShot && e.source === '자동' && !e.checked) out.push('결과 미확인');
  if (e.team && !NO_PLAYER_TYPES.includes(e.type)) {
    if (!(e.player || '').trim()) out.push('번호 없음');
    else if (e.playerGuess) out.push('번호 추정');
  }
  return out;
}
/** how the number got there, in words */
function playerState(e) {
  if (!(e.player || '').trim()) return '없음';
  if (e.playerAuto) return e.playerGuess ? '추정' : '읽음';
  return '사람';
}
/** how the result got there */
function resultState(e) {
  if (!(e.type === '야투' || e.type === '자유투')) return '';
  return e.checked ? '확인' : e.source === '자동' ? '자동(미확인)' : '사람';
}

/* ------------------------------------------------------------------ where an automatic record came from
   origin: the kind of thing found (a shot, a foul …), the camera / hoop and the time. It stays on the record when
   the user edits it (the record then counts as manual), so a re-analysis that finds the same thing again does not
   add it a second time. A deleted record leaves a tombstone: an automatic one by its origin, a rebuilt rebound or
   turnover by the record it follows (of), so neither comes back. */
const family = (e) => (e.type === '야투' || e.type === '자유투' ? 'shot' : e.type);
function originOf(e) { return { f: family(e), t: Math.round(e.time * 10) / 10, cam: e.cam || null, side: e.side || null }; }
function sameOrigin(o, e) {
  return !!o && o.f === family(e) && Math.abs(o.t - e.time) <= 1 && (!o.cam || !e.cam || o.cam === e.cam) && (!o.side || !e.side || o.side === e.side);
}
function tombstone(e) {
  return { q: qOf(e), type: e.type, team: e.team || '', time: e.time, of: e.of || null,
    origin: e.origin || (e.source === '자동' && !e.derived ? originOf(e) : null), at: new Date().toISOString() };
}

/** Replace the automatic records with a new analysis. Manual records are kept. What the user did to
    an automatic record survives when the new analysis finds the same thing (same team, within 1 s):
    a jersey number is carried over, and a shot the user confirmed keeps its result and kind. A record the user
    edited (manual, with an origin) or deleted (a tombstone in `removed`) is not added again.
    With q, only that quarter is replaced (the new records get q); the other quarters stay as they are. */
function mergeReanalysis(old, auto, q, removed = []) {
  if (Array.isArray(q)) {
    // one video holding several quarters: the new records already carry their quarter; those quarters are replaced
    const other = old.filter((e) => !q.includes(qOf(e)));
    return [...other, ...q.flatMap((k) => mergeReanalysis(old.filter((e) => qOf(e) === k), auto.filter((e) => qOf(e) === k), null, removed.filter((r) => (r.q || 1) === k)))].sort(byTime);
  }
  if (q != null) {
    const other = old.filter((e) => qOf(e) !== q);
    return [...other, ...mergeReanalysis(old.filter((e) => qOf(e) === q), auto.map((e) => ({ ...e, q })), null, removed.filter((r) => (r.q || 1) === q))].sort(byTime);
  }
  const shot = (e) => e.type === '야투' || e.type === '자유투';
  const edited = old.filter((e) => e.source !== '자동' && e.origin);
  const dead = removed.filter((r) => r.origin);
  const kept = auto.map((e) => ({ ...e, origin: e.origin || originOf(e) }))
    .filter((e) => !edited.some((o) => sameOrigin(o.origin, e)) && !dead.some((r) => sameOrigin(r.origin, e)));
  // the same automatic record as before keeps its id (rebuilt rebounds and tombstones refer to it)
  const prevAuto = old.filter((e) => e.source === '자동' && !e.derived && e.id);
  const pool = old.filter((e) => e.source === '자동' && ((e.player || '').trim() || e.checked || e.userKind));
  const fresh = kept.map((e0) => {
    const same = prevAuto.find((o) => sameOrigin(o.origin || originOf(o), e0));
    const e = same ? { ...e0, id: same.id } : e0;
    const k = pool.findIndex((o) => o.team === e.team && (o.type === e.type || (shot(o) && shot(e))) && Math.abs(o.time - e.time) <= 1);
    if (k < 0) return e;
    const o = pool.splice(k, 1)[0];
    const out = { ...e };
    // a number typed by hand stays; one read automatically gives way to the new reading
    if ((o.player || '').trim() && (!(e.player || '').trim() || !o.playerAuto)) { out.player = o.player; out.playerAuto = !!o.playerAuto; out.playerGuess = !!o.playerGuess; }
    if (o.checked && shot(e)) Object.assign(out, { type: o.type, detail: o.detail, result: o.result, checked: true, confidence: o.confidence });
    if (o.userKind && shot(e)) Object.assign(out, { type: o.type, detail: o.detail, userKind: true });
    return out;
  });
  return [...old.filter((e) => e.source !== '자동'), ...fresh].sort(byTime);
}

const Stats = { TYPES, DETAILS, FT_POINTS, COLS, KO, points, tally, boxScore, teamCompare, fmt, checks, teamFor, shotsToEvents, mergeReanalysis, qOf, quarterName, quartersIn, linescore, byTime, originOf, sameOrigin, tombstone, openItems, playerState, resultState, dirOf, QB, qAt, suggestQuarters };
if (typeof window !== 'undefined') window.Stats = Stats;
if (typeof module !== 'undefined') module.exports = Stats;
