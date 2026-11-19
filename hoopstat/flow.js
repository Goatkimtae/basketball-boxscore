/* Play flow: what happened between the shots.

   infer(result, settings)  - once after the analysis: shots -> field goals, whistles that stopped play
                              -> fouls, still shots after a foul -> free throws; then derive().
   derive(events, settings, ctx) - any time the record changes: rebuilds the rebounds and turnovers from
                              the shots as they are now (after the user confirmed made / missed, deleted
                              a false shot, added a foul ...). Pure functions; no video access.

   Three ways of filming (ctx.mode):
     'pan'  one camera that follows the ball: the hoop it shows tells which end the play is at
     'two'  one fixed camera per hoop: both hoops are covered, but nothing shows the ball changing ends
     'one'  one fixed camera on one hoop: the other team's shots are not seen at all

   Rebound: after a miss, if the same team shoots again at that hoop soon (pan: before the camera goes
   to the other end; fixed cameras: within 10 s) it was an offensive rebound, otherwise defensive.
   Turnover: a team has the ball but the next shot is the other team's (not in 'one' mode).
   Foul ('pan' only): a whistle-like sound after which play stops (players nearly still for a few seconds).
   Free throw ('pan' only): the first shot at the same hoop within 40 s of a foul, taken while players stand still.
   With fixed cameras players walk through the picture after a whistle, so the stoppage test does not
   work (checked on one game: none of about nine whistles passed; the whole-picture motion did not tell
   stops from play on 22 labelled sounds either, research/whistles/).
   Two fixed cameras: a whistle while a shot reaches the rim, and the very next shot of the game at the
   same hoop 8-40 s later, is a shooting foul and its free throw (22 labelled sounds of one game: the 3
   fouls found, no false ones). The other whistle-like sounds are closed as not fouls (a foul without
   free throws is not counted). One fixed camera: the sounds are listed ('휘슬') for the user to judge.
   Team rule: one free throw per shooting foul. */
