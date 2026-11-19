/* Save the record as Excel, a single-file web page, CSV, or a work file. */
'use strict';

const TEAM_COLORS = { 빨강: '#d7263d', 남색: '#1f2a55', 파랑: '#1f6fd1', 검정: '#222222', 흰색: '#f4f4f4',
  노랑: '#f2c230', 초록: '#2e9e5b', 주황: '#f08a24', 보라: '#7a4cc2', 회색: '#8a8f99' };
const EVENT_KEYS = ['time', 'team', 'player', 'type', 'detail', 'result', 'source', 'confidence', 'note'];
const EVENT_KO = ['시각(초)', '팀', '등번호', '기록', '세부', '결과', '출처', '신뢰도', '비고'];

function teamsOf(s) { return [s.team_left || '팀 A', s.team_right || '팀 B']; }
function titleOf(s) { const [a, b] = teamsOf(s); return s.title || `${a} vs ${b} 박스스코어`; }
const sorted = (events) => [...events].sort(Stats.byTime);
const manyQ = (events) => Stats.quartersIn(events).some((q) => q > 1);
const qShort = (q) => (q <= 4 ? `${q}Q` : `OT${q - 4}`);
/** team stats quarter by quarter: [{q, name, teams: [[team, tally]]}] */
function byQuarter(events, teams) {
  return Stats.quartersIn(events).map((q) => ({ q, name: Stats.quarterName(q), teams: Stats.boxScore(events.filter((e) => Stats.qOf(e) === q), teams).teams }));
}
const Q_COLS = [['득점', (t) => t.PTS], ['야투', (t) => `${t.FGM}/${t.FGA}`], ['3점', (t) => `${t['3PM']}/${t['3PA']}`], ['자유투', (t) => `${t.FTM}/${t.FTA}`],
  ['리바운드', (t) => t.REB], ['어시스트', (t) => t.AST], ['턴오버', (t) => t.TO], ['파울', (t) => t.PF]];
/** points of each player quarter by quarter: {qs, teams: [[team, [[player, [pts per q], total]]]]} */
function playerQuarters(events, teams) {
  const qs = Stats.quartersIn(events), box = Stats.boxScore(events, teams);
  const per = qs.map((q) => Stats.boxScore(events.filter((e) => Stats.qOf(e) === q), teams));
  return { qs, teams: box.teams.map(([t]) => [t, (box.players[t] || []).map(([p, st]) => [p, per.map((b) => { const r = (b.players[t] || []).find(([x]) => x === p); return r ? r[1].PTS : 0; }), st.PTS])]) };
}
/** which team attacked the left hoop in each quarter of the record, as text (teams A / B: s.team_left / s.team_right) */
function sidesText(s, events) {
  const qs = [...new Set([...Stats.quartersIn(events || []), ...Object.keys(s.quarters || {}).map(Number)])].sort((a, b) => a - b);
  if (!qs.length) return null;
  const nm = (id) => (id === 'B' ? s.team_right : s.team_left) || `팀 ${id}`, other = (id) => (id === 'A' ? 'B' : 'A');
  return qs.map((q) => {
    const d = Stats.dirOf(s.quarters || {}, q);
    return `${Stats.quarterName(q)}: 왼쪽 골대 ${nm(d.left)}, 오른쪽 골대 ${nm(other(d.left))}${d.switchT != null ? `(${d.switchT}초부터 반대)` : ''}${d.source === '사람' ? ' — 사람이 정함' : d.source === '기본' ? ' — 정하지 못함' : ''}`;
  }).join(' · ');
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function csvText(events) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [[...EVENT_KO, '쿼터', '결과 상태', '번호 상태', '팀 추정', '쿼터 확인 필요'], ...sorted(events).map((e) => [Number(e.time).toFixed(1), ...EVENT_KEYS.slice(1).map((k) => e[k] ?? ''),
    Stats.qOf(e), Stats.resultState(e), Stats.playerState(e), e.teamGuess ? '추정' : '', e.qUnsure ? '예' : ''])];
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const e = {};
    EVENT_KEYS.forEach((k, i) => { e[k] = r[i] ?? ''; });
    e.time = Number(e.time) || 0;
    e.q = Number(r[EVENT_KEYS.length]) || 1;
    // states written by csvText (older files have none)
    const rs = r[EVENT_KEYS.length + 1], ps = r[EVENT_KEYS.length + 2];
    if (rs === '확인') e.checked = true;
    if (ps === '읽음' || ps === '추정') { e.playerAuto = true; e.playerGuess = ps === '추정'; }
    if (r[EVENT_KEYS.length + 3] === '추정') e.teamGuess = true;
    if (r[EVENT_KEYS.length + 4] === '예') e.qUnsure = true;
    return e;
  });
}

