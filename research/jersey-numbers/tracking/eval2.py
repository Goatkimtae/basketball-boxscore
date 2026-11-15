"""Score the shooter-track numbers against the by-eye labels; also the shooter's team from shirt colour."""
import json, sys
NAVY, WHITE = {'11', '44', '28', '77', '16', '21'}, {'33', '13', '69', '9', '0', '3'}
SURE = {'L1', 'L5', 'L7', 'L16', 'R0', 'R1', 'R4', 'R5', 'R7', 'R14', 'R16'}
def decide(reads, gt_time, min_total=1.5):
    """number on the stretch of the track around the gather: reads grouped into runs of one number
    (a single stray read does not break a run); the run nearest the gather wins"""
    reads = sorted(r for r in reads if r[2] >= 0.8)
    if not reads: return None, 0
    runs = []
    for t, n, c, h in reads:
        if runs and runs[-1]['n'] == n: runs[-1]['t1'] = t; runs[-1]['sum'] += c; runs[-1]['k'] += 1
        else: runs.append(dict(n=n, t0=t, t1=t, sum=c, k=1))
    # merge runs separated by a single stray read
    merged = []
    for r in runs:
        if len(merged) >= 2 and merged[-1]['k'] == 1 and merged[-2]['n'] == r['n']:
            stray = merged.pop(); m = merged[-1]; m['t1'] = r['t1']; m['sum'] += r['sum']; m['k'] += r['k']
        elif merged and merged[-1]['n'] == r['n']:
            m = merged[-1]; m['t1'] = r['t1']; m['sum'] += r['sum']; m['k'] += r['k']
        else: merged.append(dict(r))
    good = [r for r in merged if r['sum'] >= min_total]
    if not good: return None, 0
    dist = lambda r: 0 if r['t0'] <= gt_time <= r['t1'] else min(abs(gt_time - r['t0']), abs(gt_time - r['t1']))
    best = min(good, key=lambda r: (dist(r), -r['sum']))
    return best['n'], round(dist(best), 1)
shots = {f"{s['cam']}{s['k']}": s for s in json.load(open('/home/user/basketball-boxscore/research/jersey-numbers/data/shots.json'))['shots']}
tag = sys.argv[1] if len(sys.argv) > 1 else 'shooter2'
res = {'right': [], 'wrong': [], 'none': [], 'extra': []}; team_ok = team_bad = team_none = 0
for cam in 'LR':
    for r in json.load(open(f'{tag}_{cam}.json')):
        sid = f"{cam}{r['k']}"; s = shots[sid]; gt = s['shooter']
        g_t = s['ball'][s['gather']][0]
        n, d = decide(r['reads'], g_t)
        L = r.get('lab', [None])[0] if r.get('lab') else None
        team = None if L is None else ('white' if L > 120 else 'navy')
        if gt:
            gteam = 'navy' if gt in NAVY else 'white' if gt in WHITE else None
            if team and gteam: team_ok += team == gteam; team_bad += team != gteam
            else: team_none += 1
            res['right' if n == gt else 'wrong' if n else 'none'].append(sid + ('' if sid in SURE else '?'))
        elif n: res['extra'].append(f'{sid}:{n}')
        print(f"{sid:4} label {gt or '-':>2} {'sure' if sid in SURE else '    '} -> {n or '-':>2} (run {d}s from gather)  shirt L {L}  team {team}  reads {len(r['reads'])}")
for k, v in res.items(): print(k, len(v), ' '.join(v))
print('team from shirt colour on labelled shots: right', team_ok, 'wrong', team_bad, 'no shooter found', team_none)
