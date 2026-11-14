/* Play flow: from the shots, the camera direction, the scene motion and the whistles, work out what
   happened between the shots. Who got each rebound, when the ball changed hands without a shot
   (turnover), which whistles stopped play (fouls), and which shots were free throws.
   Pure functions on the analysis result; no video access.

   The camera follows the ball, so the hoop it shows tells which end the play is at. The order of
   shots tells who had the ball: after a miss, if the same team shoots again at the same end before
   the camera goes to the other end, they got the offensive rebound; if the other team shoots next,
   it was a defensive rebound. If a team gets the ball but the next shot is by the other team, the
   ball was lost without a shot: a turnover.

   A whistle-like sound counts only if play stops after it (players nearly still for a few seconds).
   A free throw is the first shot at the same hoop after such a whistle, taken while the players
   stand still. Team rule: one free throw per shooting foul. */
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
    // a whistle stopped play: scene motion (share of the median) 1-5 s and 1-12 s after it
    STOP_1_5: 0.7, STOP_1_12: 0.85,
    FOUL_BEFORE: 3.0,   // a fouled shot reaches the rim up to this long before the whistle
    FOUL_AFTER: 1.5,    // ... or this long after it
    ON_SHOT: 2.5,       // a whistle this soon after a missed shot ends play on that shot (no rebound)
    FT_MIN: 4, FT_MAX: 40,       // the free throw comes this long after the whistle
    FT_STILL: 0.4,      // players stand still before a free throw: motion 3-0.7 s before it, share of median
    OREB_GAP: 8,        // one-hoop video: the same team shooting again within this many seconds kept the ball
  };
  const r1 = (x) => Math.round(x * 10) / 10;

  /** camera track [[t, side 0/1/2, x, motion x1000 or -1], ...] -> looks at one end [{side, start, end}] */
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

  /** Scene motion over time, relative to the video's median. Returns null when the track has none. */
  function motionOf(track) {
    const pts = (track || []).filter((r) => r.length > 3 && r[3] >= 0).map((r) => [r[0], r[3]]);
    if (pts.length < 20) return null;
    const sorted = pts.map((p) => p[1]).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] || 1e-6;
    return {
      /** mean motion in [t1, t2) as a share of the median, or null */
      mean(t1, t2) {
        let s = 0, n = 0;
        for (const [t, m] of pts) if (t >= t1 && t < t2) { s += m; n += 1; }
        return n >= 3 ? s / n / med : null;
      },
    };
  }

  /** Did play stop after this whistle? */
  function stopped(mo, w) {
    if (!mo) return false;
    const a = mo.mean(w.t + 1, w.t + 5), b = mo.mean(w.t + 1, w.t + 12);
    return a != null && b != null && a < P.STOP_1_5 && b < P.STOP_1_12;
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

  /** the end the camera shows most in [t1, t2], or null */
  function sideAt(segs, t1, t2) {
    const l = timeOn(segs, '왼쪽', t1, t2), r = timeOn(segs, '오른쪽', t1, t2);
    return l === r ? null : l > r ? '왼쪽' : '오른쪽';
  }

  /** Shooting fouls: a whistle that stopped play, then the first shot at the same hoop within 40 s,
      taken while the players stand still. The fouled shot itself is optional (it is often not seen). */
  function freeThrowTrips(shots, fouls, segs, mo) {
    const used = new Set(), trips = [];
    if (!mo) return { trips, used };
    for (const w of fouls) {
      const near = shots.filter((sh) => !used.has(sh) && sh.start >= w.t - P.FOUL_BEFORE && sh.start <= w.t + P.FOUL_AFTER);
      const fg = near[near.length - 1] || null;
      const side = fg ? fg.side : sideAt(segs, w.t - 1, w.t + 3);
      if (!side) continue;
      const ft = shots.find((sh) => !used.has(sh) && sh !== fg && sh.start > w.t + P.FT_MIN);
      if (!ft || ft.side !== side || ft.start - w.t > P.FT_MAX) continue;
      if (timeOn(segs, OTHER_SIDE[side], w.t, ft.start) >= P.FLIP_MIN) continue;
      const still = mo.mean(ft.start - 3, ft.start - 0.7);
      if (still == null || still >= P.FT_STILL) continue;
      for (const s of fg ? [fg, ft] : [ft]) used.add(s);
      trips.push({ w, fg, fts: [ft], still });
    }
    return { trips, used };
  }

  function infer(result, s) {
    const teams = [s.team_left || '팀 A', s.team_right || '팀 B'];
    const other = (t) => (t === teams[0] ? teams[1] : teams[0]);
    const teamOf = (side, t) => Stats.teamFor(side, t, s);
    const segs = segments(result.track);
    // a fixed camera that films one half never shows the other hoop, so it cannot tell where the ball went
    const seen = ['왼쪽', '오른쪽'].filter((sd) => timeOn(segs, sd, -Infinity, Infinity) >= P.FLIP_MIN);
    const oneHoop = seen.length === 1;
    const mo = motionOf(result.track);
    const { kept, dropped } = dropConflicts(result.shots || [], segs);
    const whistles = [...(result.whistles || [])].sort((a, b) => a.t - b.t);
    const fouls = whistles.filter((w) => stopped(mo, w));
    const { trips, used } = freeThrowTrips(kept, fouls, segs, mo);
    const done = new Set(trips.map((tr) => tr.w));     // whistles already turned into records

    const plays = [];
    for (const sh of kept) if (!used.has(sh)) plays.push({ kind: 'FG', t: sh.start, side: sh.side, shot: sh });
    for (const tr of trips) plays.push({ kind: 'TRIP', t: Math.min(tr.fg ? tr.fg.start : Infinity, tr.w.t), side: tr.fts[0].side, trip: tr });
    plays.sort((a, b) => a.t - b.t);

    const ev = [];
    const add = (o) => ev.push({ player: '', detail: '', result: '', source: '자동', confidence: '낮음', note: '', ...o, time: r1(o.time) });
    const fgEvent = (sh, team, extra = '') => add({
      time: sh.start, team, type: '야투', detail: '2점', result: sh.made ? '성공' : '실패', confidence: sh.confidence, side: sh.side,
      note: '공이 림 높이에 처음 보인 시각(슛을 던진 순간보다 0.3~1초 늦음)'
        + (sh.made && sh.made_t != null ? `. 성공 근거: ${sh.made_t.toFixed(1)}초에 공이 림 가운데 아래로 지나감` : '') + extra,
    });
    const whistleText = (w) => `${w.t.toFixed(1)}초 휘슬(${w.dur.toFixed(1)}초간) 뒤 선수들이 멈춤`;
    function foulEvent(w, team, why) {
      done.add(w);
      add({ time: w.t, team, type: '파울', detail: '개인파울', confidence: '낮음',
        note: `${whistleText(w)} → 파울로 판단. ${why} 공격자 파울이나 바이얼레이션이었으면 '수정'에서 바꾸세요.` });
    }

    function turnover(team, since, pl) {
      // about when the camera turns back toward the end where the next shot happens
      const seg = segs.find((g) => g.side === pl.side && g.start > since && g.start < pl.t);
      let t = seg ? Math.max(since + 1, seg.start - 2) : (since + pl.t) / 2;
      t = Math.min(t, pl.t - 1);
      add({ time: Math.max(t, since), team, type: '턴오버', confidence: '낮음',
        note: `${since.toFixed(1)}초에 공을 가졌는데 다음 슛(${pl.t.toFixed(1)}초)은 상대 팀 → 슛 없이 공을 잃음(턴오버). 시각은 추정. 스틸이었는지는 장면 보기로 확인.` });
    }

    function rebound(last, team, side, next) {
      const opp = other(team), away = OTHER_SIDE[side];
      let t = last.end + P.REB_DT;
      if (next) t = Math.min(t, Math.max(last.end, next.t - 0.3));
      if (next) {
        const nextTeam = teamOf(next.side, next.t);
        const flip = timeOn(segs, away, last.end, next.t) >= P.FLIP_MIN;
        if (oneHoop && nextTeam === team && next.t - last.end > P.OREB_GAP) {
          return { time: t, team: opp, type: '리바운드', detail: '수비', confidence: '낮음',
            note: `한쪽 골대만 찍은 영상: 다음 슛까지 ${Math.round(next.t - last.end)}초라 상대가 잡아 반대쪽으로 갔다 온 것으로 추정 → 수비 리바운드` };
        }
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

    // fouls that stopped play between plays: on the team without the ball (the usual case)
    let poss = null, since = null;
    const foulsBetween = (t1, t2) => {
      for (const w of fouls) {
        if (done.has(w) || w.t < t1 || w.t >= t2) continue;
        if (poss) foulEvent(w, other(poss), `그때 공을 가진 ${poss}의 상대 팀 파울로 봄.`);
        else { done.add(w); add({ time: w.t, team: '', type: '휘슬', note: `${whistleText(w)}. 어느 팀 파울인지 정하지 못함. 장면을 보고 '수정'에서 파울로 바꾸세요.` }); }
      }
    };

    plays.forEach((pl, i) => {
      const team = teamOf(pl.side, pl.t);
      foulsBetween(-Infinity, pl.t);
      if (poss && team !== poss) turnover(poss, since, pl);
      let last;
      if (pl.kind === 'FG') {
        fgEvent(pl.shot, team);
        last = pl.shot;
      } else {
        const { w, fg, fts, still } = pl.trip;
        const andOne = !!(fg && fg.made);
        if (andOne) fgEvent(fg, team, '. 슛 직후 휘슬 → 앤드원');
        add({ time: w.t, team: other(team), type: '파울', detail: '슈팅파울', confidence: '낮음',
          note: `${whistleText(w)}, ${fts[0].start.toFixed(1)}초에 같은 골대에서 선수들이 선 채로 슛 1개 → 슈팅 파울과 자유투로 판단.`
            + (fg ? (andOne ? ' 슛이 들어가 앤드원.' : ` ${fg.start.toFixed(1)}초의 실패한 슛은 야투 시도로 세지 않음(FIBA).`) : '') });
        const detail = andOne ? '앤드원' : '2점슛 파울';
        for (const ft of fts) {
          add({ time: ft.start, team, type: '자유투', detail, result: ft.made ? '성공' : '실패', side: ft.side, confidence: '낮음',
            note: `${w.t.toFixed(1)}초 휘슬 뒤 같은 골대에서 선수들이 서 있는 가운데 던진 슛(직전 움직임 ${Math.round(still * 100)}%) → 자유투. 팀 규칙: 자유투 1개`
              + (andOne ? ', 앤드원은 성공 시 1점.' : ", 성공 시 2점. 3점슛을 던지다 당한 파울이면 세부를 '3점슛 파울'로 바꾸면 3점.") });
        }
        last = fts[fts.length - 1];
      }
      if (last.made) { poss = other(team); since = last.end; return; }
      // a whistle right after a missed shot ends play on that shot: foul on the defence, no rebound
      const onShot = fouls.find((w) => !done.has(w) && w.t >= last.end - 0.5 && w.t <= last.end + P.ON_SHOT);
      if (onShot) {
        foulEvent(onShot, other(team), `${last.start.toFixed(1)}초 슛 직후라 수비 팀(${other(team)}) 파울로 봄. 리바운드 없이 ${team} 공격 계속.`);
        poss = team; since = onShot.t;
        return;
      }
      const reb = rebound(last, team, pl.side, plays[i + 1] || null);
      add(reb);
      poss = reb.team; since = reb.time;
    });
    foulsBetween(-Infinity, Infinity);

    ev.sort((a, b) => a.time - b.time);
    const n = (type, f = () => true) => ev.filter((e) => e.type === type && f(e)).length;
    return {
      events: ev,
      summary: { fg: n('야투'), made: n('야투', (e) => e.result === '성공'), ft: n('자유투'), reb: n('리바운드'), oreb: n('리바운드', (e) => e.detail === '공격'),
        to: n('턴오버'), pf: n('파울'), whistles: whistles.length, fouls: fouls.length, unknownWhistles: n('휘슬'), dropped: dropped.length,
        motion: !!mo },
    };
  }

  const Flow = { P, segments, timeOn, motionOf, stopped, dropConflicts, freeThrowTrips, infer };
  if (typeof window !== 'undefined') window.Flow = Flow;
  if (typeof module !== 'undefined') module.exports = Flow;
})(typeof window !== 'undefined' ? window : globalThis);
