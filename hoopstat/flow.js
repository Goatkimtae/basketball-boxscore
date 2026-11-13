/* Play flow: from the shots, the camera direction and the whistles, work out what happened between
   the shots. Who got each rebound, when the ball changed hands without a shot (turnover), and which
   shots were free throws after a shooting foul. Pure functions on the analysis result; no video access.

   The camera follows the ball, so the hoop it shows tells which end the play is at. The order of
   shots tells who had the ball: after a miss, if the same team shoots again at the same end before
   the camera goes to the other end, they got the offensive rebound; if the other team shoots next,
   it was a defensive rebound. If a team gets the ball but the next shot is by the other team, the
   ball was lost without a shot: a turnover. */
'use strict';
(function (root) {
  const Stats = root.Stats || (typeof require !== 'undefined' ? require('./stats.js') : null);
  const OTHER_SIDE = { 왼쪽: '오른쪽', 오른쪽: '왼쪽' };
  const SIDE_OF = { 1: '왼쪽', 2: '오른쪽' };
  const P = {
    SEG_GAP: 0.6,       // the camera may lose the hoop this long within one look at an end
    SEG_MIN: 1.0,       // shorter looks are ignored
    FLIP_MIN: 2.0,      // this many seconds on the other end means the ball went there
    CONFLICT: 2.5,      // two shots at opposite ends closer than this cannot both be real
    REB_DT: 0.3,        // rebound: this long after the ball was last seen at the rim
    FOUL_BEFORE: 3.0,   // a fouled shot reaches the rim up to this long before the whistle
    FOUL_AFTER: 1.5,    // ... or this long after it
    FT_MIN: 4, FT_MAX: 120,      // first free throw this long after the whistle
    FT2_MIN: 3.5, FT2_MAX: 25,   // second free throw this long after the first
  };
  const r1 = (x) => Math.round(x * 10) / 10;

  /** camera track [[t, side 0/1/2, x], ...] -> looks at one end [{side, start, end}] */
  function segments(track) {
    const segs = [];
    let cur = null;
    for (const [t, sd] of track || []) {
      if (!sd) continue;
      const side = SIDE_OF[sd];
      if (cur && cur.side === side && t - cur.end <= P.SEG_GAP) cur.end = t;
      else { if (cur) segs.push(cur); cur = { side, start: t, end: t }; }
    }
    if (cur) segs.push(cur);
    return segs.filter((g) => g.end - g.start >= P.SEG_MIN);
  }
  function timeOn(segs, side, t1, t2) {
    let s = 0;
    for (const g of segs) if (g.side === side) s += Math.max(0, Math.min(g.end, t2) - Math.max(g.start, t1));
    return s;
  }

  /** Two shots at opposite ends within 2.5 s: keep the one at the end the camera settles on. */
  function dropConflicts(shots, segs) {
    const out = [...shots].sort((a, b) => a.start - b.start), dropped = [];
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i], b = out[i + 1];
      if (a.side === b.side || b.start - a.start >= P.CONFLICT) continue;
      const l = timeOn(segs, '왼쪽', b.start - 0.5, b.start + 2.5), r = timeOn(segs, '오른쪽', b.start - 0.5, b.start + 2.5);
      let lose;
      if (Math.abs(l - r) > 0.3) lose = (l > r ? '왼쪽' : '오른쪽') === a.side ? b : a;
      else lose = a.frames < b.frames ? a : b;
      dropped.push(lose);
      out.splice(out.indexOf(lose), 1);
      i = Math.max(-1, i - 2);
    }
    return { kept: out, dropped };
  }

  /** Shooting fouls: a whistle right at a shot, then one or two shots at the same hoop after a pause. */
  function freeThrowTrips(shots, whistles, segs) {
    const used = new Set(), trips = [];
    for (const w of whistles) {
      const near = shots.filter((sh) => !used.has(sh) && sh.start >= w.t - P.FOUL_BEFORE && sh.start <= w.t + P.FOUL_AFTER);
      const fg = near[near.length - 1];
      if (!fg) continue;
      const later = shots.filter((sh) => !used.has(sh) && sh !== fg && sh.start > w.t + P.FT_MIN);
      const ft1 = later[0];
      if (!ft1 || ft1.side !== fg.side || ft1.start - w.t > P.FT_MAX) continue;
      const fts = [ft1];
      const ft2 = later[1];
      if (!fg.made && ft2 && ft2.side === fg.side && ft2.start - ft1.end >= P.FT2_MIN && ft2.start - ft1.end <= P.FT2_MAX
        && timeOn(segs, OTHER_SIDE[fg.side], ft1.end, ft2.start) < P.FLIP_MIN) fts.push(ft2);
      for (const s of [fg, ...fts]) used.add(s);
      trips.push({ w, fg, fts });
    }
    return { trips, used };
  }

  function infer(result, s) {
    const teams = [s.team_left || '팀 A', s.team_right || '팀 B'];
    const other = (t) => (t === teams[0] ? teams[1] : teams[0]);
    const teamOf = (side, t) => Stats.teamFor(side, t, s);
    const segs = segments(result.track);
    const { kept, dropped } = dropConflicts(result.shots || [], segs);
    const whistles = [...(result.whistles || [])].sort((a, b) => a.t - b.t);
    const { trips, used } = freeThrowTrips(kept, whistles, segs);
    const usedWh = new Set(trips.map((tr) => tr.w));

    const plays = [];
    for (const sh of kept) if (!used.has(sh)) plays.push({ kind: 'FG', t: sh.start, side: sh.side, shot: sh });
    for (const tr of trips) plays.push({ kind: 'TRIP', t: Math.min(tr.fg.start, tr.w.t), side: tr.fg.side, trip: tr });
    plays.sort((a, b) => a.t - b.t);

    const ev = [];
    const add = (o) => ev.push({ player: '', detail: '', result: '', source: '자동', confidence: '낮음', note: '', ...o, time: r1(o.time) });
    const fgEvent = (sh, team, extra = '') => add({
      time: sh.start, team, type: '야투', detail: '2점', result: sh.made ? '성공' : '실패', confidence: sh.confidence, side: sh.side,
      note: '공이 림 높이에 처음 보인 시각(슛을 던진 순간보다 0.3~1초 늦음)'
        + (sh.made && sh.made_t != null ? `. 성공 근거: ${sh.made_t.toFixed(1)}초에 공이 림 가운데 아래로 지나감` : '') + extra,
    });

    const whistlesIn = (t1, t2) => whistles.filter((w) => !usedWh.has(w) && w.t >= t1 && w.t <= t2);

    function turnover(team, since, pl) {
      // about when the camera turns back toward the end where the next shot happens
      const seg = segs.find((g) => g.side === pl.side && g.start > since && g.start < pl.t);
      let t = seg ? Math.max(since + 1, seg.start - 2) : (since + pl.t) / 2;
      t = Math.min(t, pl.t - 1);
      const wh = whistlesIn(since, pl.t);
      for (const w of wh) usedWh.add(w);
      add({ time: Math.max(t, since), team, type: '턴오버', confidence: wh.length ? '보통' : '낮음',
        note: `${since.toFixed(1)}초에 공을 가졌는데 다음 슛(${pl.t.toFixed(1)}초)은 상대 팀 → 슛 없이 공을 잃음(턴오버). 시각은 추정.`
          + (wh.length ? ` ${wh.map((w) => w.t.toFixed(1)).join(', ')}초 휘슬: 바이얼레이션이나 공격자 파울일 수 있음.` : ' 휘슬이 없어 스틸일 수 있음(스틸은 장면 보기로 확인).') });
    }

    function rebound(last, team, side, next) {
      const opp = other(team), away = OTHER_SIDE[side];
      let t = last.end + P.REB_DT;
      if (next) t = Math.min(t, Math.max(last.end, next.t - 0.3));
      if (next) {
        const nextTeam = teamOf(next.side, next.t);
        const flip = timeOn(segs, away, last.end, next.t) >= P.FLIP_MIN;
        if (nextTeam === team && !flip) {
          return { time: t, team, type: '리바운드', detail: '공격', confidence: next.t - last.end <= 10 ? '보통' : '낮음',
            note: `다음 슛(${next.t.toFixed(1)}초)도 같은 팀이 같은 골대에서 던짐 → 공격 리바운드` };
        }
        if (nextTeam === team) {
          return { time: t, team: opp, type: '리바운드', detail: '수비', confidence: '낮음',
            note: '카메라가 반대쪽 골대로 갔다가 돌아옴 → 상대가 잡았다가 다시 공을 잃은 것으로 추정' };
        }
        return { time: t, team: opp, type: '리바운드', detail: '수비', confidence: '보통',
          note: `다음 슛(${next.t.toFixed(1)}초)은 상대 팀 → 수비 리바운드` };
      }
      const flip = timeOn(segs, away, last.end, Infinity) >= P.FLIP_MIN;
      return { time: t, team: opp, type: '리바운드', detail: '수비', confidence: flip ? '보통' : '낮음',
        note: flip ? '이후 카메라가 반대쪽 골대로 감 → 수비 리바운드' : '이후 슛이 없어 근거가 약함 → 더 흔한 수비 리바운드로 추정' };
    }

    let poss = null, since = null;
    plays.forEach((pl, i) => {
      const team = teamOf(pl.side, pl.t);
      if (poss && team !== poss) turnover(poss, since, pl);
      let last;
      if (pl.kind === 'FG') {
        fgEvent(pl.shot, team);
        last = pl.shot;
      } else {
        const { w, fg, fts } = pl.trip;
        const andOne = fg.made;
        if (andOne) fgEvent(fg, team, '. 슛 직후 휘슬 → 앤드원');
        add({ time: w.t, team: other(team), type: '파울', detail: '슈팅파울', confidence: '낮음',
          note: `${fg.start.toFixed(1)}초 슛 직후 휘슬(${w.t.toFixed(1)}초, ${w.dur.toFixed(1)}초간) → 슈팅 파울. 이어서 같은 골대 자유투 ${fts.length}개.`
            + (andOne ? ' 슛이 들어가 앤드원.' : ' 이 실패한 슛은 야투 시도로 세지 않음(FIBA).') });
        const details = andOne ? ['앤드원'] : fts.length === 2 ? ['3점슛 파울 1구', '3점슛 파울 2구'] : ['2점슛 파울 1구'];
        fts.forEach((ft, k) => add({ time: ft.start, team, type: '자유투', detail: details[k], result: ft.made ? '성공' : '실패',
          side: ft.side, confidence: '낮음',
          note: `${w.t.toFixed(1)}초 휘슬 뒤 같은 골대에서 던진 ${k + 1}번째 슛 → 자유투로 판단. 개수로 정한 세부: ${details[k]}(팀 규칙)` }));
        last = fts[fts.length - 1];
      }
      if (last.made) { poss = other(team); since = last.end; return; }
      const reb = rebound(last, team, pl.side, plays[i + 1] || null);
      add(reb);
      poss = reb.team; since = reb.time;
    });

    for (const w of whistles) {
      if (usedWh.has(w)) continue;
      add({ time: w.t, team: '', type: '휘슬', confidence: '낮음',
        note: `휘슬로 보이는 소리(${w.dur.toFixed(1)}초, 약 ${(w.f / 1000).toFixed(1)}kHz). 파울·바이얼레이션·작전타임 중 무엇인지 장면 보기로 확인하고, 파울이면 '수정'에서 기록을 파울로 바꾸세요. 박스스코어에는 들어가지 않습니다.` });
    }
    ev.sort((a, b) => a.time - b.time);
    const n = (type, f = () => true) => ev.filter((e) => e.type === type && f(e)).length;
    return {
      events: ev,
      summary: { fg: n('야투'), made: n('야투', (e) => e.result === '성공'), ft: n('자유투'), reb: n('리바운드'), oreb: n('리바운드', (e) => e.detail === '공격'),
        to: n('턴오버'), pf: n('파울'), whistles: whistles.length, unknownWhistles: n('휘슬'), dropped: dropped.length },
    };
  }

  const Flow = { P, segments, timeOn, dropConflicts, freeThrowTrips, infer };
  if (typeof window !== 'undefined') window.Flow = Flow;
  if (typeof module !== 'undefined') module.exports = Flow;
})(typeof window !== 'undefined' ? window : globalThis);
