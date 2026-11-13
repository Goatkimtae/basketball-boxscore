/* Events -> box score (same rules as the Windows prototype).
   event: {time, team, player, type, detail, result, source, confidence, note} */
'use strict';

const TYPES = ['야투', '자유투', '리바운드', '어시스트', '스틸', '블록', '턴오버', '파울'];
const DETAILS = {
  야투: ['2점', '3점'],
  자유투: ['2점슛 파울 1구', '3점슛 파울 1구', '3점슛 파울 2구', '앤드원', '기타'],
  리바운드: ['공격', '수비'],
  파울: ['개인파울', '슈팅파울', '공격자파울'],
};
// Team rule: 2-point shot foul -> one FT worth 2; 3-point shot foul -> two FTs worth 2 and 1.
// And-one follows KBL 34.2.2 (one FT, 1 point).
const FT_POINTS = { '2점슛 파울 1구': 2, '3점슛 파울 1구': 2, '3점슛 파울 2구': 1, 앤드원: 1, 기타: 1 };
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
function playerSort(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b, 'ko');
}

function boxScore(events, teams) {
  const names = [...teams, ...[...new Set(events.map((e) => e.team).filter(Boolean))].filter((t) => !teams.includes(t)).sort()];
  const out = { teams: [], players: {} };
  for (const t of names) {
    const ev = events.filter((e) => e.team === t);
    out.teams.push([t, tally(ev)]);
    const ps = [...new Set(ev.map(playerOf))].sort(playerSort);
    out.players[t] = ps.map((p) => [p, tally(ev.filter((e) => playerOf(e) === p))]);
  }
  return out;
}

const fmt = (col, v) => (v == null ? '–' : col.endsWith('%') ? v.toFixed(1) : String(v));

function checks(events) {
  const msgs = [];
  const missed = events.filter((e) => e.type === '야투' && e.result === '실패').length;
  const reb = events.filter((e) => e.type === '리바운드').length;
  if (missed && reb === 0) msgs.push(`실패한 야투 ${missed}개에 리바운드 기록이 없습니다. 리바운드는 자동으로 찾지 않으니 '사건 추가'로 넣어 주세요.`);
  else if (missed !== reb) msgs.push(`실패한 야투 ${missed}개, 리바운드 ${reb}개입니다. 보통은 같아야 합니다(쿼터 종료 직전 등은 예외).`);
  const auto = events.filter((e) => e.source === '자동' && e.type === '야투').length;
  if (auto) msgs.push(`자동으로 찾은 야투 ${auto}개는 모두 2점으로 기록했습니다. 3점슛은 '수정'에서 바꿔 주세요.`);
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

function mergeReanalysis(old, auto) {
  return [...old.filter((e) => e.source !== '자동'), ...auto].sort((a, b) => a.time - b.time);
}

const Stats = { TYPES, DETAILS, FT_POINTS, COLS, KO, points, tally, boxScore, fmt, checks, teamFor, shotsToEvents, mergeReanalysis };
if (typeof window !== 'undefined') window.Stats = Stats;
if (typeof module !== 'undefined') module.exports = Stats;
