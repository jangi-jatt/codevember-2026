"""Static dev server for the project (port 8123) that tells the browser never to cache, so edits always show up."""
import http.server
import socketserver


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", 8123), Handler) as server:
    server.serve_forever()