'use strict';
(function (root) {
  const Stats = root.Stats || (typeof require !== 'undefined' ? require('./stats.js') : null);
  const OTHER_SIDE = { 왼쪽: '오른쪽', 오른쪽: '왼쪽' };
  const SIDE_OF = { 1: '왼쪽', 2: '오른쪽' };
  const P = {
    SEG_GAP: 0.6,       // the camera may lose the hoop this long within one look at an end
    SEG_MIN: 1.0,       // shorter looks are ignored
    FLIP_MIN: 2.0,      // this many seconds on the other end means the ball went there
    CONFLICT: 2.5,      // pan camera: two shots at opposite ends closer than this cannot both be real
    REB_DT: 0.3,        // rebound: this long after the ball was last seen at the rim
    OREB_GAP: 10,       // fixed cameras: the same team shooting again within this many seconds kept the ball
    // a whistle stopped play: scene motion (share of the median) 1-5 s and 1-12 s after it
    STOP_1_5: 0.7, STOP_1_12: 0.85,
    FOUL_BEFORE: 3.0,   // a fouled shot reaches the rim up to this long before the whistle
    FOUL_AFTER: 1.5,    // ... or this long after it
    ON_SHOT: 2.5,       // a whistle this soon after a missed shot ends play on that shot (no rebound)
    DEAD_AFTER: 4.0,    // derive(): a foul recorded within this long after a missed shot means no rebound
    FT_MIN: 4, FT_MAX: 40,       // the free throw comes this long after the whistle
    FT_STILL: 0.4,      // players stand still before a free throw: motion 3-0.7 s before it, share of median
    MARK_DUR: 0.5,      // fixed cameras: whistle-like sounds this long are listed for the user to judge
    // two fixed cameras: a shot while this camera moves less than PRACTICE x the other one (3 s before to 1 s after)
    // is someone practising at the empty hoop: the players are at the other end. Each camera's motion is taken
    // in 0.2 s slots, as a share of its 75th percentile slot (the median can be 0 when frames repeat). Checked on
    // one game: practice up to about 0.3, game shots 0.52 and up. The other camera must move at least PRACTICE_OTHER of its scale.
    PRACTICE: 0.4, PRACTICE_OTHER: 0.2,
    // two fixed cameras: a shooting foul is a whistle while a shot reaches the rim (the shot first seen at rim height
    // up to FOUL_BEFORE before the whistle or FT2_SHOT after it; measured 0.1-0.4 s before on the 3 labelled fouls,
    // sounds 0.8-1.4 s before a shot were not fouls), then the next shot at the same hoop FT2_MIN-FT_MAX s later
    // (measured 13-14 s; a live second shot at that hoop came 6.7 s after the first)
    FT2_SHOT: 0.5, FT2_MIN: 8,
  };
  const r1 = (x) => Math.round(x * 10) / 10;
  const isShot = (e) => e.type === '야투' || e.type === '자유투';

  /* ------------------------------------------------------------ camera direction and motion */
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
  /** the end the camera shows most in [t1, t2], or null */
  function sideAt(segs, t1, t2) {
    const l = timeOn(segs, '왼쪽', t1, t2), r = timeOn(segs, '오른쪽', t1, t2);
    return l === r ? null : l > r ? '왼쪽' : '오른쪽';
  }

  /** Scene motion over time, relative to the video's median; shift moves the track onto the game clock. */
  function motionOf(track, shift = 0) {
    const pts = (track || []).filter((r) => r.length > 3 && r[3] >= 0).map((r) => [r[0] + shift, r[3]]);
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

  /** Two fixed cameras [{shots, track, offset}]: each camera's shots split into game shots and practice at the
      empty hoop (much less motion there than at the other end, where the players are). */
  /** motion in 0.2 s slots (the largest value in each: repeated frames, which show no change, cannot pull it
      down), as a share of the camera's 75th percentile slot; shift moves the track onto the game clock */
  function slotMotion(track, shift = 0) {
    const slot = new Map();
    for (const r of track || []) {
      if (r.length < 4 || r[3] < 0) continue;
      const k = Math.floor((r[0] + shift) / 0.2);
      slot.set(k, Math.max(slot.get(k) ?? 0, r[3]));
    }
    if (slot.size < 20) return null;
    const sorted = [...slot.values()].sort((x, y) => x - y), sc = Math.max(1, sorted[Math.floor(sorted.length * 0.75)]);
    return { mean(t1, t2) {
      let a = 0, n = 0;
      for (let k = Math.ceil(t1 / 0.2); k * 0.2 < t2; k++) if (slot.has(k)) { a += slot.get(k); n += 1; }
      return n >= 3 ? a / n / sc : null;
    } };
  }
  function splitPractice(cams) {
    const mos = cams.map((c) => slotMotion(c.track, c.offset || 0));
    return cams.map((c, i) => {
      const me = mos[i], other = mos[1 - i], game = [], practice = [];
      for (const sh of c.shots || []) {
        const t = sh.start + (c.offset || 0);
        const a = me && me.mean(t - 3, t + 1), b = other && other.mean(t - 3, t + 1);
        const ratio = a != null && b ? Math.round((a / b) * 100) / 100 : null;
        if (a != null && b != null && b >= P.PRACTICE_OTHER && a / b < P.PRACTICE) practice.push({ ...sh, motionRatio: ratio });
        else game.push({ ...sh, motionRatio: ratio });
      }
      return { game, practice };
    });
  }

  /** Did play stop after this whistle? Every camera that has a picture then must show it. */
  function stopped(mos, w) {
    const list = (Array.isArray(mos) ? mos : [mos]).filter(Boolean)
      .map((mo) => [mo.mean(w.t + 1, w.t + 5), mo.mean(w.t + 1, w.t + 12)]).filter(([a, b]) => a != null && b != null);
    return list.length > 0 && list.every(([a, b]) => a < P.STOP_1_5 && b < P.STOP_1_12);
  }

  /** Pan camera: two shots at opposite ends within 2.5 s: keep the one at the end the camera settles on. */
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

  /* ------------------------------------------------------------ rebounds and turnovers */
  function possession(base, s, ctx) {
    const mode = (ctx && ctx.mode) || 'pan', segs = (ctx && ctx.segs) || [];
    const teams = [s.team_left || '팀 A', s.team_right || '팀 B'];
    const other = (t) => (t === teams[0] ? teams[1] : teams[0]);
    const sideOf = (team, t) => (Stats.teamFor('왼쪽', t, s) === team ? '왼쪽' : '오른쪽');
    const shots = base.filter(isShot);
    const out = [], timeline = [];
    const add = (o) => out.push({ player: '', detail: '', result: '', source: '자동', confidence: '낮음', note: '', derived: true, ...o, time: r1(o.time) });
    const endOf = (e) => (e.end != null && e.end >= e.time && e.end <= e.time + 6 ? e.end : e.time + 1);
    let poss = null, since = null, by = null;
    // by: the record that gave the team the ball (a rebound: its player probably brought the ball up)
    const have = (team, t, from = null) => { poss = team; since = t; by = from; timeline.push([t, team]); };
    const mostSeen = (ctx && ctx.mostSeen) || {};
    // rebounds / turnovers the user deleted (tombstones: the record they follow) are not made again
    const removed = (ctx && ctx.removed) || [];
    const gone = (type, of) => !!of && removed.some((r) => r.type === type && r.of === of);

    function turnover(team, e) {
      if (gone('턴오버', e.id)) return;
      let t;
      if (mode === 'pan') {
        // about when the camera turns back toward the end where the next shot happens
        const side = e.side || sideOf(e.team, e.time);
        const seg = segs.find((g) => g.side === side && g.start > since && g.start < e.time);
        t = seg ? Math.max(since + 1, seg.start - 2) : (since + e.time) / 2;
      } else {
        t = Math.max(since + 1, e.time - 5);
      }
      t = Math.max(Math.min(t, e.time - 1), since);
      // who lost it: not seen; the rebounder who started this possession, else the team's most often seen number
      const who = by && by.team === team && (by.player || '').trim() ? by.player : mostSeen[team] || '';
      add({ time: t, team, type: '턴오버', side: sideOf(team, t), of: e.id, ...(who ? { player: who, playerAuto: true, playerGuess: true } : {}),
        note: `${since.toFixed(1)}초에 공을 가졌는데 다음 슛(${Number(e.time).toFixed(1)}초)은 상대 팀 → 슛 없이 공을 잃음(턴오버). 시각은 추정.`
          + (mode === 'two' ? ' 앱이 이 팀의 슛을 놓쳤을 수도 있으니 장면 보기로 확인.' : ' 스틸이었는지는 장면 보기로 확인.') });
    }

    function rebound(e, team, next) {
      const opp = other(team), side = e.side || sideOf(team, e.time), away = OTHER_SIDE[side], end = endOf(e);
      let t = end + P.REB_DT;
      if (next) t = Math.min(t, Math.max(end, next.time - 0.3));
      const o = { time: t, type: '리바운드', side };
      if (!next) {
        const flip = mode === 'pan' && timeOn(segs, away, end, Infinity) >= P.FLIP_MIN;
        return { ...o, team: opp, detail: '수비', confidence: flip ? '보통' : '낮음',
          note: flip ? '이후 카메라가 반대쪽 골대로 감 → 수비 리바운드' : '이후 슛이 없어 근거가 약함 → 더 흔한 수비 리바운드로 추정' };
      }
      const nt = Number(next.time).toFixed(1), gap = next.time - end;
      if (next.team !== team) {
        return { ...o, team: opp, detail: '수비', confidence: '보통', note: `다음 슛(${nt}초)은 상대 팀 → 수비 리바운드` };
      }
      if (mode === 'pan') {
        if (timeOn(segs, away, end, next.time) < P.FLIP_MIN) {
          return { ...o, team, detail: '공격', confidence: gap <= 10 ? '보통' : '낮음', note: `다음 슛(${nt}초)도 같은 팀이 같은 골대에서 던짐 → 공격 리바운드` };
        }
        return { ...o, team: opp, detail: '수비', note: '카메라가 반대쪽 골대로 갔다가 돌아옴 → 상대가 잡았다가 다시 공을 잃은 것으로 추정' };
      }
      if (gap <= P.OREB_GAP) {
        return { ...o, team, detail: '공격', confidence: '보통', note: `${Math.round(gap)}초 뒤(${nt}초) 같은 팀이 같은 골대에서 다시 던짐 → 공격 리바운드` };
      }
      return { ...o, team: opp, detail: '수비',
        note: `같은 팀의 다음 슛까지 ${Math.round(gap)}초 → 상대가 잡아 반대쪽으로 갔다 온 것으로 추정(고정 카메라라 공의 이동은 보이지 않음)` };
    }

    // the rebounder's number the players stage found for that team (put-back shooter, read, or best guess)
    const withPlayer = (e, reb) => {
      const r = e.reb && e.reb[reb.team];
      return r && r.number ? { ...reb, player: r.number, playerAuto: true, playerGuess: !!r.guess } : reb;
    };
    for (const e of base) {
      const T = e.team;
      if (!T) continue;
      if (isShot(e)) {
        if (e.type === '야투' && poss && T !== poss && mode !== 'one') turnover(poss, e);
        if (e.result === '성공') { have(other(T), e.time + 1); continue; }
        const next = shots[shots.indexOf(e) + 1] || null, tNext = next ? next.time : Infinity;
        // a foul right after the miss: dead ball, no rebound (the foul event sets who has the ball)
        if (base.some((f) => f.type === '파울' && f.time >= e.time - 0.5 && f.time <= Math.min(endOf(e) + P.DEAD_AFTER - 1, tNext))) { have(T, e.time); continue; }
        // a rebound the user entered for this miss stands
        if (base.some((f) => f.type === '리바운드' && f.time >= e.time - 0.2 && f.time < tNext && f !== e)) continue;
        if (gone('리바운드', e.id)) { poss = null; continue; }      // deleted by the user: who got the ball is not known
        const reb = { ...withPlayer(e, rebound(e, T, next)), of: e.id };
        add(reb);
        have(reb.team, reb.time, reb);
      } else if (e.type === '파울' || e.type === '턴오버') have(other(T), e.time);
      else if (e.type === '리바운드' || e.type === '스틸') have(T, e.time, e);
    }
    return { derived: out, timeline };
  }

  /** Rebuild the automatic rebounds and turnovers; everything else is kept as it is. */
  /** Automatic whistle rows (with fixed cameras every whistle-like sound): the team that most likely fouled, as a
      guess for the quick review. A shot from 3 s before to 1.5 s after the whistle: a shooting foul by its defending
      team. Otherwise the opponent of the team that had the ball then (most fouls are defensive). Whistle rows are
      not counted until someone confirms them as a foul. */
  function guessWhistles(base, timeline, s) {
    const teams = [s.team_left || '팀 A', s.team_right || '팀 B'];
    const other = (t) => (t === teams[0] ? teams[1] : teams[0]);
    const shots = base.filter((e) => e.type === '야투' && teams.includes(e.team));
    const possAt = (t) => { let p = null; for (const [tt, team] of timeline) if (tt <= t) p = team; return p; };
    for (const w of base) {
      if (w.type !== '휘슬' || w.source !== '자동' || w.checked || (w.team && !w.teamGuess)) continue;
      if (w.noteBase == null) w.noteBase = w.note || '';
      const sh = shots.filter((e) => e.time >= w.time - P.FOUL_BEFORE && e.time <= w.time + P.FOUL_AFTER).pop();
      let team = '', why = '';
      if (sh) {
        team = other(sh.team);
        why = `팀 추정: ${Number(sh.time).toFixed(1)}초 ${sh.team} 슛${(sh.player || '').trim() ? `(${sh.player}번)` : ''} 바로 근처 → 파울이면 수비 팀 ${team}의 슈팅파울로 보임.`;
      } else {
        const p = possAt(w.time);
        if (p && teams.includes(p)) { team = other(p); why = `팀 추정: 그때 공을 가진 ${p}의 상대 팀(대부분의 파울은 수비 파울).`; }
      }
      w.team = team; w.teamGuess = !!team; w.guessDetail = team ? (sh ? '슈팅파울' : '개인파울') : '';
      w.note = why ? `${w.noteBase} ${why}` : w.noteBase;
    }
  }
  function derive(events, s, ctx) {
    const isOld = (e) => e.derived && e.source === '자동';
    const old = events.filter(isOld);
    const base = events.filter((e) => !isOld(e)).sort((a, b) => a.time - b.time);
    const { derived, timeline } = possession(base, s, ctx);
    guessWhistles(base, timeline, s);
    // keep the id and the jersey number of a rebound / turnover that is still there
    for (const d of derived) {
      const k = old.findIndex((o) => o.type === d.type && o.team === d.team && Math.abs(o.time - d.time) <= 1.5);
      if (k < 0) continue;
      const o = old.splice(k, 1)[0];
      if (o.id) d.id = o.id;
      if ((o.player || '').trim() && !(o.playerAuto && d.playerAuto)) { d.player = o.player; d.playerAuto = !!o.playerAuto; d.playerGuess = !!o.playerGuess; }
    }
    return [...base, ...derived].sort((a, b) => a.time - b.time);
  }
  /** derive() quarter by quarter (each quarter has its own timeline); ctxOf(q) gives that quarter's ctx, and s is the
      settings or a function q -> settings (each quarter has its own attack direction) */
  function deriveQuarters(events, s, ctxOf) {
    const qOf = (e) => Number(e.q) || 1;
    const qs = [...new Set(events.map(qOf))].sort((a, b) => a - b);
    return qs.flatMap((q) => derive(events.filter((e) => qOf(e) === q), typeof s === 'function' ? s(q) : s, ctxOf(q)).map((e) => (e.q === q ? e : { ...e, q })));
  }

  /* ------------------------------------------------------------ after the analysis */
  function infer(result, s) {
    const teams = [s.team_left || '팀 A', s.team_right || '팀 B'];
    const other = (t) => (t === teams[0] ? teams[1] : teams[0]);
    const teamOf = (side, t) => Stats.teamFor(side, t, s);
    const cams = result.cams && result.cams.length ? result.cams : [{ id: 'A', side: null, track: result.track, offset: 0 }];
    const two = cams.length >= 2;
    const segs = two ? [] : segments(cams[0].track);
    const seen = ['왼쪽', '오른쪽'].filter((sd) => timeOn(segs, sd, -Infinity, Infinity) >= P.FLIP_MIN);
    const mode = two ? 'two' : seen.length === 1 ? 'one' : 'pan';
    const ctx = { mode, segs: segs.map((g) => ({ side: g.side, start: r1(g.start), end: r1(g.end) })), ...(result.mostSeen ? { mostSeen: result.mostSeen } : {}) };
    const mos = cams.map((c) => ({ side: c.side, mo: motionOf(c.track, c.offset || 0) })).filter((x) => x.mo);
    const moFor = (side) => (two ? (mos.find((x) => x.side === side) || {}).mo || null : mos.length ? mos[0].mo : null);

    const all = [...(result.shots || [])].sort((a, b) => a.start - b.start);
    const { kept, dropped } = mode === 'pan' ? dropConflicts(all, segs) : { kept: all, dropped: [] };
    const whistles = [...(result.whistles || [])].sort((a, b) => a.t - b.t);
    // whistles that may be fouls: pan camera, play stopped after it; two cameras, every whistle (the free throw decides)
    let fouls = mode === 'pan' ? whistles.filter((w) => stopped(mos.map((x) => x.mo), w))
      : two ? whistles.filter((w) => w.dur >= P.MARK_DUR) : [];
    // the most often seen number of each team (players stage): the fallback guess for a player nobody could see
    const fallback = (team) => (result.mostSeen && result.mostSeen[team]) || '';

    // shooting fouls: a foul, then the first shot at the same hoop within 40 s, taken while players stand still
    const used = new Set(), trips = [];
    for (const w of fouls) {
      const near = kept.filter((sh) => !used.has(sh) && sh.start >= w.t - P.FOUL_BEFORE && sh.start <= w.t + (two ? P.FT2_SHOT : P.FOUL_AFTER));
      const fg = near[near.length - 1] || null;
      if (two) {
        // two fixed cameras: the fouled shot must be seen, and the free throw is the very next shot of the game
        const next = fg && kept.find((sh) => sh.start > fg.start && sh !== fg);
        if (!next || used.has(next) || next.side !== fg.side || next.start - w.t < P.FT2_MIN || next.start - w.t > P.FT_MAX) continue;
        used.add(fg); used.add(next);
        trips.push({ w, fg, ft: next, still: null });
        continue;
      }
      const ft = kept.find((sh) => !used.has(sh) && sh !== fg && sh.start > w.t + P.FT_MIN);
      if (!ft || ft.start - w.t > P.FT_MAX) continue;
      const side = fg ? fg.side : two ? ft.side : sideAt(segs, w.t - 1, w.t + 3);
      if (!side || ft.side !== side) continue;
      if (!two && timeOn(segs, OTHER_SIDE[side], w.t, ft.start) >= P.FLIP_MIN) continue;
      const mo = moFor(side), still = mo ? mo.mean(ft.start - 3, ft.start - 0.7) : null;
      if (still == null || still >= P.FT_STILL) continue;
      for (const sh of fg ? [fg, ft] : [ft]) used.add(sh);
      trips.push({ w, fg, ft, still });
    }
    const tripOf = new Map(trips.map((tr) => [tr.w, tr]));
    if (two) fouls = trips.map((tr) => tr.w);

    const ev = [];
    const add = (o) => { const e = { player: '', detail: '', result: '', source: '자동', confidence: '낮음', note: '', ...o, time: r1(o.time) }; ev.push(e); return e; };
    // the shooter's number when the players stage read it (see players.js)
    const shooter = (sh) => ({ ...(sh.player ? { player: sh.player, playerAuto: !!sh.playerAuto, playerGuess: !!sh.playerGuess } : {}), ...(sh.reb ? { reb: sh.reb } : {}), ...(sh.def ? { def: sh.def } : {}) });
    // who fouled: the shooter's nearest opponent (read or guessed by the players stage), else the fouling team's fallback
    const fouler = (team, sh) => {
      if (sh && sh.def && sh.def.team === team && sh.def.number) return { player: sh.def.number, playerAuto: true, playerGuess: !!sh.def.guess };
      const f = fallback(team);
      return f ? { player: f, playerAuto: true, playerGuess: true } : {};
    };
    const whistleText = (w) => `${w.t.toFixed(1)}초 휘슬(${w.dur.toFixed(1)}초간) 뒤 선수들이 멈춤`;
    const fgEvent = (sh, extra = '') => add({
      time: sh.start, end: r1(sh.end), team: teamOf(sh.side, sh.start), type: '야투', detail: '2점', result: sh.made ? '성공' : '실패',
      confidence: sh.confidence, side: sh.side, cam: sh.cam, ...shooter(sh), ...(sh.gather && sh.gather.t != null ? { release: r1(sh.gather.t) } : {}),
      note: '시각은 공이 림 높이에 처음 보인 때(슛을 던진 순간보다 0.3~1초 늦음). 쿼터는 공을 놓은 때(release)로 정함'
        + (sh.made && sh.made_t != null ? `. 성공 근거: ${sh.made_t.toFixed(1)}초에 공이 그물 안으로 떨어짐` : '') + extra,
    });
    for (const sh of kept) if (!used.has(sh)) fgEvent(sh);
    for (const { w, fg, ft, still } of trips) {
      const team = teamOf(ft.side, ft.start), andOne = !!(fg && fg.made);
      if (andOne) fgEvent(fg, '. 슛 직후 휘슬 → 앤드원');
      add({ time: w.t, team: other(team), type: '파울', detail: '슈팅파울', side: ft.side, cam: ft.cam, ...fouler(other(team), fg),
        note: (still == null ? `${w.t.toFixed(1)}초 슛 순간 휘슬(${w.dur.toFixed(1)}초간), ${ft.start.toFixed(1)}초에 같은 골대에서 다음 슛 → 슈팅 파울과 자유투로 판단(자동).`
          : `${whistleText(w)}, ${ft.start.toFixed(1)}초에 같은 골대에서 선수들이 선 채로 슛 1개 → 슈팅 파울과 자유투로 판단.`)
          + (fg ? (andOne ? ' 슛이 들어가 앤드원.' : ` ${fg.start.toFixed(1)}초의 실패한 슛은 야투 시도로 세지 않음(FIBA).`) : '') });
      const detail = andOne ? '앤드원' : '2점슛 파울';
      add({ time: ft.start, end: r1(ft.end), team, type: '자유투', detail, result: ft.made ? '성공' : '실패', side: ft.side, cam: ft.cam, ...shooter(ft),
        note: (still == null ? `${w.t.toFixed(1)}초 슛 순간 휘슬 뒤 ${(ft.start - w.t).toFixed(0)}초 만에 같은 골대에서 던진 다음 슛 → 자유투. 팀 규칙: 자유투 1개`
          : `${w.t.toFixed(1)}초 휘슬 뒤 같은 골대에서 선수들이 서 있는 가운데 던진 슛(직전 움직임 ${Math.round(still * 100)}%) → 자유투. 팀 규칙: 자유투 1개`)
          + (andOne ? ', 앤드원은 성공 시 1점.' : ", 성공 시 2점. 3점슛을 던지다 당한 파울이면 세부를 '3점슛 파울'로 바꾸면 3점.") });
    }

    // the other fouls: on the team without the ball (the usual case); right after a missed shot, on that shot's defence
    ev.sort((a, b) => a.time - b.time);
    const { timeline } = possession(ev, s, ctx);
    const possAt = (t) => { let p = null; for (const [tt, team] of timeline) { if (tt <= t) p = team; else break; } return p; };
    const fgs = ev.filter((e) => e.type === '야투');
    for (const w of fouls) {
      if (tripOf.has(w)) continue;
      const onShot = fgs.find((e) => e.result !== '성공' && w.t >= e.end - 0.5 && w.t <= e.end + P.ON_SHOT);
      if (onShot) {
        add({ time: w.t, team: other(onShot.team), type: '파울', detail: '개인파울', side: onShot.side, cam: onShot.cam, ...fouler(other(onShot.team), onShot),
          note: `${whistleText(w)} → 파울로 판단. ${Number(onShot.time).toFixed(1)}초 슛 직후라 수비 팀(${other(onShot.team)}) 파울로 봄. 리바운드 없이 ${onShot.team} 공격 계속. 공격자 파울이나 바이얼레이션이었으면 '수정'에서 바꾸세요.` });
        continue;
      }
      const p = possAt(w.t);
      if (p) {
        add({ time: w.t, team: other(p), type: '파울', detail: '개인파울', ...fouler(other(p), null),
          note: `${whistleText(w)} → 파울로 판단. 그때 공을 가진 ${p}의 상대 팀 파울로 봄. 공격자 파울이나 바이얼레이션이었으면 '수정'에서 바꾸세요.` });
      } else {
        add({ time: w.t, team: '', type: '휘슬', note: `${whistleText(w)}. 어느 팀 파울인지 정하지 못함. 장면을 보고 '수정'에서 파울로 바꾸세요.` });
      }
    }

    if (mode !== 'pan') {
      for (const w of whistles) {
        if (w.dur < P.MARK_DUR || fouls.includes(w)) continue;
        if (two) {
          // judged automatically: no free throw followed, so not counted as a foul (kept closed for the record, not reviewed)
          add({ time: w.t, team: '', type: '휘슬', checked: true, confidence: '자동',
            note: `휘슬로 보이는 소리(${w.dur.toFixed(1)}초, 약 ${(w.f / 1000).toFixed(1)}kHz) 뒤 자유투가 없어 파울로 세지 않음(자동). 자유투 없는 파울(일반 파울)이었으면 '수정'에서 파울로 바꾸세요.` });
        } else {
          add({ time: w.t, team: '', type: '휘슬',
            note: `휘슬로 보이는 소리(${w.dur.toFixed(1)}초, 약 ${(w.f / 1000).toFixed(1)}kHz). 이 카메라 영상에서는 파울인지 자동으로 가리지 못합니다. 빠른 검토에서 파울이면 팀을 고르고, 아니면 지우세요.` });
        }
      }
    }

    const events = derive(ev, s, ctx);
    const n = (type, f = () => true) => events.filter((e) => e.type === type && f(e)).length;
    return {
      events, ctx,
      summary: { fg: n('야투'), made: n('야투', (e) => e.result === '성공'), ft: n('자유투'), reb: n('리바운드'), oreb: n('리바운드', (e) => e.detail === '공격'),
        to: n('턴오버'), pf: n('파울'), whistles: whistles.length, fouls: fouls.length, unknownWhistles: n('휘슬'), dropped: dropped.length,
        motion: mos.length > 0, mode },
    };
  }

  const Flow = { P, segments, timeOn, motionOf, slotMotion, splitPractice, stopped, dropConflicts, possession, guessWhistles, derive, deriveQuarters, infer };
  if (typeof window !== 'undefined') window.Flow = Flow;
  if (typeof module !== 'undefined') module.exports = Flow;
})(typeof window !== 'undefined' ? window : globalThis);
