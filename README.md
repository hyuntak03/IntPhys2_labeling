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
