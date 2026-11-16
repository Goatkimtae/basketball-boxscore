---
name: hoopstat-eval
description: "HoopStat 하네스 명령 모음과 결과 읽는 법. 엔진 회귀, 선수 번호·팀·공격 방향 정확도, 브라우저 전체 실행, 라벨용 장면 묶음, 시험용 클립 만들기. 'HoopStat 재봐', '회귀 테스트', '정확도 측정', 'e2e 돌려줘', '라벨 만들 장면 뽑아줘'에 사용."
---

# HoopStat 하네스 사용법

모든 스크립트는 앱의 실제 파일(`hoopstat/*.js`, `hoopstat/vendor/`)을 그대로 불러 쓴다 — 잰 것이 배포되는 것이다.
설정: `harness/config.json`(git 제외; `config.example.json` 참고). 결과: `_workspace/`(git 제외).

## 명령
| 목적 | 명령 | 결과 |
|---|---|---|
| 단위 테스트 | `node --test hoopstat/tests/*.test.js` | 통과/실패 |
| 엔진 한 영상 | `node harness/engine-run.js <key>` | `_workspace/engine/<key>.json` |
| 엔진 회귀 | `node harness/regress.js [--only a,b] [--jobs 4] [--update]` | 영상별 PASS/FAIL, 종료코드 1=슛 변화 |
| 두 결과 비교 | `node harness/engine-compare.js a.json b.json` | 한쪽에만 있는 슛, 카메라 방향 차이, 기록 차이 |
| 선수 단계 | `node harness/players-run.js <key> [--gathers labels\|engine] [--no-people]` | `_workspace/players/<key>.json` |
| 선수 채점 | `node harness/players-score.js <game>` | 팀 명단, 공격 방향 표, 맞음/틀림/빈칸 |
| 앱 전체 | `node harness/e2e.js <game> [--clips left150,right150] [--no-players]` | `_workspace/e2e/<game>-<시각>.json`, 스크린샷 |
| 앱 전체 채점 | `node harness/e2e-score.js <e2e json>` | 슛별 자동 번호의 맞음/틀림 |
| 라벨용 장면 | `node harness/strips.js <key> --times ... [--offsets ...] [--x x0,x1] [--marks ...]` | `_workspace/strips/*.jpg` |
| 브라우저용 클립 | `harness/make-clips.sh <원본> <출력.mp4> [초]` | VP9+Opus MP4(원본 해상도) |

## 현재 기준값 (2026-11-15/16, H vs N 경기, 카메라 2대)
- 엔진: `harness/baselines/*.json` (hvn-left 23슛, hvn-right 18슛, band-sample 8, band-foul 24)
- 선수 단계(Node, 라벨 gather): 팀 명단 10명 중 9명(흰 팀 0번 빠짐), 공격 방향 맞음, 라벨 20개 중 자동 7(맞음 7, 틀림 0)
- 앱 전체(브라우저, 8분 경기 VP9): 슛 43개 중 13개 자동, 확인 가능 10개 중 맞음 9·틀림 1, 1단계 13분 + 2단계 5분 30초(4코어, 소프트웨어 해석)
- 추정(외형): 번호 못 읽은 라벨 슛 Node 13개 중 4개, 브라우저 앱 전체 10개 중 2개(13·77로 쏠림) 맞음. 변형(최소 관측 수, 퍼짐 보정, 빈도 우선) 모두 나아지지 않음. 리바운드(오른쪽 카메라 라벨 14개, `research/rebounds/data/rebounds.json`): 팀 9/11, 선수 2/9
- 앱 전체(브라우저) 리바운드: 33개 중 번호 읽음 10·추정 23, 라벨 대비 팀 9/11, 번호 2/9. `e2e-score.js`가 슈터·리바운드 모두 채점
- 리바운드 측정: `node harness/players-run.js hvn-right --no-shots --no-people --rebounds` 후 `players-score.js hvn`

## 결과 읽을 때
- 라벨의 `sure:false`(표시 "?")는 사람이 눈으로 봐도 애매했던 것. 확실한 라벨만의 숫자도 같이 보고.
- `players-score`의 `rejected`는 읽었지만 명단·공격 방향과 안 맞아 넣지 않은 번호(대부분 틀린 판독).
- 150초 클립에서는 슛이 적어 공격 방향이 안 정해질 수 있다(정상) — 그러면 번호 자동 입력도 0.
- 시간은 이 컨테이너(4코어, 하드웨어 영상 해석 없음) 기준. 사용자 PC 시간이 아니다.

## 함정
- 명령 출력을 `| tail`로 받으면 끝날 때까지 아무것도 안 보인다. 긴 작업은 백그라운드로.
- 엔진 회귀를 4개 동시에 돌리는 동안 다른 무거운 작업을 하면 둘 다 느려진다.
- `harness/lib.js`의 `loadCv()`는 전역 `cv`만 세팅(반환값 없음).
