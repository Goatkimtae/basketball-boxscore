"""From the whole-game tracks: team shirt colours, the numbers of each team, which team attacks which hoop,
and the shooter's number for each labelled shot (with links to the tracks just before and after)."""
import json, math, sys, numpy as np, cv2
from collections import Counter, defaultdict
R = 22.0
NAVY, WHITE = {'11', '44', '28', '77', '16', '21'}, {'33', '13', '69', '9', '0', '3'}
SURE = {'L1', 'L5', 'L7', 'L16', 'R0', 'R1', 'R4', 'R5', 'R7', 'R14', 'R16'}
shots = [s for s in json.load(open('/home/user/basketball-boxscore/research/jersey-numbers/data/shots.json'))['shots']]
G = {c: json.load(open(f'game_{c}.json')) for c in 'LR'}

# ---------- 1. people on the court: they move; people on the bench or watching mostly stand still
def moving(t):
    b = np.array(list(t['boxes'].values()))
    cx = (b[:, 0] + b[:, 2]) / 2; foot = b[:, 3]; h = b[:, 3] - b[:, 1]
    return (np.ptp(cx) + np.ptp(foot)) / max(1, np.median(h)) > 0.8
tracks = [(c, t) for c in 'LR' for t in G[c]['tracks'] if t['lab'] is not None and t['n'] >= 10]
court = [(c, t) for c, t in tracks if moving(t)]
X = np.array([t['lab'] for _, t in court], np.float32); w = np.array([t['n'] for _, t in court], np.float32)
# colour distance: lightness counts half, the colour itself fully
Xs = X * np.array([0.5, 1, 1], np.float32)
crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.1)
best = None
for k in (2, 3):
    comp, lbl, cen = cv2.kmeans(np.repeat(Xs, np.maximum(1, (w / 10).astype(int)), 0), k, None, crit, 10, cv2.KMEANS_PP_CENTERS)
    print(f'k={k} compactness {comp:.0f}')
    if k == 3: best = cen
cen = best
lab_of = lambda c: c / np.array([0.5, 1, 1], np.float32)
def team_of(lab):
    d = np.linalg.norm(cen - np.array(lab, np.float32) * np.array([0.5, 1, 1], np.float32), axis=1)
    return int(np.argmin(d))
share = Counter(); nums = defaultdict(Counter); tracks_with = defaultdict(lambda: defaultdict(set))
for c, t in court:
    k = team_of(t['lab']); share[k] += t['n']
    good = Counter(r[1] for r in t['reads'] if r[2] >= 0.8)
    for n, m in good.items():
        nums[k][n] += m; tracks_with[k][n].add((c, t['id']))
print('\nshirt colour groups (people who move around):')
order = [k for k, _ in share.most_common()]
for k in order:
    L, a, b = lab_of(cen[k]); bgr = cv2.cvtColor(np.uint8([[[L, a, b]]]), cv2.COLOR_LAB2BGR)[0, 0]
    roster = [(n, m, len(tracks_with[k][n])) for n, m in nums[k].most_common() if len(tracks_with[k][n]) >= 2 and m >= 3]
    print(f"  group {k}: colour #{bgr[2]:02x}{bgr[1]:02x}{bgr[0]:02x} (Lab {L:.0f},{a:.0f},{b:.0f}), {share[k] / 10:.0f} person-seconds; numbers read (reads, tracks): {roster}")
    print(f"           also read once or on one track: {[n for n, m in nums[k].most_common() if not (len(tracks_with[k][n]) >= 2 and m >= 3)][:12]}")

# ---------- 2. shooter: the followed person holding the ball at the gather; links to tracks right before/after
def at(t, f):
    ks = [int(k) for k in t['boxes']]
    k = min(ks, key=lambda x: abs(x - f)); return k, t['boxes'][str(k)]
