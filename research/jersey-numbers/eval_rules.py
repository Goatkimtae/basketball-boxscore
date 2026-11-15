"""Which number near the ball is the shooter's? Rules scored against the by-eye labels in data/shots.json.

    python eval_rules.py            # needs nothing but the data file

Coordinates are pixels of a 768-px-wide frame; R is the rim width there (22 px = 0.45 m at the hoop)."""
import json, math, os

R = 22.0
SHOTS = json.load(open(os.path.join(os.path.dirname(__file__), 'data', 'shots.json'), encoding='utf-8'))['shots']


def ball_at(ball, t, tol=0.07):
    p = min(ball, key=lambda q: abs(q[0] - t))
    return p if abs(p[0] - t) <= tol else None


def decide(shot, P):
    """-> (number the rule would fill in or None, up to three candidates near the ball)"""
    ball, g = shot['ball'], shot['ball'][shot['gather']]
    tight, loose, seen = {}, {}, {}
    for f in shot['frames']:
        dt = f['t'] - g[0]
        if not P['t0'] - 0.05 <= dt <= P['t1'] + 0.05:
            continue
        b = ball_at(ball, f['t'])
        if not b:
            continue
        for text, conf, x, y, w, h in f['boxes']:
            if h < P['min_h']:
                continue
            dx, dy = x - b[1], y - b[2]                      # dy > 0: the number is below the ball
            if abs(dx) <= 3 * R and -3 * R <= dy <= 5 * R:
                loose[text] = loose.get(text, 0) + conf * math.exp(-(dx / (1.5 * R)) ** 2)
            unit = h if P['unit'] == 'h' else R              # 'h': distances in number heights, so they scale with how far the player is
            if abs(dx) <= P['dx'] * unit and -P['up'] * unit <= dy <= P['dn'] * unit:
                tight[text] = tight.get(text, 0) + conf * (1 - 0.5 * abs(dx) / (P['dx'] * unit))
                seen.setdefault(text, set()).add(f['t'])
    rank = sorted(tight.items(), key=lambda kv: -kv[1])
    pick = None
    if rank and len(seen[rank[0][0]]) >= P['min_frames'] and (len(rank) < 2 or rank[0][1] >= P['dominance'] * rank[1][1]):
        pick = rank[0][0]
    return pick, [n for n, _ in sorted(loose.items(), key=lambda kv: -kv[1])][:3]


def run(P, show=False):
    right = wrong = top3 = known = 0
    for s in SHOTS:
        pick, cands = decide(s, P)
        gt = s['shooter']
        if gt:
            known += 1
            top3 += gt in cands
        if pick:
            right += pick == gt
            wrong += pick != gt
        if show:
            print(f"{s['cam']}{s['k']:<2} {s['start']:6.1f}s  by eye {gt or '-':>2}  rule {pick or '-':>2} {'right' if pick and pick == gt else 'WRONG' if pick else '':5}  near the ball {cands}")
    return right, wrong, top3, known


# ball at chest/hip height next to the number: the two are then almost certainly the same player
TORSO = dict(unit='h', dx=2.0, up=2.5, dn=1.5, t0=-0.3, t1=0.3, min_frames=2, dominance=2.0, min_h=6)
# any number under or beside the ball, also when the ball is above the head
NEAR = dict(TORSO, unit='R', dx=1.2, up=1.5, dn=3.5)

if __name__ == '__main__':
    r = run(TORSO, show=True)
    print(f"\n{len(SHOTS)} shots, shooter's number readable by eye in {r[3]}")
    for name, P in (('ball at chest/hip height next to the number', TORSO), ('  same, ball at most one number-height above', dict(TORSO, dn=1.0)),
                    ('any number under or beside the ball', NEAR)):
        right, wrong, top3, known = run(P)
        print(f'{name}: filled in {right + wrong} -> {right} right, {wrong} wrong')
    print(f"true number among the three nearest candidates: {r[2]} of {r[3]}")