function xlsxBlob(events, s) {
  const teams = teamsOf(s);
  const box = Stats.boxScore(events, teams);
  const val = (k, v) => (v == null ? '' : k.endsWith('%') ? v / 100 : v);
  const aoa = [[titleOf(s)], [`영상: ${s.video_name || ''} · 자동 분석 + 사람 검토 · 출전시간과 +/-는 계산하지 않음`], [],
    ['팀 기록', ...teams]];
  for (const r of Stats.teamCompare(box, teams)) aoa.push([r.label, r.a === String(r.va) ? r.va : r.a, r.b === String(r.vb) ? r.vb : r.b]);
  if (manyQ(events)) {
    const ls = Stats.linescore(events, teams);
    aoa.push([], ['쿼터별 득점', ...ls.qs.map(Stats.quarterName), '합계'], ...ls.rows.map((r) => [r.team, ...r.pts, r.total]));
    aoa.push([], ['쿼터별 팀 기록', '팀', ...Q_COLS.map(([k]) => k)]);
    for (const x of byQuarter(events, teams)) for (const [t, st] of x.teams) aoa.push([x.name, t, ...Q_COLS.map(([, f]) => f(st))]);
    const pq = playerQuarters(events, teams);
    aoa.push([], ['선수별 쿼터 득점', '등번호', ...pq.qs.map(Stats.quarterName), '합계']);
    for (const [t, rows] of pq.teams) for (const [p, pts, tot] of rows) aoa.push([t, p, ...pts, tot]);
  }
  aoa.push([], ['팀', ...Stats.COLS.map((k) => (Stats.KO[k] ? `${k} ${Stats.KO[k]}` : k))]);
  for (const [t, st] of box.teams) aoa.push([t, ...Stats.COLS.map((k) => val(k, st[k]))]);
  const T = Object.fromEntries(box.teams);
  for (const [t, ps] of Object.entries(box.players)) {
    aoa.push([], [`${t} 선수별 기록`], ['등번호', ...Stats.COLS]);
    for (const [p, st] of ps) aoa.push([p, ...Stats.COLS.map((k) => val(k, st[k]))]);
    aoa.push(['팀 합계', ...Stats.COLS.map((k) => val(k, T[t][k]))]);
  }
  aoa.push([]);
  for (const m of Stats.checks(events)) aoa.push(['※ ' + m]);
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  // percent columns
  const range = XLSX.utils.decode_range(ws1['!ref']);
  Stats.COLS.forEach((k, ci) => {
    if (!k.endsWith('%')) return;
    for (let r = 0; r <= range.e.r; r++) {
      const cell = ws1[XLSX.utils.encode_cell({ r, c: ci + 1 })];
      if (cell && typeof cell.v === 'number' && cell.v <= 1) cell.z = '0.0%';
    }
  });
  ws1['!cols'] = [{ wch: 12 }, ...Stats.COLS.map(() => ({ wch: 9 }))];
  const ws2 = XLSX.utils.aoa_to_sheet([['쿼터', ...EVENT_KO, '득점', '결과 상태', '번호 상태', '팀 추정', '쿼터 확인 필요'], ...sorted(events).map((e) => [Stats.quarterName(Stats.qOf(e)), Math.round(e.time * 10) / 10,
    ...EVENT_KEYS.slice(1).map((k) => e[k] ?? ''), ['야투', '자유투'].includes(e.type) ? Stats.points(e) : '',
    Stats.resultState(e), Stats.playerState(e), e.teamGuess ? '추정' : '', e.qUnsure ? '예' : ''])]);
  ws2['!cols'] = [7, 9, 10, 8, 10, 14, 8, 8, 8, 60, 7, 10, 8, 7, 9].map((w) => ({ wch: w }));
  const rules = [['항목', '내용'],
    ['야투(자동)', '골대 근처에서 공이 림 높이 이상 올라간 구간을 슛으로 봅니다. 공이 림 위에 보인 뒤 0.6초 안에 그물 안(림 너비의 0.45배 이내)에서 떨어지는 것이 보이면 성공. 신뢰도 "확인"은 사람이 장면을 보고 확인한 슛입니다.'],
    ['촬영 방식', s.cam_mode === 'two' ? `골대마다 고정 카메라 1대씩. 두 영상의 시작 차이 ${s.cam_offset || 0}초(소리로 맞춤). 시각은 왼쪽 골대 영상 기준.` : '카메라 1대'],
    ['리바운드(자동)', '실패한 슛 다음 슛을 같은 팀이 같은 골대에서 곧(고정 카메라: 10초 안, 따라 찍는 카메라: 카메라가 반대쪽으로 가기 전) 던지면 공격 리바운드, 아니면 수비 리바운드(FIBA 기록 정의). 슛 기록을 고치면 다시 계산됩니다.'],
    ['턴오버(자동)', '공을 가진 팀이 슛 없이 상대에게 공격권을 넘기면(다음 슛이 상대 팀) 턴오버. 시각은 카메라 이동으로 추정합니다. 스틸 여부는 자동으로 정하지 않습니다.'],
    ['파울(자동)', '2~4.8kHz의 고른 휘슬 소리 뒤 1~12초 동안 선수들이 거의 멈추면 파울로 봅니다(멈추지 않으면 무시). 그때 공을 가진 팀의 상대 팀 파울로 기록합니다. 슛 직후 휘슬이면 그 슛의 수비 팀 파울.'],
    ['자유투(자동)', '파울 휘슬 뒤 40초 안에 같은 골대에서 선수들이 선 채로 던진 첫 슛 1개를 자유투로 봅니다(자동은 2점슛 파울로 기록, 들어간 슛에 휘슬이면 앤드원).'],
    ['사람이 넣는 기록', '등번호(등번호 넣기), 어시스트, 스틸, 블록, 3점슛, 슛이 아닌 파울'],
    ['팀', `슛의 팀은 그 골대를 공격한 팀으로 정합니다. ${sidesText(s, events) || ''}`],
    ['쿼터', '쿼터마다 영상(카메라 2대면 영상 2개)을 따로 분석합니다. 사건 기록의 시각은 그 쿼터 영상의 시작부터 센 초입니다.'],
    ['2점·3점', '자동 기록은 모두 2점입니다. 3점 라인은 영상으로 판정하지 않습니다.'],
    ['자유투(팀 규칙)', '슈팅 파울은 자유투 1개만 던지고, 성공하면 던지던 슛의 점수(2점슛 파울 2점, 3점슛 파울 3점)를 인정. 앤드원은 1개·1점(KBL).'],
    ['기준 문서', '2026-2027 KBL 경기규칙(득점·파울), FIBA 기록원 매뉴얼 2016(리바운드·어시스트 등 기록 정의)']];
  const ws3 = XLSX.utils.aoa_to_sheet(rules);
  ws3['!cols'] = [{ wch: 16 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '박스스코어');
  XLSX.utils.book_append_sheet(wb, ws2, '사건기록');
  XLSX.utils.book_append_sheet(wb, ws3, '판정기준');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function htmlText(events, s) {
  const teams = teamsOf(s);
  const [a, b] = teams;
  const box = Stats.boxScore(events, teams);
  const T = Object.fromEntries(box.teams);
  const color = { [a]: TEAM_COLORS[s.color_left] || '#d7263d', [b]: TEAM_COLORS[s.color_right] || '#1f2a55' };
  const chip = (t) => `<span class="chip" style="background:${color[t] || '#8a8f99'}"></span>`;
  const cells = (st) => Stats.COLS.map((k) => `<td class="${k === 'PTS' ? 'pts' : st[k] === 0 ? 'z' : ''}">${Stats.fmt(k, st[k])}</td>`).join('');
  const head = (first, ko) => `<tr><th class="l">${first}</th>${Stats.COLS.map((k) => `<th>${k}${ko && Stats.KO[k] ? `<small>${Stats.KO[k]}</small>` : ''}</th>`).join('')}</tr>`;
  const players = Object.entries(box.players).map(([t, ps]) => `<h3>${chip(t)}${esc(t)} · ${T[t].PTS}점</h3><div class="scroll"><table><thead>${head('등번호', true)}</thead><tbody>${
    ps.map(([p, st]) => `<tr><td class="l">${esc(/^\d+$/.test(p) ? `#${p}` : p)}</td>${cells(st)}</tr>`).join('')}<tr class="total"><td class="l">팀 합계</td>${cells(T[t])}</tr></tbody></table></div>`).join('');
  const compare = Stats.teamCompare(box, teams).map((r) => `<tr><td class="l">${r.label}</td><td class="${r.key === 'PTS' && r.va > r.vb ? 'pts' : ''}">${r.a}</td><td class="${r.key === 'PTS' && r.vb > r.va ? 'pts' : ''}">${r.b}</td></tr>`).join('');
  const mq = manyQ(events);
  let quarters = '';
  if (mq) {
    const ls = Stats.linescore(events, teams);
    quarters = `<section><h2>쿼터별 득점</h2><div class="scroll cmp"><table><thead><tr><th class="l">팀</th>${ls.qs.map((q) => `<th>${Stats.quarterName(q)}</th>`).join('')}<th>합계</th></tr></thead><tbody>${
      ls.rows.map((r) => `<tr><td class="l">${chip(r.team)}${esc(r.team)}</td>${r.pts.map((p) => `<td>${p}</td>`).join('')}<td class="pts">${r.total}</td></tr>`).join('')}</tbody></table></div></section>
<section><h2>쿼터별 팀 기록</h2><div class="scroll"><table><thead><tr><th class="l">쿼터</th><th class="l">팀</th>${Q_COLS.map(([k]) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${
      byQuarter(events, teams).map((x) => x.teams.map(([t, st], i) => `<tr><td class="l">${i ? '' : x.name}</td><td class="l">${chip(t)}${esc(t)}</td>${Q_COLS.map(([, f]) => `<td>${f(st)}</td>`).join('')}</tr>`).join('')).join('')}</tbody></table></div></section>`;
    const pq = playerQuarters(events, teams);
    quarters += `<section><h2>선수별 쿼터 득점</h2>${pq.teams.map(([t, rows]) => `<h3>${chip(t)}${esc(t)}</h3><div class="scroll cmp"><table><thead><tr><th class="l">등번호</th>${pq.qs.map((q) => `<th>${Stats.quarterName(q)}</th>`).join('')}<th>합계</th></tr></thead><tbody>${
      rows.map(([p, pts, tot]) => `<tr><td class="l">${esc(/^\d+$/.test(p) ? `#${p}` : p)}</td>${pts.map((v) => `<td class="${v ? '' : 'z'}">${v}</td>`).join('')}<td class="pts">${tot}</td></tr>`).join('')}</tbody></table></div>`).join('')}</section>`;
  }
  const pbp = sorted(events).map((e) => `<tr>${mq ? `<td>${qShort(Stats.qOf(e))}${e.qUnsure ? '?' : ''}</td>` : ''}<td>${Number(e.time).toFixed(1)}</td>${['team', 'player', 'type', 'detail', 'result', 'source']
    .map((k) => `<td class="l">${esc(k === 'team' && e.teamGuess && e.team ? `${e.team} (추정)` : k === 'player' && e.player && e.playerAuto ? `${e.player} (${e.playerGuess ? '추정' : '자동'})` : e[k])}</td>`).join('')}`
    + `<td class="l">${esc([Stats.resultState(e), Stats.openItems(e).join(', ')].filter(Boolean).join(' · '))}</td><td class="why">${esc(e.note)}</td></tr>`).join('');
  const notes = Stats.checks(events).map((m) => `<li>${esc(m)}</li>`).join('');
  const sa = T[a] || Stats.tally([]), sb = T[b] || Stats.tally([]);
  const dur = s.duration ? ` · 영상 ${Math.round(s.duration)}초` : '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleOf(s))}</title>
<style>
:root{--bg:#fbfbfd;--panel:#f1f3f8;--fg:#1b1e27;--muted:#5d6475;--line:#dde1ea;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#14161c;--panel:#1d2029;--fg:#eceef3;--muted:#a3a9b8;--line:#2e3340;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:15px;line-height:1.5}
main{max-width:1100px;margin:0 auto;padding-block:28px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:28px}
main>*{min-width:0}.eyebrow{margin:0;color:var(--muted);font-size:13px}h1{margin:4px 0 0;font-size:clamp(1.5rem,4vw,2rem);font-weight:600}
.score{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.team{display:grid;gap:4px}.team.r{justify-items:end;text-align:right}.tname{display:flex;align-items:center;gap:6px;font-weight:600}
.big{font-size:clamp(2.6rem,10vw,4rem);line-height:1;font-variant-numeric:tabular-nums;font-weight:500}.sub,.vs{color:var(--muted);font-size:12px}.vs{text-align:center}
.chip{display:inline-block;width:.85em;height:.85em;border-radius:3px;border:1px solid var(--line);margin-right:6px;vertical-align:-1px}
h2{margin:0 0 6px;font-size:1.15rem}h3{margin:14px 0 6px;font-size:1rem}.note{margin:0 0 8px;color:var(--muted);font-size:13px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}thead th{background:var(--panel);color:var(--muted);font-size:12px;font-weight:600;vertical-align:bottom}
thead th small{display:block;font-weight:400;font-size:11px}tbody tr:last-child td{border-bottom:0}.l{text-align:left}td.pts{font-weight:700}td.z{color:var(--muted)}
th:first-child,td:first-child{position:sticky;left:0;background:var(--bg)}thead th:first-child{background:var(--panel)}
tr.total td{font-weight:700;border-top:2px solid var(--line)}.scroll.cmp{max-width:560px}td.why{white-space:normal;min-width:16rem;text-align:left;color:var(--muted);font-size:13px}ul{margin:0;padding-left:1.2em;color:var(--muted);font-size:13px}footer{color:var(--muted);font-size:12px}
</style></head><body><main>
<header><p class="eyebrow">영상 자동 분석 + 사람 검토${dur}</p><h1>${esc(titleOf(s))}</h1></header>
<section class="score" aria-label="점수판">
<div class="team"><span class="tname">${chip(a)}${esc(a)}</span><span class="big">${sa.PTS}</span><span class="sub">야투 ${sa.FGM}/${sa.FGA} · 리바운드 ${sa.REB} · 어시스트 ${sa.AST}</span></div>
<div class="vs">${esc(sidesText(s, events) || '').replace(/ · /g, '<br>')}</div>
<div class="team r"><span class="tname">${esc(b)}${chip(b)}</span><span class="big">${sb.PTS}</span><span class="sub">야투 ${sb.FGM}/${sb.FGA} · 리바운드 ${sb.REB} · 어시스트 ${sb.AST}</span></div>
</section>
${quarters}
<section><h2>팀 기록${mq ? '(경기 전체)' : ''}</h2>
<div class="scroll cmp"><table><thead><tr><th class="l">항목</th><th>${chip(a)}${esc(a)}</th><th>${chip(b)}${esc(b)}</th></tr></thead><tbody>${compare}</tbody></table></div></section>
<section><h2>선수별 기록</h2><p class="note">등번호를 모르는 기록은 '미상'으로 묶었습니다. 맨 아래 줄은 팀 합계입니다. 출전시간(MIN)과 +/-는 교체 기록이 없어 계산하지 않았습니다.</p>${players}${notes ? `<ul>${notes}</ul>` : ''}</section>
<section><h2>사건 기록</h2><p class="note">시각은 ${mq ? '그 쿼터 ' : ''}영상 시작부터 센 초입니다. 출처 '자동'은 앱이 찾은 기록, '수동'은 사람이 넣거나 고친 기록입니다.</p>
<div class="scroll"><table><thead><tr>${mq ? '<th>쿼터</th>' : ''}<th>시각(초)</th><th class="l">팀</th><th class="l">등번호</th><th class="l">기록</th><th class="l">세부</th><th class="l">결과</th><th class="l">출처</th><th class="l">확인 상태</th><th class="l">비고</th></tr></thead><tbody>${pbp}</tbody></table></div></section>
<footer>HoopStat으로 만든 기록 · 이 파일 하나로 열립니다.${s.analysis ? `<br>분석 정보(문제를 알릴 때 이 파일을 보내 주세요): ${esc(s.analysis.version || '')} · ${esc((s.analysis.at || '').slice(0, 16).replace('T', ' '))} UTC · ${esc(s.analysis.mode || '')} · 선수 찾기 ${esc(s.analysis.players || '')} · ${esc(s.analysis.status || '')}` : ''}</footer>
</main></body></html>`;
}

const Export = { TEAM_COLORS, download, csvText, parseCsv, xlsxBlob, htmlText, titleOf, teamsOf };
window.Export = Export;
