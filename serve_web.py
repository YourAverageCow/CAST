#!/usr/bin/env python3
"""Zero-install static server for the web version.

Run:  python3 serve_web.py
Then open http://localhost:8123
Everything (TTS engine, video engine, UI) is served from the web/ folder.
"""
import http.server
import socketserver
import os
from pathlib import Path

PORT = 8123
ROOT = Path(__file__).parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Allow the wasm/worker assets to be used cross-origin-free.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")


if __name__ == "__main__":
    print(f"Serving AITAH Video Creator (web) at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
