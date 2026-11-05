#!/usr/bin/env bash
# Serves the newest screenshot folder on port 8080 for 10 minutes so you can view it on your phone.
set -euo pipefail
dir=$(ls -1dt /opt/hubie/shots/*/ 2>/dev/null | head -1)
[ -z "$dir" ] && { echo "No screenshots yet. Run: hubie test-login"; exit 1; }
ip=$(hostname -I | awk '{print $1}')
echo "Open in Chrome:  http://$ip:8080/"
echo "(stops by itself after 10 minutes, or press ctrl+c)"
cd "$dir" && timeout 600 python3 -m http.server 8080 >/dev/null 2>&1 || true
echo "stopped"
