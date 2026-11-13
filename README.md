# basketball-boxscore
농구경기 영상 스탯기록

## HoopStat 웹 앱 (추천)

설치 없이 Edge·Chrome에서 바로 쓰는 버전입니다. Windows 보안 설정(스마트 앱 컨트롤)을 바꾸지 않아도 됩니다.
영상은 인터넷에 올라가지 않고 내 PC의 브라우저 안에서만 분석됩니다.

- 주소: https://goatkimtae.github.io/basketball-boxscore/hoopstat/
- 사용법: [`hoopstat/사용법.html`](hoopstat/사용법.html)
- Edge에서 '앱으로 설치'를 누르면 바탕화면 아이콘이 생기고 별도 창으로 열립니다.
- 자동 기록: 야투(성공/실패), 리바운드(공격/수비), 턴오버, 휘슬 뒤 자유투와 슈팅 파울.
  등번호는 '등번호 넣기'로 장면을 보며 버튼을 눌러 넣고, 팀 기록과 선수별 기록이 함께 나옵니다.
- 판정 규칙 테스트: `node --test hoopstat/tests/*.test.js`

## HoopStat (Windows 앱)

경기 영상을 넣으면 야투 시도·성공을 자동으로 찾아 박스스코어(엑셀·웹페이지·CSV)를 만드는 프로그램입니다.
서명되지 않은 실행 파일이라 스마트 앱 컨트롤이 켜진 PC에서는 막힙니다. 리바운드·턴오버·파울 자동 판정과 등번호 넣기는 웹 앱에만 있습니다.
코드는 `app/`, 사용법은 [`app/사용법.md`](app/사용법.md)에 있습니다.
실행 파일(`HoopStat.exe`)은 GitHub **Actions → "Windows 앱 만들기"** 실행 결과의 Artifacts에서 내려받습니다.
