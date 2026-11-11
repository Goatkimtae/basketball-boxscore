"""Save events and box score as CSV, Excel and a single-file web page."""
from __future__ import annotations

import csv
import html
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from .stats import COLS, KO, box_score, checks, fmt, points

EVENT_FIELDS = ("time", "team", "player", "type", "detail", "result", "source", "confidence", "note")
EVENT_KO = ("시각(초)", "팀", "등번호", "기록", "세부", "결과", "출처", "신뢰도", "비고")
COLORS = {"빨강": "#d7263d", "남색": "#1f2a55", "파랑": "#1f6fd1", "검정": "#222222", "흰색": "#f4f4f4",
          "노랑": "#f2c230", "초록": "#2e9e5b", "주황": "#f08a24", "보라": "#7a4cc2", "회색": "#8a8f99"}


def _teams(settings: dict) -> list[str]:
    return [settings.get("team_left") or "팀 A", settings.get("team_right") or "팀 B"]


def save_csv(events: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(EVENT_KO)
        for e in sorted(events, key=lambda e: e.get("time", 0)):
            w.writerow([f"{float(e.get('time', 0)):.1f}"] + [e.get(k, "") for k in EVENT_FIELDS[1:]])


def load_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    out = []
    for r in rows[1:]:
        if not r:
            continue
        e = dict(zip(EVENT_FIELDS, r + [""] * (len(EVENT_FIELDS) - len(r))))
        e["time"] = float(e["time"] or 0)
        out.append(e)
    return out


# ------------------------------------------------------------------ Excel
def save_xlsx(events: list[dict], settings: dict, path: str) -> None:
    teams = _teams(settings)
    box = box_score(events, teams)
    F = "Arial"
    hdr = PatternFill("solid", fgColor="1F3864")
    thin = Side(style="thin", color="BFBFBF")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    def head(ws, row, labels):
        for i, v in enumerate(labels, 1):
            c = ws.cell(row=row, column=i, value=v)
            c.font, c.fill, c.alignment, c.border = Font(name=F, bold=True, color="FFFFFF"), hdr, center, border

    def stat_row(ws, row, first, s):
        c = ws.cell(row=row, column=1, value=first)
        c.font, c.border = Font(name=F, bold=True), border
        for i, k in enumerate(COLS, 2):
            v = s[k]
            c = ws.cell(row=row, column=i, value=(None if v is None else (v / 100 if k.endswith("%") else v)))
            c.font, c.border, c.alignment = Font(name=F, bold=(k == "PTS")), border, center
            if k.endswith("%"):
                c.number_format = "0.0%"

    wb = Workbook()
    ws = wb.active
    ws.title = "박스스코어"
    ws["A1"] = settings.get("title") or f"{teams[0]} vs {teams[1]} 박스스코어"
    ws["A1"].font = Font(name=F, bold=True, size=14)
    ws["A2"] = f"영상: {os.path.basename(settings.get('video', ''))} · 자동 분석 + 사람 검토 · 출전시간과 +/-는 계산하지 않음"
    ws["A2"].font = Font(name=F, size=10, color="595959")
    head(ws, 4, ["팀"] + [f"{k}\n{KO.get(k, '')}" for k in COLS])
    ws.row_dimensions[4].height = 42
    r = 5
    for t, s in box["teams"]:
        stat_row(ws, r, t, s)
        r += 1
    r += 1
    for t, players in box["players"].items():
        ws.cell(row=r, column=1, value=f"{t} 선수별").font = Font(name=F, bold=True, size=12)
        r += 1
        head(ws, r, ["등번호"] + list(COLS))
        r += 1
        for p, s in players:
            stat_row(ws, r, p, s)
            r += 1
        r += 1
    for i, msg in enumerate(checks(events)):
        ws.cell(row=r + i, column=1, value="※ " + msg).font = Font(name=F, size=10, color="9C5700")
    ws.column_dimensions["A"].width = 12
    for i in range(2, len(COLS) + 2):
        ws.column_dimensions[ws.cell(row=4, column=i).column_letter].width = 9
    ws.freeze_panes = "B5"

    we = wb.create_sheet("사건기록")
    head(we, 1, list(EVENT_KO) + ["득점"])
    for i, e in enumerate(sorted(events, key=lambda e: e.get("time", 0)), 2):
        vals = [round(float(e.get("time", 0)), 1)] + [e.get(k, "") for k in EVENT_FIELDS[1:]] + [points(e) if e.get("type") in ("야투", "자유투") else None]
        for j, v in enumerate(vals, 1):
            c = we.cell(row=i, column=j, value=v)
            c.font, c.border = Font(name=F, color="0000FF" if e.get("source") == "자동" else "000000"), border
    for col, w in zip("ABCDEFGHIJ", (9, 10, 8, 10, 14, 8, 8, 8, 50, 7)):
        we.column_dimensions[col].width = w
    we.freeze_panes = "A2"

    wr = wb.create_sheet("판정기준")
    rules = [
        ("자동 기록", "야투 시도와 성공/실패만 자동입니다. 공이 림 위에서 림 가운데 아래로 0.6초 안에 지나가면 성공, 아니면 실패로 봅니다. 자동 기록은 파란 글씨입니다."),
        ("팀", "골대 방향으로 정합니다. 왼쪽 골대 공격 = " + teams[0] + ", 오른쪽 골대 공격 = " + teams[1]
         + (f" (영상 {settings.get('switch_time')}초부터 서로 바뀜)" if settings.get("switch_time") else "")),
        ("2점·3점", "자동 기록은 모두 2점입니다. 3점 라인은 영상으로 판정하지 않습니다."),
        ("자유투(팀 규칙)", "2점슛 시도 중 파울은 자유투 1개(성공 시 2점), 3점슛 시도 중 파울은 2개(첫 번째 2점, 두 번째 1점). 앤드원은 1개·1점."),
        ("사람이 넣는 기록", "리바운드, 어시스트, 스틸, 블록, 턴오버, 파울, 자유투, 등번호는 앱의 '사건 추가·수정'으로 넣습니다."),
        ("기준 문서", "2026-2027 KBL 경기규칙(득점·파울), FIBA 기록원 매뉴얼 2016(리바운드·어시스트 등 기록 정의)."),
    ]
    head(wr, 1, ["항목", "내용"])
    for i, (a, b) in enumerate(rules, 2):
        wr.cell(row=i, column=1, value=a).font = Font(name=F, bold=True)
        c = wr.cell(row=i, column=2, value=b)
        c.font, c.alignment = Font(name=F), Alignment(wrap_text=True, vertical="top")
    wr.column_dimensions["A"].width = 16
    wr.column_dimensions["B"].width = 100
    wb.save(path)


# ------------------------------------------------------------------ web page
def save_html(events: list[dict], settings: dict, path: str) -> None:
    teams = _teams(settings)
    box = box_score(events, teams)
    T = dict(box["teams"])
    esc = html.escape
    color = {teams[0]: COLORS.get(settings.get("color_left", "빨강"), "#d7263d"),
             teams[1]: COLORS.get(settings.get("color_right", "남색"), "#1f2a55")}
    title = settings.get("title") or f"{teams[0]} vs {teams[1]} 박스스코어"
    dur = settings.get("duration") or 0

    def chip(t):
        return f"<span class='chip' style='background:{color.get(t, '#8a8f99')}'></span>"

    def cells(s):
        return "".join(f'<td class="{"pts" if k == "PTS" else ("z" if s[k] == 0 else "")}">{fmt(k, s[k])}</td>' for k in COLS)

    def head(first, ko=True):
        return "<tr><th class='l'>" + first + "</th>" + "".join(
            f"<th>{k}{'<small>' + KO[k] + '</small>' if ko and k in KO and not k.endswith('%') else ''}</th>" for k in COLS) + "</tr>"

    team_rows = "".join(f"<tr><td class='l'>{chip(t)}{esc(t)}</td>{cells(s)}</tr>" for t, s in box["teams"])
    players = "".join(
        f"<h3>{chip(t)}{esc(t)}</h3><div class='scroll'><table><thead>{head('등번호', False)}</thead><tbody>"
        + "".join(f"<tr><td class='l'>{esc(p)}</td>{cells(s)}</tr>" for p, s in ps) + "</tbody></table></div>"
        for t, ps in box["players"].items())
    pbp = "".join(
        f"<tr><td>{float(e.get('time', 0)):.1f}</td>" + "".join(f"<td class='l'>{esc(str(e.get(k, '')))}</td>" for k in ("team", "player", "type", "detail", "result", "source"))
        + f"<td class='why'>{esc(str(e.get('note', '')))}</td></tr>" for e in sorted(events, key=lambda e: e.get("time", 0)))
    notes = "".join(f"<li>{esc(m)}</li>" for m in checks(events))
    a, b = teams
    sa, sb = T.get(a), T.get(b)
    side_txt = f"왼쪽 골대: {esc(a)} 공격<br>오른쪽 골대: {esc(b)} 공격"
    if settings.get("switch_time"):
        side_txt += f"<br>{esc(str(settings['switch_time']))}초부터 방향 교대"
    page = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
:root {{ --bg:#fbfbfd; --panel:#f1f3f8; --fg:#1b1e27; --muted:#5d6475; --line:#dde1ea; color-scheme: light; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#14161c; --panel:#1d2029; --fg:#eceef3; --muted:#a3a9b8; --line:#2e3340; color-scheme: dark; }} }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; font-size:15px; line-height:1.5; }}
main {{ max-width:1100px; margin:0 auto; padding-block:28px 48px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); display:grid; gap:28px; }}
main > * {{ min-width:0; }}
.eyebrow {{ margin:0; color:var(--muted); font-size:13px; }}
h1 {{ margin:4px 0 0; font-size:clamp(1.5rem, 4vw, 2rem); font-weight:600; text-wrap:balance; }}
.score {{ display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }}
.team {{ display:grid; gap:4px; }} .team.r {{ justify-items:end; text-align:right; }}
.tname {{ display:flex; align-items:center; gap:6px; font-weight:600; }}
.big {{ font-size:clamp(2.6rem, 10vw, 4rem); line-height:1; font-variant-numeric:tabular-nums; font-weight:500; }}
.sub, .vs {{ color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }} .vs {{ text-align:center; }}
.chip {{ display:inline-block; width:.85em; height:.85em; border-radius:3px; border:1px solid var(--line); margin-right:6px; vertical-align:-1px; }}
h2 {{ margin:0 0 6px; font-size:1.15rem; }} h3 {{ margin:14px 0 6px; font-size:1rem; }}
.note {{ margin:0 0 8px; color:var(--muted); font-size:13px; max-width:75ch; }}
.scroll {{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; }}
table {{ border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }}
th, td {{ padding:8px 10px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--line); }}
thead th {{ background:var(--panel); color:var(--muted); font-size:12px; font-weight:600; vertical-align:bottom; }}
thead th small {{ display:block; font-weight:400; font-size:11px; }}
tbody tr:last-child td {{ border-bottom:0; }}
.l {{ text-align:left; }} td.pts {{ font-weight:700; }} td.z {{ color:var(--muted); }}
th:first-child, td:first-child {{ position:sticky; left:0; background:var(--bg); }} thead th:first-child {{ background:var(--panel); }}
td.why {{ white-space:normal; min-width:16rem; text-align:left; color:var(--muted); font-size:13px; }}
ul {{ margin:0; padding-left:1.2em; color:var(--muted); font-size:13px; }}
footer {{ color:var(--muted); font-size:12px; }}
</style></head><body><main>
<header><p class="eyebrow">영상 자동 분석 + 사람 검토{f' · 영상 {dur:.0f}초' if dur else ''}</p><h1>{esc(title)}</h1></header>
<section class="score" aria-label="점수판">
 <div class="team"><span class="tname">{chip(a)}{esc(a)}</span><span class="big">{sa['PTS'] if sa else 0}</span>
  <span class="sub">야투 {sa['FGM'] if sa else 0}/{sa['FGA'] if sa else 0} · 리바운드 {sa['REB'] if sa else 0} · 어시스트 {sa['AST'] if sa else 0}</span></div>
 <div class="vs">{side_txt}</div>
 <div class="team r"><span class="tname">{esc(b)}{chip(b)}</span><span class="big">{sb['PTS'] if sb else 0}</span>
  <span class="sub">야투 {sb['FGM'] if sb else 0}/{sb['FGA'] if sb else 0} · 리바운드 {sb['REB'] if sb else 0} · 어시스트 {sb['AST'] if sb else 0}</span></div>
</section>
<section><h2>팀 합계</h2><p class="note">출전시간(MIN)과 +/-는 교체 기록이 없어 계산하지 않았습니다.</p>
<div class="scroll"><table><thead>{head('팀')}</thead><tbody>{team_rows}</tbody></table></div>
{f'<ul>{notes}</ul>' if notes else ''}</section>
<section><h2>선수별 기록</h2><p class="note">등번호를 모르는 기록은 '미상'으로 묶었습니다.</p>{players}</section>
<section><h2>사건 기록</h2><p class="note">시각은 영상 시작부터 센 초입니다. 출처 '자동'은 앱이 찾은 기록, '수동'은 사람이 넣거나 고친 기록입니다.</p>
<div class="scroll"><table><thead><tr><th>시각(초)</th><th class="l">팀</th><th class="l">등번호</th><th class="l">기록</th><th class="l">세부</th><th class="l">결과</th><th class="l">출처</th><th class="l">비고</th></tr></thead><tbody>{pbp}</tbody></table></div></section>
<footer>HoopStat으로 만든 기록 · 이 파일 하나로 열립니다.</footer>
</main></body></html>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(page)
