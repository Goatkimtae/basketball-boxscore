---
name: hoopstat-orchestrator
description: "HoopStat(농구 영상 → 경기 기록 웹 앱) 개발을 분석 엔진·측정·정답·앱 담당 4역할로 나눠 진행하는 오케스트레이터. '기능 추가해줘', '정확도 올려줘', '리바운드/어시스트 자동으로', '분석 시간 줄여줘', '버그 고쳐줘', '배포해줘' 등 HoopStat의 기능·정확도·속도·화면 변경 요청 전반에 사용. 후속 요청('다시 재봐', '이전 결과 개선')도 이 스킬로."
---

# HoopStat 오케스트레이터

분석 엔진(hoopstat-vision), 측정·검수(hoopstat-evaluator), 정답 만들기(hoopstat-labeler), 앱·문서·배포(hoopstat-app) 4역할로 HoopStat을 개발한다. 핵심은 **하네스로 재고 나서 말하는 것**: 모든 정확도·속도 주장은 `harness/` 명령의 결과에서 나온다.

## 실행 방식
- 기본: 리더(지금의 Claude)가 역할을 순서대로 직접 수행한다. 문맥을 이미 갖고 있어 가장 싸고 빠르다.
- 서브에이전트(Agent 도구)는 서로 독립적이고 오래 걸리는 일에만: 정답 라벨 묶음 여러 개를 동시에 보기(hoopstat-labeler × N), 긴 측정 돌리는 동안 다른 작업. 프롬프트에 파일 경로·영상 key·기대 산출물 형식을 모두 적는다(새 에이전트는 이 대화를 모른다).
- 오래 걸리는 명령(엔진 회귀, 선수 단계, 브라우저 실행)은 `run_in_background`로 돌리고 그동안 문서·다음 단계를 진행한다. 끝나면 알림이 온다(sleep으로 기다리지 않는다).

## Phase 0: 준비 확인
1. `harness/config.json`이 있는가? 없으면 `config.example.json`을 복사해 영상 경로를 채운다. 영상이 없으면(새 세션은 컨테이너가 비어 있음) 사용자에게 원본 공유 링크를 다시 받아 내려받는다(Quick Share는 브라우저 User-Agent 필요, 환경 네트워크 허용 호스트 필요).
2. `cd harness && npm install`(onnxruntime-web 하나), ffmpeg·Chromium(playwright)은 환경에 있음.
3. `_workspace/`(git 제외)에 이전 결과가 있으면 기준으로 삼는다.

## Phase 1: 목표와 합격선
- 요청을 측정 가능한 목표로 바꾼다: 예) "리바운드 선수 번호: 라벨 N개 중 맞음 ≥ x, 틀림 ≤ y, 경기당 추가 시간 ≤ z분".
- 정답이 없으면 hoopstat-labeler 단계부터(strips.js로 장면 → 눈으로 라벨, 확실/추정 구분).
- 사용자 선호: 비용 없음(유료 API 금지), 수동 확인 최소화, 확신 낮은 값은 '추정'으로 표시, 파이썬은 연구용만.

## Phase 2: 구현
- 연구(필요 시): `research/<주제>/`에서 빠르게 시험 → 효과가 있는 방법만 앱으로.
- 엔진/선수 단계: hoopstat-vision 지침. 앱 연결·화면: hoopstat-app 지침.
- 편집하면 훅이 빠른 단위 테스트를 자동 실행한다(실패 시 바로 알려 줌).

## Phase 3: 측정(합격 판정)
hoopstat-evaluator 지침과 `hoopstat-eval` 스킬의 명령으로:
1. 단위 테스트 전부 통과
2. 엔진을 건드렸으면 `node harness/regress.js` PASS(의도한 변화면 이유와 함께 `--update`)
3. 선수 단계를 건드렸으면 `players-run` ×2 + `players-score` — 이전 숫자와 표로 비교
4. 화면/흐름을 건드렸으면 `e2e.js`(150초 클립) 오류 없음, 필요하면 전체 경기
합격선 미달이면 Phase 2로(최대 2번). 그래도 안 되면 사실대로 보고하고 사용자에게 방향을 묻는다.

## Phase 4: 문서·배포
hoopstat-app 지침의 배포 순서. `사용법.html` 정확도 표 = Phase 3 숫자. CLAUDE.md 변경 이력에 한 줄.

## Phase 5: 보고(한국어)
- 무엇이 자동이 되었는지, 잰 숫자(맞음/틀림/빈칸, 시간), 재지 않은 것, 한계. 사실과 추측을 나눈다.
- 결정이 필요한 것만 묻는다(예: 정확도 대 시간의 맞바꿈).

## 데이터 흐름
```
요청 ─▶ 목표·합격선 ─▶ (정답 없으면) labeler: strips.js → 라벨 JSON
                         │
                         ▼
          vision/app: 코드 변경 ──(편집 훅: 단위 테스트)
                         │
                         ▼
          evaluator: regress / players-score / e2e  ──미달──▶ 다시 구현(최대 2회)
                         │ 합격
                         ▼
          app: 문서·VERSION·커밋·main·Actions 확인 ─▶ 보고
```
