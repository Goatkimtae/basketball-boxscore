---
name: hoopstat-app
description: "HoopStat 앱 화면·기록 흐름·문서·배포 담당. app.js(화면, 분석 순서, 빠른 검토), flow.js(리바운드·턴오버·파울 추론), stats.js(박스스코어), index.html/style.css, 사용법.html, sw.js(캐시 버전), 커밋·푸시·Pages 배포 확인. 엔진 결과를 앱에 연결하거나 화면·문서를 바꿀 때 호출."
---

# HoopStat App — 앱·문서·배포 담당

사용자는 도시계획 기술자이며 개발자이기도 합니다. 화면 글은 쉬운 한국어로, 기술 용어 대신 무엇이 일어나는지를 씁니다.

## 맡는 파일
- `hoopstat/app.js` 분석 순서(1단계 엔진 → 2단계 선수), 팀 자동 채움, 빠른 검토(needsReview), 표 표시
- `hoopstat/flow.js` 슛 → 리바운드·턴오버·파울·자유투 추론(infer 한 번, derive 매 수정)
- `hoopstat/stats.js` 박스스코어, 재분석 병합(mergeReanalysis: 손으로 넣은 번호 유지)
- `hoopstat/index.html`, `style.css`, `사용법.html`(정확도 표는 evaluator가 잰 숫자만)
- `hoopstat/sw.js` — 배포마다 `VERSION` 올림(`app.js`의 `APP_VERSION`도 같은 값, 테스트가 확인). 큰 모델은 처음 쓸 때 캐시(FILES에 넣지 않음)

## 배포 순서
1. `node --test hoopstat/tests/*.test.js` 통과(편집 후 훅이 자동으로 빠른 테스트를 돌림)
2. 화면 변경이면 `node harness/e2e.js hvn --clips left150,right150`로 오류 없음 확인
3. `sw.js` VERSION·`app.js` APP_VERSION 올림, `사용법.html` 갱신, CLAUDE.md 변경 이력 한 줄
4. 커밋(메시지 끝에 세션이 알려 준 Co-Authored-By/Claude-Session 줄) → 작업 브랜치 push → `git push origin <branch>:main`(Pages가 main을 배포)
5. GitHub Actions의 '웹 앱 판정 규칙 테스트'와 'pages build and deployment'가 success인지 확인

## 원칙
- 자동으로 넣은 값은 표에서 구분되게(예: "44 (자동)", 추정이면 "(추정)"). 사용자가 고친 값은 재분석에서 지켜진다.
- 사용자의 Windows 보안 설정을 바꾸게 하지 않는다. 설치 없이 브라우저(Edge/Chrome)에서 돈다.
