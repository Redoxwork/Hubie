#!/usr/bin/env bash
# Hubie server setup. Safe to run again (it only adds what's missing).
#   curl -fsSL https://raw.githubusercontent.com/Redoxwork/Hubie/main/server/setup.sh | bash
set -euo pipefail
REPO=https://github.com/Redoxwork/Hubie
H=/opt/hubie
export DEBIAN_FRONTEND=noninteractive
say(){ printf '\n\033[1;32m== %s\033[0m\n' "$*"; }

say "1/7 system packages"
apt-get update -q
apt-get install -y -q git curl wget ca-certificates xvfb x11-utils ffmpeg nodejs npm python3 \
  fonts-liberation fonts-noto-color-emoji ufw
# audio: optional, the stream falls back to silent audio if this is missing
apt-get install -y -q pulseaudio pulseaudio-utils || echo "WARN: pulseaudio not installed (stream will be silent for now)"

say "2/7 google chrome"
if ! command -v google-chrome >/dev/null; then
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -q /tmp/chrome.deb
fi
google-chrome --version

say "3/7 hubie user + code"
id hubie >/dev/null 2>&1 || useradd -m -s /bin/bash hubie
git config --global --add safe.directory "$H" 2>/dev/null || true
if [ -d "$H/.git" ]; then { git -C "$H" fetch -q origin main && git -C "$H" reset -q --hard origin/main; }; else rm -rf "$H"; git clone --depth 1 "$REPO" "$H"; fi
mkdir -p "$H/data" "$H/shots" "$H/logs" "$H/bin"

say "4/7 node packages"
(cd "$H/server" && npm install --omit=dev --no-audit --no-fund)

say "5/7 local relay (mediamtx)"
if [ ! -x "$H/bin/mediamtx" ]; then
  url=$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest | python3 -c \
    'import json,sys; print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("linux_amd64.tar.gz")][0])')
  curl -fsSL "$url" | tar -xz -C "$H/bin" mediamtx mediamtx.yml
fi
"$H/bin/mediamtx" --version || true

say "6/7 secrets file + firewall"
touch /etc/hubie.env; chown root:hubie /etc/hubie.env; chmod 640 /etc/hubie.env
ufw allow OpenSSH >/dev/null; ufw allow 8080/tcp >/dev/null; ufw --force enable >/dev/null; ufw status | head -5

say "7/8 hubie command"
chmod +x "$H/server/hubie" "$H/server/"*.sh
ln -sf "$H/server/hubie" /usr/local/bin/hubie
chown -R hubie:hubie "$H"

say "8/8 brain service + https for Kick (caddy)"
IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
HOST="${IP//./-}.sslip.io"
apt-get install -y -q caddy
printf '%s {\n\thandle /kick/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle {\n\t\trespond "hubie" 200\n\t}\n}\n' "$HOST" > /etc/caddy/Caddyfile
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
systemctl enable caddy >/dev/null 2>&1; systemctl restart caddy
cp "$H/server/hubie-brain.service" "$H/server/hubie-live.service" /etc/systemd/system/; mkdir -p "$H/recordings"; chown -R hubie:hubie "$H"
systemctl daemon-reload; systemctl enable hubie-brain >/dev/null 2>&1; systemctl restart hubie-brain
sleep 2; systemctl is-active hubie-brain >/dev/null && echo "brain running · Kick webhook: https://$HOST/kick/webhook"

say "SETUP-OK"
echo "Next: hubie secrets"
