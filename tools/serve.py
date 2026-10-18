"""로컬 미리보기 서버. python -m http.server 는 Range 요청을 안 받아서 브라우저가 영상 안에서 이동하지 못한다.

  python tools/serve.py          # http://127.0.0.1:8000
  python tools/serve.py 8080
"""
import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def send_head(self):
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m[1]) if m[1] else max(0, size - int(m[2]))
        end = min(int(m[2]), size - 1) if m[1] and m[2] else size - 1
        if start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.remaining = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = getattr(self, "remaining", None)
        if n is None:
            return super().copyfile(src, dst)
        while n > 0:
            buf = src.read(min(1 << 16, n))
            if not buf:
                break
            dst.write(buf)
            n -= len(buf)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"http://127.0.0.1:{port}/")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
