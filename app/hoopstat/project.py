"""Turning detected shots into events, and saving/loading a work file."""
from __future__ import annotations

import json

VERSION = 1


def team_for(side: str, t: float, settings: dict) -> str:
    """Team attacking `side` (왼쪽/오른쪽) at time t. Directions swap at settings['switch_time']."""
    left, right = settings.get("team_left") or "팀 A", settings.get("team_right") or "팀 B"
    sw = settings.get("switch_time")
    swapped = sw not in (None, "") and t >= float(sw)
    if side == "왼쪽":
        return right if swapped else left
    return left if swapped else right


def shots_to_events(shots, settings: dict) -> list[dict]:
    out = []
    for s in shots:
        note = "공이 림 높이에 처음 보인 시각(슛을 던진 순간보다 0.3~1초 늦음)"
        if s.made and s.made_t is not None:
            note += f". 성공 근거: {s.made_t:.1f}초에 공이 림 가운데 아래로 지나감"
        out.append({
            "time": round(float(s.start), 1), "team": team_for(s.side, s.start, settings), "player": "",
            "type": "야투", "detail": "2점", "result": "성공" if s.made else "실패",
            "source": "자동", "confidence": s.confidence, "note": note, "side": s.side,
        })
    return out


def merge_reanalysis(old: list[dict], new_auto: list[dict]) -> list[dict]:
    """Keep everything a person added or edited, replace the untouched automatic events."""
    kept = [e for e in old if e.get("source") != "자동"]
    return sorted(kept + new_auto, key=lambda e: e.get("time", 0))


def save(path: str, settings: dict, events: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"app": "HoopStat", "version": VERSION, "settings": settings, "events": events}, fh, ensure_ascii=False, indent=1)


def load(path: str) -> tuple[dict, list[dict]]:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    if d.get("app") != "HoopStat":
        raise ValueError("HoopStat 작업 파일이 아닙니다.")
    return d.get("settings", {}), d.get("events", [])
