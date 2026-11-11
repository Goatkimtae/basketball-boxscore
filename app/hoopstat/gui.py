"""HoopStat desktop window (Tkinter)."""
from __future__ import annotations

import os
import queue
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

import cv2
from PIL import Image, ImageTk

from . import __version__, engine, export, project, stats

APP = "HoopStat"
TEAM_COLORS = tuple(export.COLORS)


def data_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    d = os.path.join(base, APP)
    os.makedirs(os.path.join(d, "profiles"), exist_ok=True)
    return d


def profiles_dir() -> str:
    return os.path.join(data_dir(), "profiles")


def list_profiles() -> list[str]:
    d = profiles_dir()
    return sorted(n for n in os.listdir(d) if os.path.exists(os.path.join(d, n, "profile.json")))


def to_photo(frame_bgr, width: int) -> ImageTk.PhotoImage:
    h, w = frame_bgr.shape[:2]
    img = Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    if w != width:
        img = img.resize((width, int(round(h * width / w))), Image.LANCZOS)
    return ImageTk.PhotoImage(img)


# ====================================================================== gym profile
class ProfileDialog(tk.Toplevel):
    """Find a frame where each hoop is visible and click the middle of its rim."""

    def __init__(self, master, video_path: str, on_saved):
        super().__init__(master)
        self.title("체육관 설정: 양쪽 골대 표시")
        self.transient(master)
        self.on_saved = on_saved
        self.video = engine.Video(video_path)
        self.frame = None
        self.photo = None
        self.marks: dict[str, tuple] = {}
        self.thumbs: dict[str, ImageTk.PhotoImage] = {}
        self.t = tk.DoubleVar(value=0.0)
        self.side = tk.StringVar(value="왼쪽")
        self.name = tk.StringVar(value="우리 체육관")
        self._pending = None

        ttk.Label(self, text="1) 아래 막대로 왼쪽 골대가 보이는 장면을 찾고, 림(빨간 고리) 한가운데를 누르세요.\n"
                             "2) '오른쪽 골대'를 고르고 같은 방법으로 오른쪽 골대 림을 누르세요.\n"
                             "3) 이름을 정하고 저장하면, 같은 체육관 영상은 다음부터 바로 분석합니다.",
                  justify="left").pack(anchor="w", padx=10, pady=(10, 4))
        w, h = self.video.proc_size
        self.canvas = tk.Canvas(self, width=w, height=h, bg="#222", highlightthickness=0, cursor="crosshair")
        self.canvas.pack(padx=10)
        self.canvas.bind("<Button-1>", self.on_click)

        nav = ttk.Frame(self)
        nav.pack(fill="x", padx=10, pady=6)
        for label, d in (("◀ 5초", -5), ("◀ 0.5초", -0.5)):
            ttk.Button(nav, text=label, command=lambda d=d: self.jump(d)).pack(side="left")
        self.scale = ttk.Scale(nav, from_=0, to=max(1.0, self.video.duration), variable=self.t, command=lambda _v: self.schedule())
        self.scale.pack(side="left", fill="x", expand=True, padx=6)
        for label, d in (("0.5초 ▶", 0.5), ("5초 ▶", 5)):
            ttk.Button(nav, text=label, command=lambda d=d: self.jump(d)).pack(side="left")
        self.tlabel = ttk.Label(nav, text="0.0초", width=8)
        self.tlabel.pack(side="left", padx=(6, 0))

        row = ttk.Frame(self)
        row.pack(fill="x", padx=10, pady=4)
        ttk.Label(row, text="지금 표시할 골대:").pack(side="left")
        for s in engine.SIDES:
            ttk.Radiobutton(row, text=f"{s} 골대", value=s, variable=self.side).pack(side="left", padx=4)
        self.thumb_frame = ttk.Frame(row)
        self.thumb_frame.pack(side="right")
        self.thumb_labels = {}
        for s in engine.SIDES:
            f = ttk.Frame(self.thumb_frame)
            f.pack(side="left", padx=6)
            ttk.Label(f, text=s).pack()
            lb = ttk.Label(f, text="(아직 없음)")
            lb.pack()
            self.thumb_labels[s] = lb

        bottom = ttk.Frame(self)
        bottom.pack(fill="x", padx=10, pady=(4, 10))
        ttk.Label(bottom, text="체육관 이름:").pack(side="left")
        ttk.Entry(bottom, textvariable=self.name, width=24).pack(side="left", padx=4)
        self.save_btn = ttk.Button(bottom, text="저장", command=self.save, state="disabled")
        self.save_btn.pack(side="right")
        self.show()
        self.grab_set()

    def jump(self, d):
        self.t.set(min(max(0.0, self.t.get() + d), self.video.duration))
        self.show()

    def schedule(self):
        if self._pending:
            self.after_cancel(self._pending)
        self._pending = self.after(120, self.show)

    def show(self):
        self._pending = None
        t = self.t.get()
        f = self.video.frame_at(t)
        if f is None:
            return
        self.frame = f
        self.photo = to_photo(f, f.shape[1])
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
        for s, (mt, x, y, _) in self.marks.items():
            if abs(mt - t) < 0.05:
                self.canvas.create_oval(x - 9, y - 5, x + 9, y + 5, outline="#00e5ff", width=2)
                self.canvas.create_text(x, y - 14, text=s, fill="#00e5ff")
        self.tlabel.config(text=f"{t:.1f}초")

    def on_click(self, ev):
        if self.frame is None:
            return
        side = self.side.get()
        tpl = engine.GymProfile.template_from_click(self.frame, ev.x, ev.y)
        self.marks[side] = (self.t.get(), ev.x, ev.y, tpl)
        self.thumbs[side] = ImageTk.PhotoImage(Image.fromarray(tpl).resize((tpl.shape[1] * 2, tpl.shape[0] * 2)))
        self.thumb_labels[side].config(image=self.thumbs[side], text="")
        if side == "왼쪽" and "오른쪽" not in self.marks:
            self.side.set("오른쪽")
        self.save_btn.config(state="normal" if len(self.marks) == 2 else "disabled")
        self.show()

    def save(self):
        name = "".join(ch for ch in self.name.get().strip() if ch not in '\\/:*?"<>|') or "체육관"
        prof = engine.GymProfile(name, {s: m[3] for s, m in self.marks.items()})
        prof.save(profiles_dir())
        self.grab_release()
        self.destroy()
        self.on_saved(name)


