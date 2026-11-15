"""Compare Claude's answers with the by-eye labels in research/jersey-numbers/data/shots.json.
    python score.py answers_<model>_<effort>.json"""
import json, os, sys
GT = {f"{s['cam']}{s['k']}": (s['shooter'], s['sure']) for s in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'shots.json'), encoding='utf-8'))['shots']}
ans = json.load(open(sys.argv[1]))
rows, tally = [], {}
for sid, (gt, sure) in GT.items():
    a = ans.get(sid)
    if not a: continue
    n = (a.get('number') or '').strip()
    c = a.get('certainty', '-')
    if gt:
        kind = 'right' if n == gt else 'wrong' if n else 'blank'
    else:
        kind = 'number where I saw none' if n else 'blank (agrees)'
    for lvl in ('high', 'medium', 'low'):
        if n and c == lvl or not n:
            pass
    tally.setdefault((kind, c if n else '-'), []).append(sid)
    rows.append(f"{sid:4} label {gt or '-':>2}{'' if sure or not gt else '?'}  claude {n or '-':>2} ({c:6}) {kind:24} {a.get('note', '')[:90]}")
print('\n'.join(rows))
print()
for (kind, c), ids in sorted(tally.items()):
    print(f'{kind:24} certainty {c:6}: {len(ids):2}  {" ".join(ids)}')
known = sum(1 for g, _ in GT.values() if g)
for need in (('high',), ('high', 'medium'), ('high', 'medium', 'low')):
    right = sum(1 for sid, (g, _) in GT.items() if sid in ans and g and (ans[sid].get('number') or '') == g and ans[sid].get('certainty') in need)
    filled = sum(1 for sid in GT if sid in ans and (ans[sid].get('number') or '') and ans[sid].get('certainty') in need)
    print(f"fill in when certainty is {'/'.join(need):16}: {filled:2} filled, {right:2} right (of {known} shots with a readable number), {filled - right:2} wrong or unverifiable")
cost = sum(a.get('tokens_in', 0) for a in ans.values()), sum(a.get('tokens_out', 0) for a in ans.values())
print('tokens in/out', cost, 'avg secs', round(sum(a.get('secs', 0) for a in ans.values()) / max(1, len(ans)), 1))
