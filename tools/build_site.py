"""라벨링 사이트 빌드: videos/ → clips/ (웹용 재인코딩) + data/manifest.js (4 분할).

왜 재인코딩하나:
  원본 mp4 는 edit list 로 첫 프레임이 0.05 s (3 프레임) 에서 시작하고 B-frame 이 있다.
  Chrome 은 이 오프셋을 그대로 두기 때문에 currentTime = (k + 0.5) / 60 으로 이동하면 프레임 k-3 이 보인다.
  clips/ 는 B-frame 없이 프레임 k 의 pts 를 정확히 k / 60 으로 맞춘 사본이다 (프레임 수 · 순서는 원본과 동일).

  python tools/build_site.py              # 인코딩 (있는 건 건너뜀) + 검증 + manifest
  python tools/build_site.py --skip-encode
"""
import argparse
import csv
import json
import os
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANNOTATORS = ["A", "B", "C", "D"]
FPS = 60
CRF, GOP = 23, 60  # 원본 대비 용량 ≈ 1.07 배, PSNR 38–52 dB


def clip_path(file):
    return "clips/" + file[len("videos/"):]


def encode(row):
    src, dst = os.path.join(ROOT, row["file"]), os.path.join(ROOT, clip_path(row["file"]))
    if os.path.exists(dst) and probe(dst)["nb_frames"] == int(row["n_frames"]):
        return "skip"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-an",
         "-fps_mode", "passthrough", "-vf", f"setpts=N/({FPS}*TB)",
         "-c:v", "libx264", "-preset", "slow", "-crf", str(CRF), "-bf", "0", "-g", str(GOP),
         "-pix_fmt", "yuv420p", "-video_track_timescale", str(FPS * 256), "-movflags", "+faststart", tmp],
        check=True)
    os.replace(tmp, dst)
    return "done"


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=start_time,nb_read_packets,has_b_frames", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    return {"start": float(s["start_time"]), "nb_frames": int(s["nb_read_packets"]), "bframes": int(s["has_b_frames"])}


def verify(rows):
    bad = []
    for r in rows:
        p = probe(os.path.join(ROOT, clip_path(r["file"])))
        if p["start"] != 0 or p["bframes"] != 0 or p["nb_frames"] != int(r["n_frames"]):
            bad.append((r["file"], p, r["n_frames"]))
    return bad


def partition(rows):
    """장면 단위 (pair1 · pair2 같이) 로, condition · game 마다 고르게 4 명에게 나눈다."""
    units = defaultdict(list)
    for r in rows:
        units[(r["condition"], r["game_name"], r["SceneIndex"])].append(r)
    count = {a: 0 for a in ANNOTATORS}
    per_cond = defaultdict(lambda: {a: 0 for a in ANNOTATORS})
    assign = {}
    for (cond, game, scene) in sorted(units, key=lambda k: (k[0], k[1], scene_key(k[2]))):
        a = min(ANNOTATORS, key=lambda x: (per_cond[cond][x], count[x], x))
        for r in units[(cond, game, scene)]:
            assign[r["file"]] = a
        n = len(units[(cond, game, scene)])
        per_cond[cond][a] += n
        count[a] += n
    return assign, count, per_cond


def scene_key(s):
    head, _, tail = s.partition("_")
    return (int(head), int(tail or -1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-encode", action="store_true")
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    args = ap.parse_args()

    with open(os.path.join(ROOT, "labels.csv")) as f:
        rows = list(csv.DictReader(f))

    if not args.skip_encode:
        with ThreadPoolExecutor(args.jobs) as ex:
            res = list(ex.map(encode, rows))
        print(f"encode: {res.count('done')} 새로, {res.count('skip')} 건너뜀")
    bad = verify(rows)
    if bad:
        for b in bad[:10]:
            print("검증 실패:", b)
        raise SystemExit(f"{len(bad)} 개 검증 실패")
    print(f"verify: {len(rows)} 개 모두 start=0 · B-frame 없음 · 프레임 수 일치")

    assign, count, per_cond = partition(rows)
    videos = [{
        "id": r["file"], "src": clip_path(r["file"]), "part": assign[r["file"]],
        "cond": r["condition"], "scene": r["SceneIndex"], "pair": int(r["pair"]), "game": r["game_name"],
        "env": r["env"], "occ": r["occluder"], "diff": r["Difficulty"], "cam": r["Camera"],
        "n": int(r["n_frames"]),
    } for r in rows]
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "manifest.js"), "w") as f:
        f.write("// tools/build_site.py 가 만든 파일. 직접 고치지 말 것.\n")
        f.write("window.MANIFEST = ")
        json.dump({"fps": FPS, "annotators": ANNOTATORS, "videos": videos}, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("partition:", count)
    for c, d in sorted(per_cond.items()):
        print(f"  {c:13s}", d)


if __name__ == "__main__":
    main()
