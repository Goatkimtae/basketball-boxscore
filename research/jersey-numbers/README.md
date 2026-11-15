# 등번호 자동 인식 검토 (앱에는 넣지 않음)

2026-11-14 두 카메라 경기(슛 후보 40개)로 "슛한 선수의 등번호를 자동으로 채울 수 있는가"를 확인한 자료입니다.

## 결과

| 단계 | 결과 |
|---|---|
| 번호 읽기 | 화면에 번호가 보이면 거의 다 맞게 읽음(PP-OCRv4, 브라우저에서도 같은 결과) |
| 슛 순간에 슈터 번호가 보이는가(눈으로 확인) | 40개 중 20개(오른쪽 카메라 18개 중 12개, 왼쪽 카메라 22개 중 8개) |
| 공 옆 번호를 슈터로 채우기(엄격한 규칙) | 5~7개만 채움, 그중 4개 맞음 |
| 공 아래·옆 번호를 슈터로 채우기(느슨한 규칙) | 12개 채움, 5개 맞고 7개 틀림 |
| 공 가까운 번호 3개 안에 슈터가 있는가 | 번호가 보이는 20개 중 10개 |

틀리는 이유: 슈터 앞이나 옆에 선 다른 선수의 번호가 화면에서는 공 바로 아래에 겹쳐 보입니다.
누가 공을 잡고 있는지(팔·자세)를 알아야 가려낼 수 있는데, 위치만으로는 안 됩니다.
슈터가 옆이나 정면을 보고 있거나 화면 밖(왼쪽 카메라의 코너)에서 던진 슛은 번호 자체가 보이지 않습니다.

## 파일

- `numbers.js` — 브라우저(ONNX Runtime Web)와 Node에서 도는 번호 읽기. 같은 화면으로 RapidOCR(파이썬)과 대조해 같은 번호를 읽는 것을 확인.
  필요한 것: `onnxruntime-web@1.17.3`의 `ort.wasm.min.js`·`ort-wasm-simd.wasm`, `rapidocr-onnxruntime` 패키지 안의
  `ch_PP-OCRv4_det_infer.onnx`·`ch_PP-OCRv4_rec_infer.onnx`(합쳐 약 26MB).
- `ball_track.py` — 슛 직전 공의 위치를 거꾸로 따라가 슈터가 공을 들고 있던 지점을 찾는 방법.
- `eval_rules.py` — 규칙별 정답 수 계산(`python eval_rules.py`, `data/shots.json`만 있으면 됨).
- `data/shots.json` — 슛 40개의 공 궤적, 0.1초 간격으로 읽은 번호 상자, 눈으로 확인한 슈터 번호.

## Claude에게 묻는 시험 (`claude_test/`)

슛마다 슈터가 공을 잡은 순간 앞뒤 3장면(공에 노란 원)을 잘라 Claude API에 보내고 슈터 번호를 묻습니다.
사진은 Anthropic 서버로 전송됩니다. 영상 원본과 잘라낸 사진은 저장소에 올리지 않습니다.

```bash
python claude_test/make_frames.py <왼쪽 골대 영상> <오른쪽 골대 영상> <작업 폴더>
HOOPSTAT_TEST_DIR=<작업 폴더> HOOPSTAT_CLAUDE_KEY=<API 키> python claude_test/ask_claude.py claude-opus-5-5 medium
python claude_test/score.py <작업 폴더>/answers_claude-opus-5-5_medium.json
```

키는 `HOOPSTAT_CLAUDE_KEY`로 읽습니다(`ANTHROPIC_API_KEY`를 쓰지 않는 것은 Claude Code가 그 키로 바뀌어 쓰지 않게 하려는 것).
정답은 사람이 아니라 Claude Code가 눈으로 본 번호라서, 같은 계열 모델끼리 같은 실수를 할 수 있습니다. 사람이 확인한 정답으로 다시 재야 합니다.
