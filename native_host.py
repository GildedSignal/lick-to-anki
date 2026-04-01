#!/usr/bin/env python3
"""Native messaging host for Lick to Anki Chrome extension.
Chrome launches this on demand — no server to run.
"""

import base64
import json
import os
import struct
import subprocess
import sys

OUTPUT_DIR = os.path.expanduser("~/Music/Guitar Phrases")
os.makedirs(OUTPUT_DIR, exist_ok=True)


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("@I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(data):
    encoded = json.dumps(data).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def extract(url, start, end, name):
    filename = f"{name}.mp3"
    filepath = os.path.join(OUTPUT_DIR, filename)

    counter = 1
    while os.path.exists(filepath):
        filename = f"{name}_{counter}.mp3"
        filepath = os.path.join(OUTPUT_DIR, filename)
        counter += 1

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-x", "--audio-format", "mp3",
        "--audio-quality", "0",
        "--download-sections", f"*{start}-{end}",
        "--force-keyframes-at-cuts",
        "-o", filepath,
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    if result.returncode != 0:
        return {"error": f"yt-dlp failed: {result.stderr[-300:]}"}

    if not os.path.exists(filepath):
        return {"error": "File not created — check yt-dlp installation"}

    with open(filepath, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    return {"filename": filename, "filepath": filepath, "data": b64}


def main():
    msg = read_message()
    if not msg:
        return

    action = msg.get("action")

    if action == "ping":
        send_message({"status": "ok"})

    elif action == "extract":
        url = msg.get("url")
        start = msg.get("start")
        end = msg.get("end")
        name = msg.get("name", "phrase")

        if not all([url, start is not None, end is not None]):
            send_message({"error": "Missing url, start, or end"})
            return

        try:
            result = extract(url, start, end, name)
            send_message(result)
        except subprocess.TimeoutExpired:
            send_message({"error": "Extraction timed out (30s)"})
        except FileNotFoundError:
            send_message({"error": "yt-dlp not found. Install: brew install yt-dlp"})
        except Exception as e:
            send_message({"error": str(e)})
    else:
        send_message({"error": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
