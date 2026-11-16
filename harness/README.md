# HoopStat 하네스

실제 경기 영상으로 **앱의 코드 그대로**(`hoopstat/*.js`, `hoopstat/vendor/`)를 돌려서 재는 도구입니다.
명령과 결과 읽는 법은 [`.claude/skills/hoopstat-eval/SKILL.md`](../.claude/skills/hoopstat-eval/SKILL.md), 개발 순서는
[`.claude/skills/hoopstat-orchestrator/SKILL.md`](../.claude/skills/hoopstat-orchestrator/SKILL.md)에 있습니다.

## 처음 한 번
```bash
cd harness && npm install          # onnxruntime-web (선수 단계용) 하나
cp config.example.json config.json # 영상 경로를 채움 (git에 올라가지 않음)
```
ffmpeg, Node 22, Playwright Chromium이 필요합니다(클라우드 세션에는 있음).

## 파일
| 파일 | 하는 일 |
|---|---|
| `lib.js` | 설정, OpenCV.js·ONNX Runtime 불러오기, ffmpeg로 프레임 뽑기, 라벨 읽기 |
| `engine-run.js` / `engine-compare.js` / `regress.js` | 분석 엔진 실행, 두 결과 비교, 기준값(`baselines/`)과 회귀 비교 |
| `players-run.js` / `players-score.js` | 선수 단계(번호·팀·공격 방향) 실행과 라벨 대비 채점 |
| `e2e.js` / `e2e-score.js` | 헤드리스 Chromium에서 앱 전체 실행(자체 웹 서버 포함)과 채점 |
| `strips.js` | 라벨용 장면 묶음 사진 |
| `make-clips.sh` | 헤드리스 Chromium용 VP9 클립 |
| `hooks/after-edit.sh` | Claude Code 편집 후 빠른 단위 테스트(`.claude/settings.json`) |
| `templates/` | 시험 영상의 체육관 골대 그림(84×70 회색조) |
| `baselines/` | 엔진 기준값(슛 목록과 카메라 방향 변화점) |

결과는 `_workspace/`(git 제외)에 쌓입니다. 영상·공유 링크·선수 사진은 저장소에 올리지 않습니다.
