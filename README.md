# IntPhys 2 Main — 불가능 영상 위반 시점 라벨링 (2026-10-15)

IntPhys 2 공개 데이터에는 위반이 **언제** 일어나는지 라벨이 없다 (메타데이터 · 공식 저장소 모두 확인).
같은 장면의 영상들도 첫 프레임부터 서로 달라 (조명 · 카메라 · 배치가 매번 다르게 렌더됨) 가능 / 불가능 영상의 차이로 자동 추출할 수 없다.
그래서 불가능 영상 506 개를 사람이 표시한다. 용도: 위반 구간만 보는 surprise 채점 (전체 토큰 평균에 위반 신호가 묻히는지 확인).

## 들어 있는 것

| 경로 | 내용 |
|---|---|
| `videos/<condition>/scene<SceneIndex>_pair<1|2>_impossible_<game>.mp4` | Main 의 불가능 영상 506 개 사본 (permanence 120 · immutability 120 · continuity 120 · solidity 146). 512×512 · **60 fps** · 635–936 프레임 |
| `labels.csv` | 영상마다 한 줄. 채울 열: `violation_start_frame` · `violation_end_frame` · `note` |

`labels.csv` 의 다른 열: SceneIndex · pair · condition · game_name · env · occluder · Difficulty · Camera · n_frames · fps,
그리고 원본 경로 `impossible_src` 와 **같은 쌍의 가능 영상** 경로 `possible_src` (비교해 볼 때).

## 표시 규칙

- 프레임 번호는 **원본 60 fps 기준, 0 부터** (영상 시작 = 0). 채점은 6 fps (raw 0, 10, 20, …) 로 읽으니 나중에 10 으로 나눈다.
- `violation_start_frame` = 위반이 **처음 보이는** 프레임 (사라지기 시작 · 바뀌기 시작 · 통과하기 시작 · 순간이동한 첫 프레임).
- `violation_end_frame` = 위반이 끝나는 프레임 (순간적인 사건이면 start 와 같게). 위반이 가림막 뒤에서 일어나 **드러나는 순간**이 따로 있으면, start 는 드러나는 프레임으로 하고 note 에 "가림 뒤" 라고 적는다.
- 위반을 못 찾겠으면 비워 두고 note 에 이유.

## 만든 방법

```bash
# vjepa2 레포에서 (2026-10-15): Main/metadata.csv 의 *_Impossible 506 개를 condition 별 폴더로 복사, decord 로 프레임 수 · fps 기록
#   원본: /data/dataset/world/IntPhys2/Main
```

## 라벨링 사이트 (GitHub Pages, 2026-10-18)

506 개를 4 명 (A–D) 이 나눠 표시하는 정적 페이지. 라벨은 브라우저에 먼저 저장되고, 공유 시트 ([IntPhys2_labeling](https://docs.google.com/spreadsheets/d/1OZduu13VvKCebp0YZuTc0WEoZaFaBzSxMOwmHNOrEZY/edit)) 로 보내진다. CSV 내보내기는 백업.

| 경로 | 내용 |
|---|---|
| `index.html` · `assets/` | 라벨링 도구 |
| `clips/<condition>/…mp4` | 웹용 재인코딩본 506 개 (650 MB). **프레임 k = 원본 프레임 k**, pts = k / 60 (B-frame 없음 · GOP 60 · crf 23) |
| `data/manifest.js` | 영상 목록 + 작업자 분할. `tools/build_site.py` 가 만든다 |
| `tools/build_site.py` | `videos/` → `clips/` 재인코딩 · 검증 + manifest |
| `tools/serve.py` | 로컬 미리보기 (`python -m http.server` 는 Range 를 안 받아 영상 안에서 이동이 안 됨) |
| `data/config.js` | `SYNC_URL`: 시트 동기화 웹 앱 주소. 비우면 브라우저 저장 + CSV 만 |
| `tools/sheet_sync.gs` | 시트에 붙이는 Apps Script (동기화 서버 역할) |
| `tools/merge_labels.py` | 시트 (또는 작업자 CSV) → `labels.csv` |

- 재인코딩 이유: 원본 mp4 는 edit list 로 첫 프레임이 0.05 s 에서 시작한다. Chrome 에서 `currentTime = (k + 0.5) / 60` 으로 이동하면 프레임 k-3 이 보인다.
- 확인: clip 과 원본을 원본 해상도로 비교하면 움직임이 있는 프레임은 전부 같은 번호와 가장 가깝다 (정지 구간은 구분 불가). headless Chrome 화면을 clip 디코딩과 비교해도 23 프레임 전부 일치 (첫 · 마지막 프레임 포함).
- 분할: 장면 단위 (pair1 · pair2 같이) 로, condition · game 마다 고르게. A 128 · B / C / D 126, condition 당 30 (solidity 36–38).
- 원본 `videos/` · `gifs/` 는 `.gitignore` (Pages 사이트 1 GB 제한).

```bash
python tools/build_site.py                  # 다시 돌리면 있는 clip 은 건너뜀
python tools/serve.py                       # http://127.0.0.1:8000/?a=A
# 배포: GitHub Settings → Pages → main / (root) → https://hyuntak03.github.io/IntPhys2_labeling/?a=A
python tools/merge_labels.py "<SYNC_URL>?format=csv"  # 시트 → labels_merged.csv (--inplace 면 labels.csv)
```

### 공유 시트

- `labels` 탭: 영상 1 개 = 1 행 (506 행을 미리 채움, 앱과 같은 순서). F–K (시작 · 끝 · 메모 · 가림 뒤 · 못 찾음 · updated_at) 만 앱이 쓴다. condition · game_name · status 는 수식.
- `현황` 탭: 작업자별 · condition 별 완료 / 못 찾음 / 진행 중 / 남음 / 진행률.
- 같은 영상은 `updated_at` 이 늦은 쪽이 이긴다. 시트 연결이 끊기면 브라우저에 쌓아 두고 다시 보낸다. 새 컴퓨터에서 열면 시트에서 불러온다.
- 웹 앱은 "모든 사용자" 가 부를 수 있다 (주소가 공개 페이지에 들어감). 대신 미리 채운 행의 라벨 칸만, 그 행의 담당자로만, 0 – n_frames-1 정수로만 쓸 수 있게 막아 둠.

배포 (한 번):

1. 시트에서 확장 프로그램 → Apps Script. `Code.gs` 내용을 지우고 `tools/sheet_sync.gs` 를 붙여넣고 저장.
2. 배포 → 새 배포 → 유형: 웹 앱. 실행 계정: 나, 액세스 권한: 모든 사용자 → 배포 → 권한 승인 ("확인되지 않은 앱" 이 뜨면 고급 → 이동).
3. 나온 웹 앱 URL (`https://script.google.com/macros/s/…/exec`) 을 `data/config.js` 의 `SYNC_URL` 에 넣는다.
4. `sheet_sync.gs` 를 고치면 배포 관리 → 수정 → 버전: 새 버전 (URL 유지).
