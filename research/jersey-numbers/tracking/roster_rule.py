"""Team colours and numbers from the whole-game tracks, with the rules written out."""
import io, contextlib, sys, json, numpy as np, cv2
sys.argv = ['x']
with contextlib.redirect_stdout(io.StringIO()):
    import analyse_game as A
groups = []
for k in range(len(A.cen)):
    c = {n: (m, len(A.tracks_with[k][n])) for n, m in A.nums[k].items()}
    # a number counts when it was read on at least 5 different track pieces...
    keep = {n: v for n, v in c.items() if v[1] >= 5}
    # ...and is not one digit of a number of the same group read at least 5 times as often (a part of "33" read as "3")
    keep = {n: v for n, v in keep.items() if not (len(n) == 1 and any(n in o and o != n and w[0] >= 5 * v[0] for o, w in keep.items()))}
    L, a, b = A.lab_of(A.cen[k]); bgr = cv2.cvtColor(np.uint8([[[L, a, b]]]), cv2.COLOR_LAB2BGR)[0, 0]
    groups.append((sum(v[0] for v in keep.values()), k, f'#{bgr[2]:02x}{bgr[1]:02x}{bgr[0]:02x}', sorted(keep, key=lambda n: int(n)), keep))
groups.sort(reverse=True)
for i, (total, k, col, nums, keep) in enumerate(groups):
    print(('team' if i < 2 else 'not a team (fewest number reads)'), f'group {k} colour {col}: numbers {nums}  reads/tracks {keep}  total {total}')
team_of_group = {groups[0][1]: 'A', groups[1][1]: 'B'}
print('shooter colour group per hoop:', {c: dict(v) for c, v in A.hoop_team.items()})
for c, v in A.hoop_team.items():
    t = {team_of_group.get(g, '-'): 0 for g in v}
    for g, n in v.items(): t[team_of_group.get(g, '-')] = t.get(team_of_group.get(g, '-'), 0) + n
    print(f'  hoop {c}: shooters by team {t}')
