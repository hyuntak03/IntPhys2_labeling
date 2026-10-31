# IntPhys 1 dev — 가림이 있는 샘플 (mp4, 2026-10-31)

IntPhys 1 dev 360 영상 중 물체가 가림막 뒤로 가려지는 샘플 **180 개** (288² · 15 fps · 100 장, 보통 mp4 = H.264 High · yuv420p · CRF 18).

| 묶음 | 영상 | 쌍 (가능 ↔ 불가능, 문맥 같음) |
|---|---:|---:|
| 움직이는 물체 · 가림 (moving/occluded) | 120 | 60 |
| 정지 물체 · 가림 (static/occluded) | 60 | 30 |
| 원리별 (block_type) | O1 영속 60 · O2 모양 60 · O3 연속 60 | 각 30 |

- `videos/<video_id>.mp4` — 원본 PNG 프레임 (`/local_datasets/world/world_analysis/IntPhys1_dev_frame_png/<원리>/<번호>/<run>/scene/scene_001–100.png`, vll5) 에서 다시 인코딩했다. 원본 mp4 (`IntPhys1_dev_videos/scene/`) 는 무손실 RGB (H.264 High 4:4:4, gbrp) 라 대부분의 플레이어에서 색이 깨져 보여서 쓰지 않았다 (2026-10-31).
- `index.csv` — video_id · 쌍 (block_id, pair_id) · 가능 여부 · 원리 · 묶음 · 위반 시점 d (원본 0-based 프레임, 가능 · 불가능이 처음 갈리는 프레임) · 사건 종류.
  출처는 `data_csv/intphys1_late/index.csv` (`cvpr/eval/intphys1_late/build.py`).
- 채점 하네스는 PNG 프레임 (`IntPhys1_dev_frame_png`) 을 읽는다. 이 mp4 는 손실 압축 (yuv420p) 이라 화소가 조금 다르다 — 보기 · 분석용이고, 채점 수치는 PNG 판이 정본이다.
