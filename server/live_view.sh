#!/usr/bin/env bash
set -uo pipefail
RUN=/tmp/hubie-liveview
CADDY=/etc/caddy/Caddyfile
HOST=$(head -1 "$CADDY" | tr -d ' {')
plain(){
  printf '%s {\n\thandle /kick/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle {\n\t\trespond "hubie" 200\n\t}\n}\n' "$HOST" > "$CADDY"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}
stop_all(){
  pkill -f "x11vnc.*:99" 2>/dev/null; pkill -f "websockify.*6080" 2>/dev/null
  rm -rf "$RUN"; plain
}
if [ "${1:-}" = stop ]; then stop_all; echo "Live view closed."; exit 0; fi
stop_all; mkdir -p "$RUN"
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
x11vnc -noshm -display :99 -localhost -nopw -forever -shared -rfbport 5900 -quiet -bg -o "$RUN/vnc.log" >/dev/null 2>&1
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >"$RUN/ws.log" 2>&1 &
sleep 2
printf '%s {\n\thandle /kick/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle_path /v-%s/* {\n\t\treverse_proxy 127.0.0.1:6080\n\t}\n\thandle {\n\t\trespond "hubie" 200\n\t}\n}\n' "$HOST" "$TOKEN" > "$CADDY"
systemctl reload caddy 2>/dev/null || systemctl restart caddy
echo; echo "Open this on your phone (keep it private):"
echo "  https://$HOST/v-$TOKEN/vnc.html?path=v-$TOKEN/websockify&autoconnect=1&resize=scale"
echo "When done: bash /opt/hubie/server/live_view.sh stop"
