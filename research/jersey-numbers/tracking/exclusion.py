"""Shooter by elimination: at the gather, numbers of the shooter's team read on OTHER people (both cameras,
within a short time) are not the shooter; if one roster number is left, that is the shooter."""
import json, sys
sys.path.insert(0, '.')
from eval2 import decide
ROSTER = {'navy': {'11', '16', '28', '44', '77'}, 'white': {'0', '9', '13', '33', '69'}}   # as found from the whole game
NAVY = ROSTER['navy']
OFFSET = 1.12                     # right video starts 1.12 s later: time t in R = t + 1.12 on L's clock
SURE = {'L1', 'L5', 'L7', 'L16', 'R0', 'R1', 'R4', 'R5', 'R7', 'R14', 'R16'}
G = {c: json.load(open(f'game_{c}.json')) for c in 'LR'}
shots = {f"{s['cam']}{s['k']}": s for s in json.load(open('/home/user/basketball-boxscore/research/jersey-numbers/data/shots.json'))['shots']}
v2 = {f"{c}{r['k']}": r for c in 'LR' for r in json.load(open(f'shooter2_{c}.json'))}
def clock(c, t): return t if c == 'L' else t + OFFSET
def others_seen(c, s, team, win):
    """numbers of `team` read within `win` s of the gather on people not holding the ball"""
    sc = G[c]['W'] / 768; gt, gx, gy = s['ball'][s['gather']]; T = clock(c, gt); seen = {}
    for cam in 'LR':
        for t in G[cam]['tracks']:
            for rt, n, conf, h in t['reads']:
                if conf < 0.9 or n not in ROSTER[team] or abs(clock(cam, rt) - T) > win: continue
                if cam == c:
                    b = t['boxes'].get(str(int(round(rt * G[cam]['fps']))))
                    if b and b[0] - 0.3 * (b[2] - b[0]) <= gx * sc <= b[2] + 0.3 * (b[2] - b[0]) and abs(rt - gt) < 0.5:
                        continue                                  # this may be the ball holder himself
                seen[n] = seen.get(n, 0) + 1
    return seen
out = {'right': [], 'wrong': [], 'none': [], 'given (unlabelled)': []}
for sid, s in shots.items():
    gt = s['shooter']; r = v2.get(sid)
    n, _ = decide(r['reads'], s['ball'][s['gather']][0]) if r else (None, 0)
    # the shooter's team: from the number if read, else from the hoop (white attacks left, navy right in this game)
    team = ('navy' if n in NAVY else 'white') if n in NAVY | ROSTER['white'] else ('white' if s['cam'] == 'L' else 'navy')
    how = 'read'
    if n not in ROSTER[team]: n = None
    if not n:
        for win in (0.5, 1.0, 2.0):
            seen = others_seen(s['cam'], s, team, win)
            left = ROSTER[team] - set(seen)
            if len(left) == 1: n = next(iter(left)); how = f'elimination ±{win}s'; break
    kind = ('right' if n == gt else 'wrong' if n else 'none') if gt else ('given (unlabelled)' if n else None)
    if kind: out[kind].append(sid + ('' if sid in SURE or not gt else '?') + (f':{n}' if not gt else ''))
    print(f"{sid:4} label {gt or '-':>2} -> {n or '-':>2} {how if n else ''}")
for k, v in out.items(): print(f'{k:20} {len(v):2}  {" ".join(v)}')