# ====================================================================== scene viewer
class SceneDialog(tk.Toplevel):
    def __init__(self, master, video_path: str, t: float, title: str):
        super().__init__(master)
        self.title(f"장면 보기 · {title}")
        self.photos = []
        video = engine.Video(video_path)
        grid = ttk.Frame(self)
        grid.pack(padx=8, pady=8)
        for i, dt in enumerate((-1.0, -0.5, 0.0, 0.5, 1.0, 1.5)):
            tt = max(0.0, t + dt)
            f = video.frame_at(tt)
            cell = ttk.Frame(grid)
            cell.grid(row=i // 3, column=i % 3, padx=3, pady=3)
            if f is not None:
                ph = to_photo(f, 360)
                self.photos.append(ph)
                ttk.Label(cell, image=ph).pack()
            ttk.Label(cell, text=f"{tt:.1f}초").pack()
        ttk.Button(self, text="닫기", command=self.destroy).pack(pady=(0, 8))


# ====================================================================== event editor
class EventDialog(tk.Toplevel):
    def __init__(self, master, teams: list[str], event: dict | None, on_ok):
        super().__init__(master)
        self.title("사건 수정" if event else "사건 추가")
        self.transient(master)
        self.on_ok = on_ok
        e = dict(event or {"time": 0.0, "team": teams[0], "player": "", "type": "리바운드", "detail": "수비", "result": "", "note": ""})
        self.orig = e
        self.v = {k: tk.StringVar(value=str(e.get(k, "") if e.get(k) is not None else "")) for k in ("time", "team", "player", "type", "detail", "result", "note")}
        form = ttk.Frame(self)
        form.pack(padx=12, pady=10)
        rows = [("시각(초)", ttk.Entry(form, textvariable=self.v["time"], width=10)),
                ("팀", ttk.Combobox(form, textvariable=self.v["team"], values=teams, width=14)),
                ("등번호", ttk.Entry(form, textvariable=self.v["player"], width=10)),
                ("기록", ttk.Combobox(form, textvariable=self.v["type"], values=stats.TYPES, state="readonly", width=14))]
        self.detail = ttk.Combobox(form, textvariable=self.v["detail"], width=18)
        self.result = ttk.Combobox(form, textvariable=self.v["result"], values=("", *stats.RESULTS), state="readonly", width=8)
        rows += [("세부", self.detail), ("결과", self.result), ("비고", ttk.Entry(form, textvariable=self.v["note"], width=48))]
        for i, (lab, w) in enumerate(rows):
            ttk.Label(form, text=lab).grid(row=i, column=0, sticky="w", pady=3)
            w.grid(row=i, column=1, sticky="w", pady=3)
        ttk.Label(form, text="등번호를 모르면 비워 두세요('미상'으로 집계).", foreground="#666").grid(row=len(rows), column=1, sticky="w")
        self.v["type"].trace_add("write", lambda *_: self.sync())
        self.sync(first=True)
        btns = ttk.Frame(self)
        btns.pack(fill="x", padx=12, pady=(0, 10))
        ttk.Button(btns, text="취소", command=self.destroy).pack(side="right")
        ttk.Button(btns, text="확인", command=self.ok).pack(side="right", padx=6)
        self.grab_set()

    def sync(self, first=False):
        typ = self.v["type"].get()
        opts = stats.DETAILS.get(typ, ())
        self.detail.config(values=("", *opts))
        if not first and self.v["detail"].get() not in opts:
            self.v["detail"].set(opts[0] if opts else "")
        has_result = typ in ("야투", "자유투")
        self.result.config(state="readonly" if has_result else "disabled")
        if not has_result:
            self.v["result"].set("")
        elif not self.v["result"].get():
            self.v["result"].set("실패")

    def ok(self):
        try:
            t = float(self.v["time"].get().replace(",", "."))
        except ValueError:
            messagebox.showerror(APP, "시각은 초 단위 숫자로 적어 주세요. 예: 83.5", parent=self)
            return
        e = dict(self.orig)
        e.update({k: self.v[k].get().strip() for k in ("team", "player", "type", "detail", "result", "note")})
        e["time"] = round(t, 1)
        e["source"] = "수동"
        e.setdefault("confidence", "")
        self.grab_release()
        self.destroy()
        self.on_ok(e)


# ====================================================================== main window
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP} {__version__} · 농구 영상 기록")
        self.geometry("1180x760")
        self.minsize(960, 620)
        if sys.platform == "win32":
            for name in ("TkDefaultFont", "TkTextFont", "TkHeadingFont", "TkMenuFont"):
                try:
                    tkfont.nametofont(name).configure(family="Malgun Gothic", size=10)
                except tk.TclError:
                    pass
        self.events: list[dict] = []
        self.work_path: str | None = None
        self.q: queue.Queue = queue.Queue()
        self.cancel_flag = threading.Event()
        self.worker: threading.Thread | None = None
        self.duration = 0.0
        self.v = {
            "video": tk.StringVar(), "profile": tk.StringVar(), "title": tk.StringVar(),
            "team_left": tk.StringVar(value="빨강"), "color_left": tk.StringVar(value="빨강"),
            "team_right": tk.StringVar(value="남색"), "color_right": tk.StringVar(value="남색"),
            "switch_time": tk.StringVar(),
        }
        self.build()
        self.reload_profiles()
        self.refresh()
        self.after(100, self.poll)

    # ------------------------------------------------------------------ layout
    def build(self):
        top = ttk.LabelFrame(self, text="1. 영상과 설정")
        top.pack(fill="x", padx=10, pady=(10, 4))
        r = 0
        ttk.Label(top, text="경기 영상").grid(row=r, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(top, textvariable=self.v["video"], width=70).grid(row=r, column=1, columnspan=4, sticky="we", padx=4)
        ttk.Button(top, text="찾아보기…", command=self.pick_video).grid(row=r, column=5, padx=4)
        r += 1
        ttk.Label(top, text="체육관 설정").grid(row=r, column=0, sticky="w", padx=6, pady=3)
        self.profile_box = ttk.Combobox(top, textvariable=self.v["profile"], state="readonly", width=30)
        self.profile_box.grid(row=r, column=1, sticky="w", padx=4)
        ttk.Button(top, text="새로 만들기(골대 표시)…", command=self.new_profile).grid(row=r, column=2, sticky="w", padx=4)
        ttk.Label(top, text="처음 가는 체육관만 한 번 하면 됩니다.", foreground="#666").grid(row=r, column=3, columnspan=3, sticky="w")
        r += 1
        ttk.Label(top, text="왼쪽 골대 공격 팀").grid(row=r, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(top, textvariable=self.v["team_left"], width=16).grid(row=r, column=1, sticky="w", padx=4)
        ttk.Combobox(top, textvariable=self.v["color_left"], values=TEAM_COLORS, state="readonly", width=8).grid(row=r, column=2, sticky="w", padx=4)
        ttk.Label(top, text="오른쪽 골대 공격 팀").grid(row=r, column=3, sticky="e", padx=6)
        ttk.Entry(top, textvariable=self.v["team_right"], width=16).grid(row=r, column=4, sticky="w", padx=4)
        ttk.Combobox(top, textvariable=self.v["color_right"], values=TEAM_COLORS, state="readonly", width=8).grid(row=r, column=5, sticky="w", padx=4)
        r += 1
        ttk.Label(top, text="공격 방향 바뀌는 시각").grid(row=r, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(top, textvariable=self.v["switch_time"], width=10).grid(row=r, column=1, sticky="w", padx=4)
        ttk.Label(top, text="초 (후반 시작 등. 없으면 비움)", foreground="#666").grid(row=r, column=2, columnspan=2, sticky="w")
        ttk.Label(top, text="제목").grid(row=r, column=3, sticky="e", padx=6)
        ttk.Entry(top, textvariable=self.v["title"], width=30).grid(row=r, column=4, columnspan=2, sticky="we", padx=4)
        top.columnconfigure(4, weight=1)

        run = ttk.LabelFrame(self, text="2. 자동 분석")
        run.pack(fill="x", padx=10, pady=4)
        self.run_btn = ttk.Button(run, text="분석 시작", command=self.start)
        self.run_btn.pack(side="left", padx=6, pady=6)
        self.cancel_btn = ttk.Button(run, text="취소", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="left")
        self.bar = ttk.Progressbar(run, length=260, maximum=1.0)
        self.bar.pack(side="left", padx=10)
        self.status = ttk.Label(run, text="영상을 고르고, 체육관 설정을 고른 뒤 '분석 시작'을 누르세요.")
        self.status.pack(side="left", padx=6)

        mid = ttk.LabelFrame(self, text="3. 검토와 수정 (자동 기록은 야투 시도·성공만입니다. 리바운드 등은 '사건 추가'로 넣으세요)")
        mid.pack(fill="both", expand=True, padx=10, pady=4)
        nb = ttk.Notebook(mid)
        nb.pack(fill="both", expand=True, padx=4, pady=4)

        tab1 = ttk.Frame(nb)
        nb.add(tab1, text="사건 기록")
        cols = ("time", "team", "player", "type", "detail", "result", "source", "confidence", "note")
        heads = ("시각(초)", "팀", "등번호", "기록", "세부", "결과", "출처", "신뢰도", "비고")
        widths = (70, 80, 60, 70, 110, 60, 50, 60, 520)
        self.tree = ttk.Treeview(tab1, columns=cols, show="headings", selectmode="browse")
        for c, h, w in zip(cols, heads, widths):
            self.tree.heading(c, text=h)
            self.tree.column(c, width=w, anchor="w" if c in ("note",) else "center", stretch=(c == "note"))
        sb = ttk.Scrollbar(tab1, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        side = ttk.Frame(tab1)
        side.pack(side="right", fill="y", padx=6)   # packed first so the table cannot squeeze the buttons
        sb.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<Double-1>", lambda _e: self.edit())
        for text, cmd in (("장면 보기", self.scene), ("수정…", self.edit), ("사건 추가…", self.add), ("삭제", self.delete)):
            ttk.Button(side, text=text, command=cmd, width=12).pack(pady=3)
        ttk.Label(side, text="\n두 번 누르면\n바로 수정합니다.", foreground="#666", justify="center").pack()

        tab2 = ttk.Frame(nb)
        nb.add(tab2, text="박스스코어")
        bcols = ("name",) + stats.COLS
        self.box = ttk.Treeview(tab2, columns=bcols[1:], show="tree headings")
        self.box.heading("#0", text="팀 / 등번호")
        self.box.column("#0", width=140, stretch=False)
        for c in stats.COLS:
            self.box.heading(c, text=c)
            self.box.column(c, width=52, anchor="e", stretch=False)
        bx = ttk.Scrollbar(tab2, orient="horizontal", command=self.box.xview)
        self.box.configure(xscrollcommand=bx.set)
        self.box.pack(fill="both", expand=True)
        bx.pack(fill="x")
        self.check_label = ttk.Label(tab2, text="", foreground="#9c5700", justify="left", wraplength=1050)
        self.check_label.pack(fill="x", pady=4)

        out = ttk.LabelFrame(self, text="4. 저장")
        out.pack(fill="x", padx=10, pady=(4, 10))
        for text, cmd in (("엑셀로 저장…", self.save_xlsx), ("웹페이지로 저장…", self.save_html), ("CSV로 저장…", self.save_csv)):
            ttk.Button(out, text=text, command=cmd).pack(side="left", padx=6, pady=6)
        ttk.Separator(out, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(out, text="작업 저장…", command=self.save_work).pack(side="left", padx=6)
        ttk.Button(out, text="작업 열기…", command=self.open_work).pack(side="left", padx=6)

    # ------------------------------------------------------------------ settings
    def settings(self) -> dict:
        s = {k: v.get().strip() for k, v in self.v.items()}
        st = s.get("switch_time")
        try:
            s["switch_time"] = float(st) if st else None
        except ValueError:
            s["switch_time"] = None
        s["duration"] = self.duration
        return s

    def teams(self) -> list[str]:
        s = self.settings()
        return [s["team_left"] or "팀 A", s["team_right"] or "팀 B"]

    def reload_profiles(self, select: str | None = None):
        names = list_profiles()
        self.profile_box.config(values=names)
        if select:
            self.v["profile"].set(select)
        elif names and not self.v["profile"].get():
            self.v["profile"].set(names[0])

    def pick_video(self):
        p = filedialog.askopenfilename(title="경기 영상 고르기", filetypes=[("영상", "*.mp4 *.mov *.m4v *.avi *.mkv"), ("모든 파일", "*.*")])
        if p:
            self.v["video"].set(p)
            try:
                self.duration = engine.Video(p).duration
                self.status.config(text=f"영상 길이 {self.duration:.0f}초. 체육관 설정을 고르고 '분석 시작'을 누르세요.")
            except IOError as e:
                messagebox.showerror(APP, str(e))

    def new_profile(self):
        p = self.v["video"].get()
        if not p or not os.path.exists(p):
            messagebox.showinfo(APP, "먼저 이 체육관에서 찍은 경기 영상을 고르세요. 그 영상에서 골대 위치를 표시합니다.")
            return
        ProfileDialog(self, p, lambda name: (self.reload_profiles(name), self.status.config(text=f"체육관 '{name}' 설정을 저장했습니다.")))

    # ------------------------------------------------------------------ analysis
    def start(self):
        s = self.settings()
        if not s["video"] or not os.path.exists(s["video"]):
            messagebox.showinfo(APP, "분석할 경기 영상을 고르세요.")
            return
        if not s["profile"]:
            messagebox.showinfo(APP, "체육관 설정이 없습니다. '새로 만들기'에서 양쪽 골대를 한 번 표시해 주세요.")
            return
        try:
            prof = engine.GymProfile.load(os.path.join(profiles_dir(), s["profile"]))
        except (OSError, KeyError, ValueError) as e:
            messagebox.showerror(APP, f"체육관 설정을 읽지 못했습니다: {e}")
            return
        if len(prof.templates) < 2:
            messagebox.showinfo(APP, "체육관 설정에 골대가 하나만 있습니다. 양쪽 골대를 모두 표시해 다시 저장해 주세요.")
            return
        self.cancel_flag.clear()
        self.run_btn.config(state="disabled")
        self.cancel_btn.config(state="normal")
        self.bar["value"] = 0

        def work():
            try:
                res = engine.analyze(s["video"], prof, progress=lambda l, f: self.q.put(("progress", l, f)), cancel=self.cancel_flag.is_set)
                self.q.put(("done", res, s))
            except engine.Cancelled:
                self.q.put(("cancelled",))
            except Exception as e:  # shown to the person, not swallowed
                self.q.put(("error", f"{type(e).__name__}: {e}"))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def cancel(self):
        self.cancel_flag.set()
        self.status.config(text="취소하는 중…")

    def poll(self):
        try:
            while True:
                msg = self.q.get_nowait()
                kind = msg[0]
                if kind == "progress":
                    _, label, frac = msg
                    self.bar["value"] = frac
                    self.status.config(text=f"{label} {frac:.0%}")
                elif kind == "done":
                    _, res, s = msg
                    self.duration = res["duration"]
                    s["duration"] = self.duration
                    auto = project.shots_to_events(res["shots"], s)
                    self.events = project.merge_reanalysis(self.events, auto)
                    vis = res["visibility"]
                    made = sum(1 for e in auto if e["result"] == "성공")
                    self.status.config(text=f"분석 끝: 야투 {len(auto)}개(성공 {made}) 찾음. 골대가 화면에 보인 비율 "
                                            f"왼쪽 {vis['왼쪽']:.0%}, 오른쪽 {vis['오른쪽']:.0%}, 안 보임 {vis['없음']:.0%}.")
                    if vis["왼쪽"] + vis["오른쪽"] < 0.3:
                        messagebox.showwarning(APP, "골대를 거의 찾지 못했습니다. 다른 체육관 영상이라면 '새로 만들기'로 체육관 설정을 새로 만들어 주세요.")
                    self.finish()
                    self.refresh()
                elif kind == "cancelled":
                    self.status.config(text="분석을 취소했습니다.")
                    self.finish()
                elif kind == "error":
                    self.status.config(text="분석 중 오류가 났습니다.")
                    messagebox.showerror(APP, f"분석 중 오류가 났습니다.\n{msg[1]}")
                    self.finish()
        except queue.Empty:
            pass
        self.after(100, self.poll)

    def finish(self):
        self.run_btn.config(state="normal")
        self.cancel_btn.config(state="disabled")

    # ------------------------------------------------------------------ tables
    def refresh(self):
        self.events.sort(key=lambda e: e.get("time", 0))
        self.tree.delete(*self.tree.get_children())
        for i, e in enumerate(self.events):
            self.tree.insert("", "end", iid=str(i), values=(f"{float(e.get('time', 0)):.1f}", e.get("team", ""), e.get("player", ""),
                                                           e.get("type", ""), e.get("detail", ""), e.get("result", ""),
                                                           e.get("source", ""), e.get("confidence", ""), e.get("note", "")))
        self.box.delete(*self.box.get_children())
        b = stats.box_score(self.events, self.teams())
        for team, s in b["teams"]:
            pid = self.box.insert("", "end", text=team, values=[stats.fmt(c, s[c]) for c in stats.COLS], open=True)
            for p, ps in b["players"].get(team, []):
                self.box.insert(pid, "end", text=f"  {p}", values=[stats.fmt(c, ps[c]) for c in stats.COLS])
        self.check_label.config(text="\n".join("※ " + m for m in stats.checks(self.events)))

    def selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo(APP, "표에서 줄을 하나 고르세요.")
            return None
        return int(sel[0])

    def scene(self):
        i = self.selected()
        if i is None:
            return
        p = self.v["video"].get()
        if not os.path.exists(p):
            messagebox.showinfo(APP, "영상 파일을 찾을 수 없습니다. '경기 영상'에서 다시 골라 주세요.")
            return
        e = self.events[i]
        SceneDialog(self, p, float(e.get("time", 0)), f"{e.get('time')}초 {e.get('team')} {e.get('type')}")

    def edit(self):
        i = self.selected()
        if i is None:
            return

        def done(e):
            self.events[i] = e
            self.refresh()

        EventDialog(self, self.teams(), self.events[i], done)

    def add(self):
        sel = self.tree.selection()
        base = dict(self.events[int(sel[0])]) if sel else None
        start = {"time": base["time"] if base else 0.0, "team": self.teams()[0], "player": "", "type": "리바운드", "detail": "수비", "result": "", "note": ""}

        def done(e):
            self.events.append(e)
            self.refresh()

        d = EventDialog(self, self.teams(), None, done)
        for k, v in start.items():
            d.v[k].set(str(v))

    def delete(self):
        i = self.selected()
        if i is None:
            return
        e = self.events[i]
        if messagebox.askyesno(APP, f"{e.get('time')}초 {e.get('team')} {e.get('type')} 기록을 지울까요?"):
            del self.events[i]
            self.refresh()

    # ------------------------------------------------------------------ files
    def _default_name(self, ext: str) -> str:
        v = self.v["video"].get()
        base = os.path.splitext(os.path.basename(v))[0] if v else "박스스코어"
        return f"{base}_박스스코어{ext}"

    def _ask(self, ext, kind):
        return filedialog.asksaveasfilename(title=f"{kind} 저장", defaultextension=ext, initialfile=self._default_name(ext), filetypes=[(kind, f"*{ext}")])

    def save_xlsx(self):
        p = self._ask(".xlsx", "엑셀")
        if p:
            export.save_xlsx(self.events, self.settings(), p)
            self.status.config(text=f"저장함: {p}")

    def save_html(self):
        p = self._ask(".html", "웹페이지")
        if p:
            export.save_html(self.events, self.settings(), p)
            self.status.config(text=f"저장함: {p}  (이 파일을 GitHub Pages 저장소에 index.html로 올리면 링크로 공유됩니다)")

    def save_csv(self):
        p = self._ask(".csv", "CSV")
        if p:
            export.save_csv(self.events, p)
            self.status.config(text=f"저장함: {p}")

    def save_work(self):
        p = filedialog.asksaveasfilename(title="작업 저장", defaultextension=".hoopstat.json", initialfile=self._default_name(".hoopstat.json"),
                                         filetypes=[("HoopStat 작업", "*.hoopstat.json"), ("JSON", "*.json")])
        if p:
            project.save(p, self.settings(), self.events)
            self.work_path = p
            self.status.config(text=f"작업을 저장했습니다: {p}")

    def open_work(self):
        p = filedialog.askopenfilename(title="작업 열기", filetypes=[("HoopStat 작업", "*.hoopstat.json *.json")])
        if not p:
            return
        try:
            s, ev = project.load(p)
        except (OSError, ValueError) as e:
            messagebox.showerror(APP, str(e))
            return
        for k, var in self.v.items():
            if k in s and s[k] is not None:
                var.set(str(s[k]))
        self.duration = s.get("duration") or 0.0
        self.events = ev
        self.work_path = p
        self.refresh()
        self.status.config(text=f"작업을 열었습니다: {os.path.basename(p)}")


def run():
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    App().mainloop()
