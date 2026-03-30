#!/usr/bin/env python3
"""One-time setup: registers the native messaging host with Chrome/Arc/Chromium.
Run: python3 install.py <extension-id>
"""

import json
import os
import stat
import sys

HOST_NAME = "com.julien.licktoanki"
NATIVE_HOST_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native_host.py")

# All Chromium-based browser native messaging dirs on macOS
NMH_DIRS = [
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "~/Library/Application Support/Arc/User Data/NativeMessagingHosts",
    "~/Library/Application Support/Chromium/NativeMessagingHosts",
    "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "~/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
]


def main():
    if not os.path.exists(NATIVE_HOST_SCRIPT):
        print(f"ERROR: {NATIVE_HOST_SCRIPT} not found")
        sys.exit(1)

    os.chmod(NATIVE_HOST_SCRIPT, os.stat(NATIVE_HOST_SCRIPT).st_mode | stat.S_IEXEC)

    if len(sys.argv) > 1:
        ext_id = sys.argv[1].strip()
    else:
        print("Usage: python3 install.py <extension-id>")
        print("Find your extension ID at chrome://extensions (or arc://extensions)")
        sys.exit(1)

    manifest = {
        "name": HOST_NAME,
        "description": "Lick to Anki — extract YouTube audio clips",
        "path": NATIVE_HOST_SCRIPT,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"]
    }

    installed = []
    for nmh_dir in NMH_DIRS:
        nmh_dir = os.path.expanduser(nmh_dir)
        # Only install into dirs that exist (= browser is installed)
        parent = os.path.dirname(nmh_dir)
        if not os.path.isdir(parent):
            continue
        os.makedirs(nmh_dir, exist_ok=True)
        manifest_path = os.path.join(nmh_dir, f"{HOST_NAME}.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
        installed.append(manifest_path)

    if not installed:
        print("ERROR: No supported browser directories found")
        sys.exit(1)

    print(f"Extension ID: {ext_id}")
    print(f"Script: {NATIVE_HOST_SCRIPT}")
    print()
    for path in installed:
        print(f"  Installed: {path}")
    print()
    print("Done! Restart your browser.")


if __name__ == "__main__":
    main()
