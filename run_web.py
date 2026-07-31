#!/usr/bin/env python3
import subprocess
import webbrowser
import sys
import os
import time
import threading
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.resolve()
PORT = 8123


def open_browser():
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{PORT}")


def main():
    print("\n  AITAH Video Creator (Web Edition)\n")

    server = subprocess.Popen(
        [sys.executable, "serve_web.py"],
        cwd=str(PROJECT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    threading.Thread(target=open_browser, daemon=True).start()
    print(f"  Running at http://localhost:{PORT}")
    print("  Press Ctrl+C to stop\n")

    try:
        for line in server.stdout:
            print(line, end="")
    except KeyboardInterrupt:
        print("\n  Shutting down...")
        server.terminate()
        server.wait()
        print("  Done.")


if __name__ == "__main__":
    main()
