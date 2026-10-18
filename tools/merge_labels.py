"""공유 시트 (또는 작업자들이 내보낸 CSV) 의 라벨을 labels.csv 에 합친다.

  python tools/merge_labels.py "<SYNC_URL>?format=csv"     # 시트에서 바로 → labels_merged.csv
  python tools/merge_labels.py exports/*.csv               # 내보낸 CSV 들 → labels_merged.csv
  python tools/merge_labels.py ... --inplace               # → labels.csv 덮어쓰기

같은 영상이 여러 파일에 있으면 updated_at 이 가장 늦은 것을 쓴다.
note 에는 "가림 뒤" · "못 찾음" 표시를 앞에 붙인다. annotator 열을 더한다.
"""
import argparse
import csv
import io
import os
import sys
import urllib.request
from collections import Counter

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exports", nargs="+")
    ap.add_argument("--inplace", action="store_true")
    args = ap.parse_args()

    src = os.path.join(ROOT, "labels.csv")
    with open(src, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames)
        rows = list(reader)
    by_file = {r["file"]: r for r in rows}
    if "annotator" not in fields:
        fields.append("annotator")

    latest = {}
    for path in args.exports:
        with open_source(path) as f:
            for r in csv.DictReader(f):
                if not (r["violation_start_frame"] or r["violation_end_frame"] or r["note"] or r["not_found"] == "1" or r["occluded"] == "1"):
                    continue
                if r["file"] not in by_file:
                    sys.exit(f"{path}: labels.csv 에 없는 영상 {r['file']}")
                old = latest.get(r["file"])
                if old and old["annotator"] != r["annotator"]:
                    print(f"경고: {r['file']} 를 {old['annotator']} · {r['annotator']} 둘 다 표시함 (늦은 쪽 사용)")
                if not old or r["updated_at"] > old["updated_at"]:
                    latest[r["file"]] = r

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


if __name__ == "__main__":
    main()
