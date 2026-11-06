#!/usr/bin/env bash
# hubie login-view [stop]
# Opens Hubie's own game Chrome (same profile the stream uses, through the proxy) on a
# private web page you can open on your phone, so you can tick the captcha and log in by hand once.
# The login is saved in the profile, so the live stream starts already logged in.
set -uo pipefail
H=/opt/hubie
RUN=/tmp/hubie-loginview
CADDY=/etc/caddy/Caddyfile
HOST=$(head -1 "$CADDY" | tr -d ' {')

caddy_plain(){
  printf '%s {\n\thandle /kick/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle {\n\t\trespond "hubie" 200\n\t}\n}\n' "$HOST" > "$CADDY"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}
stop_all(){
  pkill -f "x11vnc.*:97" 2>/dev/null; pkill -f "websockify.*6080" 2>/dev/null
  pkill -f "chrome-live-game" 2>/dev/null; pkill -f "proxy.js" 2>/dev/null; pkill -f "Xvfb :97" 2>/dev/null
  rm -rf "$RUN"; caddy_plain
}

if [ "${1:-}" = stop ]; then
  stop_all; echo "Login view closed. Next: hubie games on  then  hubie live"; exit 0
fi

set -a; . /etc/hubie.env; set +a
[ -z "${HUBIE_PROXY:-}" ] && { echo "Set the proxy first: hubie proxy http://USER:PASS@IP:PORT"; exit 1; }

# the stream uses the same browser profile, so it must be off while you log in
if systemctl is-active --quiet hubie-live; then echo "Stopping the stream while you log in..."; systemctl stop hubie-live; fi
stop_all

if ! command -v x11vnc >/dev/null || ! command -v websockify >/dev/null || [ ! -f /usr/share/novnc/vnc.html ]; then
  echo "Installing the screen viewer (one time)..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q x11vnc novnc websockify >/dev/null || { echo "install failed"; exit 1; }
fi

mkdir -p "$RUN"; chown hubie:hubie "$RUN"
TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')

Xvfb :97 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
sleep 1
runuser -u hubie -- env HUBIE_PROXY="$HUBIE_PROXY" HUBIE_PROXY_ONLY="${HUBIE_PROXY_ONLY:-housebets.com}" \
  bash -c "cd $H/server && nohup node proxy.js >$RUN/proxy.log 2>&1 &"
sleep 1
runuser -u hubie -- env DISPLAY=:97 HOME=/home/hubie bash -c "nohup google-chrome --no-sandbox --test-type --no-first-run \
  --no-default-browser-check --disable-dev-shm-usage --window-position=0,0 --window-size=1280,720 \
  --user-data-dir=$H/data/chrome-live-game --proxy-server=http://127.0.0.1:8899 --proxy-bypass-list='<-loopback>' \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp https://www.housebets.com/ >$RUN/chrome.log 2>&1 &"
x11vnc -display :97 -localhost -nopw -forever -shared -rfbport 5900 -quiet -bg -o "$RUN/vnc.log" >/dev/null 2>&1
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >"$RUN/ws.log" 2>&1 &
sleep 2

# private link: only someone with the random token can open it
printf '%s {\n\thandle /kick/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle_path /v-%s/* {\n\t\treverse_proxy 127.0.0.1:6080\n\t}\n\thandle {\n\t\trespond "hubie" 200\n\t}\n}\n' "$HOST" "$TOKEN" > "$CADDY"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo
echo "Open this on your phone (keep it private):"
echo "  https://$HOST/v-$TOKEN/vnc.html?path=v-$TOKEN/websockify&autoconnect=1&resize=scale"
echo
echo "Then: tick the 'verify you are human' box, Log In with your main account, wait for the lobby."
echo "Keyboard: tap the small tab on the left edge of the viewer > keyboard icon."
echo "When you're logged in, come back here and run:  hubie login-view stop"
