"""Local server for exercising the ESP's update downloader (HTTP, port, redirects, stalls).

  python ota_server.py IMAGE [PORT]

/fw.bin  the image, with Content-Length
/r       302 -> /fw.bin            (relative redirect)
/abs     302 -> http://HOST:PORT/fw.bin (absolute redirect on a non-default port)
/loop    302 -> /loop              (endless redirects)
/stall   200, first 4 KiB of the image, then silence for 60 s
"""
import http.server
import sys
import time

IMAGE = open(sys.argv[1], "rb").read()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8099


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        sys.stdout.write("  request line: %r  Host: %r  UA: %r\n" % (
            self.requestline, self.headers.get("Host"), self.headers.get("User-Agent")))
        if self.path == "/fw.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(IMAGE)))
            self.end_headers()
            self.wfile.write(IMAGE)
        elif self.path == "/r":
            self.redirect("/fw.bin")
        elif self.path == "/abs":
            self.redirect("http://%s/fw.bin" % self.headers.get("Host"))
        elif self.path == "/loop":
            self.redirect("/loop")
        elif self.path == "/stall":
            self.send_response(200)
            self.send_header("Content-Length", str(len(IMAGE)))
            self.end_headers()
            self.wfile.write(IMAGE[:4096])
            self.wfile.flush()
            time.sleep(60)
        else:
            self.send_error(404)


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
