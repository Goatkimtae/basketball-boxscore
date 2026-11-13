"""Tests that need no video: box score, team rule, team side mapping, shot grouping, exports."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hoopstat import engine, export, project, stats  # noqa: E402


def ev(t, team, typ, detail="", result="", player=""):
    return {"time": t, "team": team, "player": player, "type": typ, "detail": detail, "result": result, "source": "수동", "confidence": "", "note": ""}


def test_team_free_throw_rule_and_totals():
    events = [
        ev(1, "A", "야투", "2점", "성공", "7"),
        ev(2, "A", "야투", "3점", "성공", "7"),
        ev(3, "A", "자유투", "2점슛 파울", "성공", "9"),      # 2 points (team rule: one FT)
        ev(4, "A", "자유투", "3점슛 파울", "성공", "9"),      # 3 points
        ev(5, "A", "자유투", "3점슛 파울", "실패", "9"),      # 0
        ev(6, "A", "자유투", "앤드원", "성공"),               # 1 point, player unknown
        ev(7, "B", "야투", "2점", "실패", "11"),
        ev(8, "A", "리바운드", "수비", "", "9"),
        ev(9, "B", "파울", "슈팅파울", "", "11"),
        ev(10, "B", "턴오버", "", "", "11"),
        ev(11, "A", "스틸", "", "", "7"),
        ev(12, "A", "어시스트", "", "", "9"),
    ]
    box = stats.box_score(events, ["A", "B"])
    a = dict(box["teams"])["A"]
    b = dict(box["teams"])["B"]
    assert a["PTS"] == 2 + 3 + 2 + 3 + 1
    assert (a["FGM"], a["FGA"], a["3PM"], a["3PA"], a["FTM"], a["FTA"]) == (2, 2, 1, 1, 3, 4)
    assert a["FT%"] == 75.0 and a["FG%"] == 100.0
    assert (a["DREB"], a["REB"], a["STL"], a["AST"]) == (1, 1, 1, 1)
    assert (b["PTS"], b["FGA"], b["PF"], b["TO"], b["FG%"]) == (0, 1, 1, 1, 0.0)
    players = dict(box["players"]["A"])
    assert list(players) == ["7", "9", "미상"]
    assert players["7"]["PTS"] == 5 and players["9"]["PTS"] == 5 and players["미상"]["PTS"] == 1
    assert sum(s["PTS"] for _, s in box["players"]["A"]) == a["PTS"]


def test_side_mapping_switches():
    s = {"team_left": "빨강", "team_right": "남색", "switch_time": 600}
    assert project.team_for("왼쪽", 10, s) == "빨강"
    assert project.team_for("오른쪽", 10, s) == "남색"
    assert project.team_for("왼쪽", 700, s) == "남색"
    assert project.team_for("오른쪽", 700, {"team_left": "빨강", "team_right": "남색"}) == "남색"


def _det(t, x, y, side="오른쪽"):
    # hoop centre (500, 120), scale 1 -> rim at y = 120 + 0.30 * 70 = 141
    return dict(t=t, side=side, fill=0.8, bx=x, by=y, bw=8, hx=500.0, hy=120.0, rim_y=141.0, w=84.0, hh=70.0)


def test_group_and_judge_made_vs_missed():
    made = [_det(1.0 + i * 0.033, 470 + i * 4, 100 + i * 2) for i in range(8)]          # arcs in above the rim
    made += [_det(1.30 + i * 0.033, 501, 140 + i * 10) for i in range(4)]               # drops through the middle
    missed = [_det(5.0 + i * 0.033, 440 + i * 6, 110 + i * 2) for i in range(8)]        # comes in
    missed += [_det(5.30 + i * 0.033, 560 + i * 8, 130 - i * 3) for i in range(5)]      # kicks out to the side
    passing = [_det(9.0 + i * 0.033, 700 + i * 2, 100) for i in range(6)]               # crosses far from the rim
    shots = engine.group_shots(sorted(made + missed + passing, key=lambda d: d["t"]))
    engine.judge_made(shots, made + missed + passing)
    assert [round(s.start, 1) for s in shots] == [1.0, 5.0]
    assert [s.made for s in shots] == [True, False]


def test_profile_roundtrip(tmp_path):
    frame = (np.random.default_rng(0).random((432, 768, 3)) * 255).astype(np.uint8)
    p = engine.GymProfile("테스트 체육관", {s: engine.GymProfile.template_from_click(frame, 300, 150) for s in engine.SIDES})
    folder = p.save(str(tmp_path))
    q = engine.GymProfile.load(folder)
    assert q.name == "테스트 체육관"
    assert set(q.templates) == set(engine.SIDES)
    assert q.templates["왼쪽"].shape == (engine.TH, engine.TW)
    assert np.array_equal(q.templates["왼쪽"], p.templates["왼쪽"])


def test_exports_and_work_file(tmp_path):
    settings = {"team_left": "빨강", "team_right": "남색", "video": "game.mp4", "duration": 92.6}
    events = [ev(7.0, "남색", "야투", "2점", "실패", "12"), ev(9.8, "남색", "리바운드", "공격", "", "1"),
              ev(71.2, "빨강", "야투", "2점", "성공", "33")]
    export.save_csv(events, str(tmp_path / "e.csv"))
    back = export.load_csv(str(tmp_path / "e.csv"))
    assert [e["time"] for e in back] == [7.0, 9.8, 71.2] and back[2]["result"] == "성공"
    export.save_xlsx(events, settings, str(tmp_path / "b.xlsx"))
    from openpyxl import load_workbook
    wb = load_workbook(str(tmp_path / "b.xlsx"))
    assert wb.sheetnames == ["박스스코어", "사건기록", "판정기준"]
    ws = wb["박스스코어"]
    assert ws["A5"].value == "빨강" and ws.cell(row=5, column=len(stats.COLS) + 1).value == 2
    export.save_html(events, settings, str(tmp_path / "b.html"))
    page = (tmp_path / "b.html").read_text(encoding="utf-8")
    assert "<title>빨강 vs 남색 박스스코어</title>" in page and "<script" not in page
    project.save(str(tmp_path / "w.hoopstat.json"), settings, events)
    s2, e2 = project.load(str(tmp_path / "w.hoopstat.json"))
    assert s2["team_left"] == "빨강" and len(e2) == 3


def test_reanalysis_keeps_manual_edits():
    old = [dict(ev(5, "A", "리바운드", "수비"), source="수동"), dict(ev(4, "A", "야투", "2점", "실패"), source="자동")]
    new = [dict(ev(4.1, "A", "야투", "2점", "성공"), source="자동")]
    merged = project.merge_reanalysis(old, new)
    assert [(e["time"], e["source"]) for e in merged] == [(4.1, "자동"), (5, "수동")]


def test_video_with_korean_file_name(tmp_path):
    import cv2
    ascii_file = tmp_path / "clip.avi"
    w = cv2.VideoWriter(str(ascii_file), cv2.VideoWriter_fourcc(*"MJPG"), 10, (320, 180))
    for i in range(20):
        frame = np.full((180, 320, 3), (i * 10) % 255, np.uint8)
        w.write(frame)
    w.release()
    korean = tmp_path / "우리 체육관 경기 영상.avi"
    os.replace(ascii_file, korean)
    v = engine.Video(str(korean))
    assert v.proc_size[0] == engine.PROC_W
    frames = list(v.iter(step=1))
    assert len(frames) == 20
    assert v.frame_at(1.0) is not None


def test_track_filter_drops_isolated_and_static_blobs():
    flight = [_det(1.0 + i / 30, 450 + i * 6, 100 + i * 3) for i in range(8)]      # moving ball
    static = [_det(1.0 + i / 30, 520, 141) for i in range(8)]                     # rim edge flicker, never moves
    lone = [_det(2.0, 600, 120)]                                                 # one-frame blob
    kept = engine.track_filter(flight + static + lone)
    assert sorted(d["bx"] for d in kept) == sorted(d["bx"] for d in flight)