def pick(c, s):
    fps = G[c]['fps']; sc = G[c]['W'] / 768
    g = s['ball'][s['gather']]
    balls = [(round(bt * fps), bx * sc, by * sc) for bt, bx, by in s['ball'] if -0.25 <= bt - g[0] <= 0.3] or [(round(g[0] * fps), g[1] * sc, g[2] * sc)]
    score = {}
    for t in G[c]['tracks']:
        if t['f1'] < balls[0][0] - 2 or t['f0'] > balls[-1][0] + 2: continue
        for bf, bx, by in balls:
            k, (x0, y0, x1, y1) = at(t, bf)
            if abs(k - bf) > 1: continue
            h = y1 - y0; wd = x1 - x0
            if x0 - 0.3 * wd <= bx <= x1 + 0.3 * wd and y0 - 0.35 * h <= by <= y0 + 0.75 * h:
                score[t['id']] = score.get(t['id'], 0) + 1 - 0.5 * min(1, abs(bx - (x0 + x1) / 2) / wd)
    if not score: return None, 0
    tid = max(score, key=score.get)
    return next(t for t in G[c]['tracks'] if t['id'] == tid), sorted(score.values())[-2:]
def links(c, t, gap=1.5, back=True):
    """tracks of the same shirt colour that end (start) close in time and place to where this one starts (ends)"""
    fps = G[c]['fps']; out = []; cur = t; seen = {t['id']}
    for _ in range(4):
        f_edge = cur['f0'] if back else cur['f1']; b_edge = cur['boxes'][str(f_edge)]
        best = None
        for o in G[c]['tracks']:
            if o['id'] in seen or o['lab'] is None or cur['lab'] is None: continue
            if team_of(o['lab']) != team_of(cur['lab']): continue
            f_o = o['f1'] if back else o['f0']
            dt = (f_edge - f_o) / fps if back else (f_o - f_edge) / fps
            if not 0 <= dt <= gap: continue
            bo = o['boxes'][str(f_o)]; hgt = b_edge[3] - b_edge[1]
            d = math.hypot((bo[0] + bo[2] - b_edge[0] - b_edge[2]) / 2, (bo[3] - b_edge[3])) / max(1, hgt)
            if d > 1.0 + dt: continue
            if best is None or d < best[0]: best = (d, o)
        if not best: break
        cur = best[1]; seen.add(cur['id']); out.append(cur)
    return out
def number(reads):
    c = Counter()
    for r in reads:
        if r[2] >= 0.8: c[r[1]] += r[2]
    if not c: return None, 0
    (n, v), = c.most_common(1)
    second = c.most_common(2)[1][1] if len(c) > 1 else 0
    return (n, v) if v >= 1.5 and v >= 2 * second else (None, v)
res = defaultdict(list); hoop_team = defaultdict(Counter)
for s in shots:
    c = s['cam']; sid = f"{c}{s['k']}"; gt = s['shooter']
    t, sc_ = pick(c, s)
    if t is None:
        res['no shooter' if gt else 'no shooter (unlabelled)'].append(sid); print(f'{sid:4} label {gt or "-":>2}: no person at the ball'); continue
    team = team_of(t['lab']) if t['lab'] else None
    hoop_team[c][team] += 1
    n1, v1 = number(t['reads'])
    chain = links(c, t, back=True) + links(c, t, back=False)
    n2, v2 = number(t['reads'] + [r for o in chain for r in o['reads']])
    n = n1 or n2
    how = 'own track' if n1 else 'linked tracks' if n2 else ''
    kind = ('right' if n == gt else 'wrong' if n else 'none') if gt else ('number given (unlabelled)' if n else 'none (unlabelled)')
    res[kind].append(sid + ('' if sid in SURE or not gt else '?') + (f':{n}' if not gt and n else ''))
    print(f"{sid:4} label {gt or '-':>2} -> {n or '-':>2} {how:13} team group {team}  track {t['n'] / 10:.1f}s +{len(chain)} linked  reads {Counter(r[1] for r in t['reads'] if r[2] >= .8).most_common(3)}")
print()
for k, v in res.items(): print(f'{k:26} {len(v):2}  {" ".join(v)}')
print('\nshooter shirt-colour group per hoop:', {c: dict(v) for c, v in hoop_team.items()})
