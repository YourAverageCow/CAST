#!/usr/bin/env python3
import subprocess
import webbrowser
import sys
import threading
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.resolve()


def _stream_stdout(proc):
    """Read and print subprocess stdout in a background thread so that a
    silent/blocked pipe never prevents us from handling Ctrl+C in the main
    thread."""
    try:
        for line in proc.stdout:
            print(line, end="")
    except (ValueError, Exception):
        pass


def _stop_server(server: subprocess.Popen):
    """Terminate the uvicorn subprocess reliably, escalating to kill if the
    graceful terminate does not return in time."""
    if server.poll() is not None:
        return
    try:
        server.terminate()
    except Exception:
        pass
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            server.kill()
        except Exception:
            pass
        try:
            server.wait(timeout=5)
        except Exception:
            pass


def main():
    print("\n  AITAH Video Creator\n")

    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"],
        cwd=str(PROJECT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    stdout_thread = threading.Thread(target=_stream_stdout, args=(server,), daemon=True)
    stdout_thread.start()

    time.sleep(1.5)
    webbrowser.open("http://localhost:8000")

    print("  Server running at http://localhost:8000")
    print("  Press Ctrl+C to stop\n")

    try:
        while server.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n  Shutting down...")
    finally:
        _stop_server(server)
        print("  Done.")


if __name__ == "__main__":
    main()
