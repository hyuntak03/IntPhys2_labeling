"""라벨링 사이트 빌드: 원본 영상 → 웹용 재인코딩 clip + manifest (4 분할).

  ip2  IntPhys 2  labels.csv 506 개 (60 fps)            videos/ → clips/                                       data/manifest.js
  ip1  IntPhys 1  intphys1_occluded/index.csv 180 개 (15 fps)  intphys1_occluded/videos/ → intphys1_occluded/clips/  data/manifest_ip1.js

왜 재인코딩하나:
  IntPhys 2 원본 mp4 는 edit list 로 첫 프레임이 0.05 s (3 프레임) 에서 시작하고 B-frame 이 있다.
  Chrome 은 이 오프셋을 그대로 두기 때문에 currentTime = (k + 0.5) / 60 으로 이동하면 프레임 k-3 이 보인다.
  IntPhys 1 mp4 는 시작은 0 이지만 B-frame 이 있어 같은 방식으로 맞춘다.
  clip 은 B-frame 없이 프레임 k 의 pts 를 정확히 k / fps 로 맞춘 사본이다 (프레임 수 · 순서는 원본과 동일).

  python tools/build_site.py              # 둘 다: 인코딩 (있는 건 건너뜀) + 검증 + manifest
  python tools/build_site.py --set ip1
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
IP1_DIR = "intphys1_occluded"


class IP2:
    key, fps = "ip2", 60
    crf, gop = 23, 60  # 원본 대비 용량 ≈ 1.07 배, PSNR 38–52 dB
    manifest, var = "manifest.js", "MANIFEST"

    @staticmethod
    def rows():
        with open(os.path.join(ROOT, "labels.csv")) as f:
            return [dict(r, src=r["file"], clip="clips/" + r["file"][len("videos/"):], n=int(r["n_frames"]))
                    for r in csv.DictReader(f)]

    @staticmethod
    def partition(rows):
        """장면 단위 (pair1 · pair2 같이) 로, condition · game 마다 고르게 4 명에게 나눈다."""
        return balance(rows, lambda r: (r["condition"], r["game_name"], scene_key(r["SceneIndex"])), lambda u: u[0])

    @staticmethod
    def videos(rows, assign):
        return [{
            "id": r["file"], "src": r["clip"], "part": assign[r["file"]],
            "cond": r["condition"], "scene": r["SceneIndex"], "pair": int(r["pair"]), "game": r["game_name"],
            "env": r["env"], "occ": r["occluder"], "diff": r["Difficulty"], "cam": r["Camera"],
            "n": r["n"],
        } for r in rows]


class IP1:
    key, fps = "ip1", 15
    crf, gop = 16, 15  # 원본이 288² 라 작다 (영상당 ≈ 150 KB)
    manifest, var = "manifest_ip1.js", "MANIFEST_IP1"

    @staticmethod
    def rows():
        with open(os.path.join(ROOT, IP1_DIR, "index.csv")) as f:
            rows = [dict(r, src=f"{IP1_DIR}/{r['file']}", clip=f"{IP1_DIR}/clips/{r['video_id']}.mp4") for r in csv.DictReader(f)]
        for r in rows:
            r["n"] = probe(os.path.join(ROOT, r["src"]))["nb_frames"]
        return rows

    @staticmethod
    def partition(rows):
        """묶음 (quadruplet: 쌍 2 개 = 영상 4 개) 단위로, 원리 · 정지/움직임 마다 고르게 4 명에게 나눈다.
        같은 쌍의 가능 · 불가능 영상은 늘 한 사람이 같이 본다."""
        return balance(rows, lambda r: (r["block_type"], r["group"], r["quadruplet"]), lambda u: u[:2])

    @staticmethod
    def videos(rows, assign):
        mate = {(r["block_type"], r["quadruplet"], r["pair_id"], r["plausible"]): r["video_id"] for r in rows}
        out = [{
            "id": r["video_id"], "src": r["clip"], "part": assign[r["video_id"]],
            "prin": r["block_type"], "quad": r["quadruplet"], "pair": int(r["pair_id"]), "pos": r["plausible"] == "1",
            "mate": mate[(r["block_type"], r["quadruplet"], r["pair_id"], "0" if r["plausible"] == "1" else "1")],
            "n": r["n"],
        } for r in rows]
        # 시트 행 · 목록 순서: 원리 → 묶음 → 쌍 → 불가능 · 가능
        return sorted(out, key=lambda v: (v["prin"], v["quad"], v["pair"], v["pos"]))


SETS = {"ip2": IP2, "ip1": IP1}


def ident(S, r):
    return r["file"] if S is IP2 else r["video_id"]


def balance(rows, unit_of, bucket_of):
    """unit 하나는 한 사람에게. bucket (condition 등) 마다 개수가 고르게, 그다음 전체가 고르게."""
    units = defaultdict(list)
    for r in rows:
        units[unit_of(r)].append(r)
    count = {a: 0 for a in ANNOTATORS}
    per = defaultdict(lambda: {a: 0 for a in ANNOTATORS})
    assign = {}
    for u in sorted(units):
        b = bucket_of(u)
        a = min(ANNOTATORS, key=lambda x: (per[b][x], count[x], x))
        for r in units[u]:
            assign[r["_id"]] = a
        per[b][a] += len(units[u])
        count[a] += len(units[u])
    return assign, count, per


def scene_key(s):
    head, _, tail = s.partition("_")
    return (int(head), int(tail or -1))


def encode(S, r):
    src, dst = os.path.join(ROOT, r["src"]), os.path.join(ROOT, r["clip"])
    if os.path.exists(dst) and probe(dst)["nb_frames"] == r["n"]:
        return "skip"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-an",
         "-fps_mode", "passthrough", "-vf", f"setpts=N/({S.fps}*TB)",
         "-c:v", "libx264", "-preset", "slow", "-crf", str(S.crf), "-bf", "0", "-g", str(S.gop),
         "-pix_fmt", "yuv420p", "-video_track_timescale", "15360", "-movflags", "+faststart", tmp],
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


def build(S, args):
    rows = S.rows()
    for r in rows:
        r["_id"] = ident(S, r)
    if not args.skip_encode:
        with ThreadPoolExecutor(args.jobs) as ex:
            res = list(ex.map(lambda r: encode(S, r), rows))
        print(f"[{S.key}] encode: {res.count('done')} 새로, {res.count('skip')} 건너뜀")
    with ThreadPoolExecutor(args.jobs) as ex:
        probes = list(ex.map(lambda r: probe(os.path.join(ROOT, r["clip"])), rows))
    bad = [(r["clip"], p, r["n"]) for r, p in zip(rows, probes)
           if p["start"] != 0 or p["bframes"] != 0 or p["nb_frames"] != r["n"]]
    if bad:
        for b in bad[:10]:
            print("검증 실패:", b)
        raise SystemExit(f"[{S.key}] {len(bad)} 개 검증 실패")
    print(f"[{S.key}] verify: {len(rows)} 개 모두 start=0 · B-frame 없음 · 프레임 수 일치")

    assign, count, per = S.partition(rows)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", S.manifest), "w") as f:
        f.write("// tools/build_site.py 가 만든 파일. 직접 고치지 말 것.\n")
        f.write(f"window.{S.var} = ")
        json.dump({"fps": S.fps, "annotators": ANNOTATORS, "videos": S.videos(rows, assign)},
                  f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"[{S.key}] partition:", count)
    for b, d in sorted(per.items()):
        print(f"  {str(b):28s}", d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["all", *SETS], default="all")
    ap.add_argument("--skip-encode", action="store_true")
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    args = ap.parse_args()
    for key, S in SETS.items():
        if args.set in ("all", key):
            build(S, args)


if __name__ == "__main__":
    main()
