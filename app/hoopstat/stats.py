"""Events -> box score. An event is a dict:
{time, team, player, type, detail, result, source, confidence, note}
type:   야투 | 자유투 | 리바운드 | 어시스트 | 스틸 | 블록 | 턴오버 | 파울
detail: 야투 -> 2점/3점, 리바운드 -> 공격/수비, 자유투 -> a key of FT_POINTS
result: 성공/실패 for 야투 and 자유투, empty otherwise
"""
from __future__ import annotations

TYPES = ("야투", "자유투", "리바운드", "어시스트", "스틸", "블록", "턴오버", "파울")
DETAILS = {
    "야투": ("2점", "3점"),
    "자유투": ("2점슛 파울 1구", "3점슛 파울 1구", "3점슛 파울 2구", "앤드원", "기타"),
    "리바운드": ("공격", "수비"),
    "파울": ("개인파울", "슈팅파울", "공격자파울"),
}
RESULTS = ("성공", "실패")

# Team rule (user): 2-point shot foul -> one free throw worth 2; 3-point shot foul -> two free
# throws worth 2 and 1. And-one follows KBL 34.2.2 (one free throw, 1 point).
FT_POINTS = {"2점슛 파울 1구": 2, "3점슛 파울 1구": 2, "3점슛 파울 2구": 1, "앤드원": 1, "기타": 1}

COLS = ("FGM", "FGA", "FG%", "2PM", "2PA", "2P%", "3PM", "3PA", "3P%", "FTM", "FTA", "FT%",
        "OREB", "DREB", "REB", "AST", "STL", "BLK", "TO", "PF", "PTS")
KO = {"FGM": "야투 성공", "FGA": "야투 시도", "FG%": "야투 성공률", "2PM": "2점 성공", "2PA": "2점 시도", "2P%": "2점 성공률",
      "3PM": "3점 성공", "3PA": "3점 시도", "3P%": "3점 성공률", "FTM": "자유투 성공", "FTA": "자유투 시도", "FT%": "자유투 성공률",
      "OREB": "공격 리바운드", "DREB": "수비 리바운드", "REB": "리바운드", "AST": "어시스트", "STL": "스틸", "BLK": "블록",
      "TO": "턴오버", "PF": "파울", "PTS": "득점"}


def points(e: dict, ft_points: dict = FT_POINTS) -> int:
    if e.get("result") != "성공":
        return 0
    if e.get("type") == "야투":
        return 3 if e.get("detail") == "3점" else 2
    if e.get("type") == "자유투":
        return ft_points.get(e.get("detail"), 1)
    return 0


def _pct(m: int, a: int):
    return None if not a else round(m / a * 100, 1)


def tally(events: list[dict], ft_points: dict = FT_POINTS) -> dict:
    def c(test):
        return sum(1 for e in events if test(e))

    shot = lambda e: e.get("type") == "야투"
    made = lambda e: e.get("result") == "성공"
    s = {
        "FGM": c(lambda e: shot(e) and made(e)), "FGA": c(shot),
        "2PM": c(lambda e: shot(e) and e.get("detail") != "3점" and made(e)), "2PA": c(lambda e: shot(e) and e.get("detail") != "3점"),
        "3PM": c(lambda e: shot(e) and e.get("detail") == "3점" and made(e)), "3PA": c(lambda e: shot(e) and e.get("detail") == "3점"),
        "FTM": c(lambda e: e.get("type") == "자유투" and made(e)), "FTA": c(lambda e: e.get("type") == "자유투"),
        "OREB": c(lambda e: e.get("type") == "리바운드" and e.get("detail") == "공격"),
        "DREB": c(lambda e: e.get("type") == "리바운드" and e.get("detail") != "공격"),
        "AST": c(lambda e: e.get("type") == "어시스트"), "STL": c(lambda e: e.get("type") == "스틸"),
        "BLK": c(lambda e: e.get("type") == "블록"), "TO": c(lambda e: e.get("type") == "턴오버"),
        "PF": c(lambda e: e.get("type") == "파울"),
    }
    s["REB"] = s["OREB"] + s["DREB"]
    s["FG%"], s["2P%"], s["3P%"], s["FT%"] = _pct(s["FGM"], s["FGA"]), _pct(s["2PM"], s["2PA"]), _pct(s["3PM"], s["3PA"]), _pct(s["FTM"], s["FTA"])
    s["PTS"] = sum(points(e, ft_points) for e in events)
    return s


def _player_key(p: str):
    p = (p or "").strip() or "미상"
    return (1, 0, p) if not p.isdigit() else (0, int(p), p)


def box_score(events: list[dict], teams: list[str], ft_points: dict = FT_POINTS) -> dict:
    """{'teams': [(team, stats)], 'players': {team: [(player, stats)]}}"""
    names = list(teams) + sorted({e.get("team", "") for e in events} - set(teams) - {""})
    out = {"teams": [], "players": {}}
    for t in names:
        ev = [e for e in events if e.get("team") == t]
        out["teams"].append((t, tally(ev, ft_points)))
        players = sorted({(e.get("player") or "").strip() or "미상" for e in ev}, key=_player_key)
        out["players"][t] = [(p, tally([e for e in ev if ((e.get("player") or "").strip() or "미상") == p], ft_points)) for p in players]
    return out


def fmt(col: str, v) -> str:
    if v is None:
        return "–"
    return f"{v:.1f}" if col.endswith("%") else str(v)


def checks(events: list[dict]) -> list[str]:
    """Plain-language warnings shown next to the box score."""
    msgs = []
    missed = sum(1 for e in events if e.get("type") == "야투" and e.get("result") == "실패")
    reb = sum(1 for e in events if e.get("type") == "리바운드")
    if missed and reb == 0:
        msgs.append(f"실패한 야투 {missed}개에 리바운드 기록이 없습니다. 리바운드는 자동으로 찾지 않으니 '사건 추가'로 넣어 주세요.")
    elif missed != reb:
        msgs.append(f"실패한 야투 {missed}개, 리바운드 {reb}개입니다. 보통은 같아야 합니다(쿼터 종료 직전 등은 예외).")
    auto = [e for e in events if e.get("source") == "자동" and e.get("type") == "야투"]
    if auto:
        msgs.append(f"자동으로 찾은 야투 {len(auto)}개는 모두 2점으로 기록했습니다. 3점슛은 '수정'에서 바꿔 주세요.")
    return msgs
