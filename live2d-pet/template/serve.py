"""极简本地服务器：为 .mjs / .wasm 提供正确的 MIME 类型。"""
import http.server, socketserver, os, sys, mimetypes

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/json", ".json")

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    """支持 Range 请求：MediaPipe 的 wasm 加载器会发 Range，返回 206 更稳。"""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # 允许 wasm 多线程所需的头（若不用可忽略）
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # 三层禁用缓存：no-store + 老式 Pragma/Expires，尽量覆盖各种浏览器行为
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def _build_tag(self):
        """把所有前端源文件的最新修改时间合成一个版本号。"""
        newest = 0.0
        for rel in ("index.html", "src/main.js", "src/rig.js", "src/deformer.js",
                    "src/renderer.js", "src/tracking.js", "src/style.css"):
            p = os.path.join(ROOT, rel)
            try:
                newest = max(newest, os.path.getmtime(p))
            except OSError:
                pass
        return str(int(newest))

    def do_GET(self):
        # 单独的版本号接口：前端用它判断自己是不是缓存的旧代码
        if self.path.split("?")[0] == "/build.json":
            body = ('{"build":"%s"}' % self._build_tag()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        """对 index.html 做一次「注入版本号」的重写，实现强制缓存失效。

        目的：浏览器即使缓存了旧的 JS，只要每次 HTML 里的
        `src/main.js?v=<mtime>` 变化，就会重新拉取整条模块依赖链 ——
        避免出现「已经改好了但用户看到的还是旧代码」这种问题。
        """
        path = self.translate_path(self.path.split("?")[0])
        base = os.path.basename(path)
        v = self._build_tag()

        # ① index.html：注入带版本号的资源引用 + 版本徽章
        if os.path.isfile(path) and base == "index.html":
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    html = fh.read()
                html = html.replace('href="./src/style.css"', 'href="./src/style.css?v=%s"' % v)
                html = html.replace('src="./src/main.js"', 'src="./src/main.js?v=%s"' % v)
                html = html.replace("__BUILD__", v)
                return self._send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
            except OSError:
                pass

        # ② main.js：把 `__BUILD__` 常量替换成真实版本号。
        #    这样「浏览器实际执行的 JS」自带它的版本，
        #    与 /build.json 比对即可**可靠地**判断 JS 是不是缓存的旧版 ——
        #    比依赖 index.html 是否新鲜更可信（HTML 和 JS 可能各自被缓存）。
        if os.path.isfile(path) and base == "main.js":
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    js = fh.read()
                if "__BUILD__" in js:
                    js = js.replace("__BUILD__", v)
                return self._send_bytes(js.encode("utf-8"), "text/javascript; charset=utf-8")
            except OSError:
                pass

        return super().do_GET()

    def _send_bytes(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return

    def send_head(self):
        """实现单段 Range（bytes=a-b），其余交给父类。"""
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            size = os.fstat(f.fileno()).st_size
            m = rng.strip().replace("bytes=", "")
            if "," in m:                      # 多段 Range 不支持，退回整体
                f.close()
                return super().send_head()
            start_s, _, end_s = m.partition("-")
            if start_s == "":                 # bytes=-N 取末尾 N 字节
                length = int(end_s or 0)
                start = max(0, size - length)
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                f.close()
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.end_headers()
                return None

            self.send_response(206)
            ctype = self.guess_type(path)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            f.seek(start)
            return _RangeReader(f, end - start + 1)
        except Exception:
            f.close()
            raise


class _RangeReader:
    """把文件的一段暴露成像文件对象，供 copyfile 使用。"""

    def __init__(self, f, remaining):
        self.f = f
        self.remaining = remaining

    def read(self, n=-1):
        if self.remaining <= 0:
            return b""
        if n is None or n < 0 or n > self.remaining:
            n = self.remaining
        data = self.f.read(n)
        self.remaining -= len(data)
        return data

    def close(self):
        self.f.close()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", PORT), Handler) as httpd:
    print("皮套服务已启动: http://127.0.0.1:%d/" % PORT, flush=True)
    httpd.serve_forever()
