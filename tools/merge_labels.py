"""공유 시트 (또는 작업자들이 내보낸 CSV) 의 라벨을 합친다.

IntPhys 2 → labels.csv
  python tools/merge_labels.py "<SYNC_URL>?format=csv"     # 시트에서 바로 → labels_merged.csv
  python tools/merge_labels.py exports/*.csv               # 내보낸 CSV 들 → labels_merged.csv
  python tools/merge_labels.py ... --inplace               # → labels.csv 덮어쓰기
  note 에는 "가림 뒤" · "못 찾음" 표시를 앞에 붙인다. annotator 열을 더한다.

IntPhys 1 → intphys1_occluded/index.csv 에 사람 라벨 열을 붙인 intphys1_occluded/labels_merged.csv
  python tools/merge_labels.py --set ip1 "<SYNC_URL>?set=ip1&format=csv"
  같은 쌍끼리 정지 / 움직임이 다르거나, 묶음 (group) 과 다르거나, 시작이 많이 벌어지면 알려 준다.

같은 영상이 여러 파일에 있으면 updated_at 이 가장 늦은 것을 쓴다.
"""
import argparse
import csv
import io
import os
import sys
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def compose_note(r):
    tags = []
    if r["occluded"] == "1":
        tags.append("가림 뒤")
    if r["not_found"] == "1":
        tags.append("못 찾음")
    note = r["note"].strip()
    tags = [t for t in tags if t not in note]
    return " · ".join(tags + ([note] if note else []))


def open_source(path):
    if path.startswith(("http://", "https://")):
        with urllib.request.urlopen(path) as res:
            return io.StringIO(res.read().decode("utf-8-sig"))
    return open(path, encoding="utf-8-sig")


def latest_of(paths, key):
    """파일들에서 영상마다 updated_at 이 가장 늦은 행."""
    latest = {}
    for path in paths:
        with open_source(path) as f:
            for r in csv.DictReader(f):
                old = latest.get(r[key])
                if old and old["annotator"] != r["annotator"]:
                    print(f"경고: {r[key]} 를 {old['annotator']} · {r['annotator']} 둘 다 표시함 (늦은 쪽 사용)")
                if not old or r["updated_at"] > old["updated_at"]:
                    latest[r[key]] = r
    return latest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exports", nargs="+")
    ap.add_argument("--set", choices=["ip2", "ip1"], default="ip2")
    ap.add_argument("--inplace", action="store_true", help="ip2 만: labels.csv 를 덮어쓴다")
    args = ap.parse_args()
    (merge_ip1 if args.set == "ip1" else merge_ip2)(args)


def merge_ip2(args):
    src = os.path.join(ROOT, "labels.csv")
    with open(src, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames)
        rows = list(reader)
    by_file = {r["file"]: r for r in rows}
    if "annotator" not in fields:
        fields.append("annotator")

    latest = {k: r for k, r in latest_of(args.exports, "file").items()
              if r["violation_start_frame"] or r["violation_end_frame"] or r["note"] or r["not_found"] == "1" or r["occluded"] == "1"}
    for k in latest:
        if k not in by_file:
            sys.exit(f"labels.csv 에 없는 영상 {k}")

    problems = []
    for file, r in latest.items():
        row = by_file[file]
        n = int(row["n_frames"])
        s, e = r["violation_start_frame"], r["violation_end_frame"]
        for name, v in (("start", s), ("end", e)):
            if v and not (v.isdigit() and int(v) < n):
                problems.append(f"{file}: {name}={v} 가 0–{n - 1} 밖")
        if s and e and s.isdigit() and e.isdigit() and int(e) < int(s):
            problems.append(f"{file}: end {e} < start {s}")
        if r["not_found"] != "1" and not (s and e):
            problems.append(f"{file}: 시작 · 끝 중 비어 있음 ({r['annotator']})")
        row["violation_start_frame"], row["violation_end_frame"] = s, e
        row["note"] = compose_note(r)
        row["annotator"] = r["annotator"]

    out = src if args.inplace else os.path.join(ROOT, "labels_merged.csv")
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in fields})

    done = Counter(r["annotator"] for r in latest.values())
    nf = sum(r["not_found"] == "1" for r in latest.values())
    print(f"{out}: {len(latest)} / {len(rows)} 개 채움 (못 찾음 {nf}) · 작업자별 {dict(sorted(done.items()))}")
    for p in problems:
        print("확인 필요:", p)


IP1_COLS = ["annotator", "object_motion", "start_frame", "end_frame", "note", "not_found", "updated_at"]


def merge_ip1(args):
    src = os.path.join(ROOT, "intphys1_occluded", "index.csv")
    with open(src, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames) + IP1_COLS
        rows = list(reader)
    by_id = {r["video_id"]: r for r in rows}
    latest = {k: r for k, r in latest_of(args.exports, "video_id").items()
              if r["object_motion"] or r["start_frame"] or r["end_frame"] or r["note"] or r["not_found"] == "1"}

    problems = []
    for vid, r in latest.items():
        if vid not in by_id:
            sys.exit(f"index.csv 에 없는 영상 {vid}")
        s, e = r["start_frame"], r["end_frame"]
        if s and e and int(e) < int(s):
            problems.append(f"{vid}: end {e} < start {s}")
        if r["not_found"] != "1" and not (s and e):
            problems.append(f"{vid}: 시작 · 끝 중 비어 있음 ({r['annotator']})")
        if not r["object_motion"]:
            problems.append(f"{vid}: 정지 / 움직임 비어 있음 ({r['annotator']})")
        for c in IP1_COLS:
            by_id[vid][c] = r[c]

    # 쌍끼리 · 묶음 정보와 맞는지
    pairs = defaultdict(list)
    for r in rows:
        pairs[(r["block_type"], r["quadruplet"], r["pair_id"])].append(r)
    gaps = []
    for key, (a, b) in ((k, sorted(v, key=lambda r: r["plausible"])) for k, v in pairs.items()):
        name = f"{key[0]}_{key[1]} 쌍 {key[2]}"
        if a.get("object_motion") and b.get("object_motion") and a["object_motion"] != b["object_motion"]:
            problems.append(f"{name}: 정지 / 움직임이 다름 ({a['video_id']} {a['object_motion']} · {b['video_id']} {b['object_motion']})")
        if a.get("start_frame") and b.get("start_frame"):
            gaps.append(abs(int(a["start_frame"]) - int(b["start_frame"])))
            if gaps[-1] > 3:
                problems.append(f"{name}: 가능 · 불가능 시작이 {gaps[-1]} 프레임 벌어짐")
    for r in rows:
        mo = r.get("object_motion")
        if mo and mo != r["group"].split("/")[0]:  # group = moving/occluded · static/occluded
            problems.append(f"{r['video_id']}: 사람은 {mo}, 묶음은 {r['group']}")

    out = os.path.join(ROOT, "intphys1_occluded", "labels_merged.csv")
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in fields})

    done = Counter(r["annotator"] for r in latest.values())
    nf = sum(r["not_found"] == "1" for r in latest.values())
    print(f"{out}: {len(latest)} / {len(rows)} 개 채움 (못 찾음 {nf}) · 작업자별 {dict(sorted(done.items()))}")
    if gaps:
        print(f"쌍 시작 차이: 같음 {gaps.count(0)} / {len(gaps)} 쌍, 최대 {max(gaps)} 프레임")
    for p in problems:
        print("확인 필요:", p)


if __name__ == "__main__":
    main()
