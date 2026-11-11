"""Command line: make a gym profile from two rim clicks, or analyse a video without the window.

  python -m hoopstat.cli profile VIDEO --left T,X,Y --right T,X,Y --name NAME [--dir DIR]
  python -m hoopstat.cli analyze VIDEO --profile DIR [--left-team A] [--right-team B] [--switch S] [--out DIR]

X, Y are pixel positions of the rim centre in the frame resized to 768 px wide.
"""
from __future__ import annotations

import argparse
import os
import sys

from . import engine, export, project


def _txy(s: str):
    t, x, y = (float(v) for v in s.split(","))
    return t, x, y


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="hoopstat")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("profile")
    p.add_argument("video")
    p.add_argument("--left", required=True, type=_txy)
    p.add_argument("--right", required=True, type=_txy)
    p.add_argument("--name", required=True)
    p.add_argument("--dir", default=".")
    a = sub.add_parser("analyze")
    a.add_argument("video")
    a.add_argument("--profile", required=True)
    a.add_argument("--left-team", default="팀 A")
    a.add_argument("--right-team", default="팀 B")
    a.add_argument("--switch", type=float, default=None)
    a.add_argument("--out", default=".")
    args = ap.parse_args(argv)

    if args.cmd == "profile":
        v = engine.Video(args.video)
        prof = engine.GymProfile(args.name)
        for side, (t, x, y) in (("왼쪽", args.left), ("오른쪽", args.right)):
            f = v.frame_at(t)
            if f is None:
                print(f"{t}초 장면을 읽지 못했습니다.", file=sys.stderr)
                return 1
            prof.templates[side] = engine.GymProfile.template_from_click(f, x, y)
        print(prof.save(args.dir))
        return 0

    prof = engine.GymProfile.load(args.profile)
    last = [-1.0]

    def prog(label, frac):
        if frac - last[0] >= 0.1 or frac >= 1:
            print(f"{label} {frac:.0%}", file=sys.stderr)
            last[0] = frac

    res = engine.analyze(args.video, prof, prog)
    settings = {"video": args.video, "team_left": args.left_team, "team_right": args.right_team,
                "switch_time": args.switch, "duration": res["duration"]}
    events = project.shots_to_events(res["shots"], settings)
    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, os.path.splitext(os.path.basename(args.video))[0])
    export.save_csv(events, base + "_기록.csv")
    export.save_xlsx(events, settings, base + "_박스스코어.xlsx")
    export.save_html(events, settings, base + "_박스스코어.html")
    project.save(base + ".hoopstat.json", settings, events)
    for e in events:
        print(f"{e['time']:6.1f}s {e['team']:>6s} {e['type']} {e['result']} ({e['confidence']})")
    print(f"야투 {len(events)}개, 성공 {sum(e['result'] == '성공' for e in events)}개 -> {base}_*")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
