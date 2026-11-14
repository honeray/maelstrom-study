"""Local preview server for the MAELStrOM study site.

No build step is involved: this only serves the repository over HTTP so that
ES modules and JSON fetches work (opening index.html from disk will not).

    python tools/serve.py            # http://127.0.0.1:8080
    python tools/serve.py --port 9000

Cache headers are disabled so edits show up on refresh.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded so that a browser's parallel module requests are never refused."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quieter output
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the study site locally.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    handler = functools.partial(Handler, directory=str(ROOT))
    with Server((args.host, args.port), handler) as httpd:
        print(f"Serving {ROOT}")
        print(f"  homepage : http://{args.host}:{args.port}/")
        print(f"  round 1  : http://{args.host}:{args.port}/survey.html?s=delphi-round-1")
        print(f"  round 2  : http://{args.host}:{args.port}/survey.html?s=delphi-round-2")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
