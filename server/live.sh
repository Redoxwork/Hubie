#!/usr/bin/env bash
# Hubie LIVE: the non-stop stream. Runs as the hubie-live service (started with: hubie live).
#
#   screen :99   Housebets in Chrome (game window; the popup keeper / game bot drive it over port 9222)
#   screen :98   Hubie avatar on flat green (keyed out), connected to the brain
#   renderer     ffmpeg: both screens + audio -> local relay
#   relay        mediamtx on 127.0.0.1:1935 (+ backup recording, 48 h)
#   pusher       ffmpeg: relay -> Kick; if Kick drops, only this restarts
#   watchdog     every 15 s: restarts any part that died; fresh game window every 3 h
set -u
H=/opt/hubie
set -a; . /etc/hubie.env; set +a
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
if [ -z "${KICK_URL:-}" ] || [ -z "${KICK_KEY:-}" ]; then log "Kick URL/key missing. Run: hubie secrets"; sleep 60; exit 1; fi
BASE="${KICK_URL%/}"; case "$BASE" in */app) ;; *) BASE="$BASE/app" ;; esac
DEST="$BASE/${KICK_KEY}"
hide(){ sed -u "s#${KICK_KEY}#sk_****(hidden)#g"; }
RELAY=rtmp://127.0.0.1:1935/hubie
GAME_URL="${HUBIE_GAME_URL:-https://www.housebets.com/casino}"

RUN=/tmp/hubie-run; rm -rf "$RUN"; mkdir -p "$RUN" "$H/data" "$H/recordings"; chmod 700 "$RUN"
export XDG_RUNTIME_DIR="$RUN"
trap 'trap - EXIT TERM INT; log "live stopping, cleaning up"; kill 0 2>/dev/null' EXIT TERM INT
[ -s "$H/data/live-since" ] || date +%s > "$H/data/live-since"

# ---------- parts ----------
start_xvfb(){ Xvfb ":$1" -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 & echo $!; }

AUDIO_IN=(-f lavfi -i anullsrc=r=44100:cl=stereo)
if command -v pulseaudio >/dev/null && pulseaudio --daemonize=yes --exit-idle-time=-1 >/dev/null 2>&1; then
  sleep 1
  if pactl load-module module-null-sink sink_name=hubie >/dev/null 2>&1 && pactl set-default-sink hubie; then
    AUDIO_IN=(-f pulse -i hubie.monitor); log "audio: via pulseaudio"
  fi
fi

CH=(google-chrome --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage
    --disable-features=Translate,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required
    --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows
    --force-device-scale-factor=1 --window-position=0,0 --window-size=1280,720 --kiosk --remote-allow-origins=*)
start_game(){
  # the profile is kept between restarts so the Housebets login + cookies survive
  DISPLAY=:99 nice -n 5 "${CH[@]}" --user-data-dir="$H/data/chrome-live-game" --remote-debugging-port=9222 "$GAME_URL" >/dev/null 2>&1 & echo $!
}
start_avatar(){
  local av="file://$H/avatar/hubie-avatar-demo.html?overlay=1&keyed=1"
  curl -fs http://127.0.0.1:8090/health >/dev/null && av="http://127.0.0.1:8090/avatar/hubie-avatar-demo.html?overlay=1&keyed=1&ws=ws://127.0.0.1:8090/ws"
  DISPLAY=:98 "${CH[@]}" --user-data-dir="$RUN/chrome-avatar" --remote-debugging-port=9223 "$av" >/dev/null 2>&1 & echo $!
}
start_relay(){
  ( cd "$H/bin" && exec ./mediamtx "$H/server/mediamtx.yml" ) >>"$RUN/relay.log" 2>&1 & local p=$!
  sleep 3
  if ! kill -0 $p 2>/dev/null; then   # our config refused: fall back to the default one (no backup recording)
    log "relay: custom config failed, using default ($(tail -2 "$RUN/relay.log" | tr '\n' ' '))"
    ( cd "$H/bin" && exec ./mediamtx ) >>"$RUN/relay.log" 2>&1 & p=$!
  fi
  echo $p
}

# on-screen uptime ("live for 12h 03m")
uptime_text(){
  local s=$(( $(date +%s) - $(cat "$H/data/live-since") ))
  printf 'LIVE 24/7  ·  up %dh %02dm' $(( s / 3600 )) $(( s % 3600 / 60 )) > "$RUN/uptime.tmp" && mv "$RUN/uptime.tmp" "$RUN/uptime.txt"
}
uptime_text

FONT=/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf
[ -f "$FONT" ] || FONT=/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf
LABEL=",drawtext=fontfile=$FONT:textfile=$RUN/uptime.txt:reload=1:x=12:y=h-th-40:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6"
[ "${SHOW_UPTIME:-1}" = 0 ] && LABEL=""
renderer(){
  while :; do
    ffmpeg -hide_banner -loglevel error -nostdin \
      -thread_queue_size 1024 -f x11grab -framerate 30 -video_size 1280x720 -draw_mouse 0 -i :99 \
      -thread_queue_size 1024 -f x11grab -framerate 30 -video_size 1280x720 -draw_mouse 0 -i :98 \
      -thread_queue_size 1024 "${AUDIO_IN[@]}" \
      -filter_complex "[1:v]colorkey=0x00FF00:0.30:0.08[av];[0:v][av]overlay=format=auto${LABEL},format=yuv420p[v]" \
      -map "[v]" -map 2:a -af aresample=async=1000 -fps_mode cfr -r 30 \
      -c:v libx264 -preset veryfast -tune zerolatency -bf 0 -b:v ${VBITRATE:-4500}k -maxrate ${VBITRATE:-4500}k -bufsize $(( ${VBITRATE:-4500} * 2 ))k \
      -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -f flv "$RELAY"
    log "renderer stopped (code $?), restarting"; sleep 2
  done
}
pusher(){
  while :; do
    log "pusher: sending to Kick"
    ffmpeg -hide_banner -loglevel error -nostdin -i "$RELAY" -c copy -f flv "$DEST" 2>&1 | hide
    log "pusher: Kick connection ended (code ${PIPESTATUS[0]}), reconnecting"; sleep 2
  done
}
keeper(){
  while :; do
    (cd "$H/server" && node game/keeper.js) 2>&1
    log "keeper stopped, restarting"; sleep 5
  done
}

# ---------- start ----------
log "starting Hubie LIVE"
X99=$(start_xvfb 99); X98=$(start_xvfb 98); sleep 2
GAME=$(start_game); AVATAR=$(start_avatar); sleep 8
RELAYP=$(start_relay)
renderer & REND=$!
sleep 4
pusher & PUSH=$!
keeper & KEEP=$!
GAME_STARTED=$(date +%s)

# ---------- watchdog ----------
alive(){ kill -0 "$1" 2>/dev/null; }
n=0
while :; do
  sleep 15; n=$((n + 1))
  uptime_text
  if ! alive "$X99"; then log "watchdog: game screen died, restarting"; X99=$(start_xvfb 99); sleep 2; fi
  if ! alive "$X98"; then log "watchdog: avatar screen died, restarting"; X98=$(start_xvfb 98); sleep 2; fi
  if ! alive "$GAME"; then log "watchdog: game window died, restarting"; GAME=$(start_game); GAME_STARTED=$(date +%s); fi
  if ! alive "$AVATAR"; then log "watchdog: avatar window died, restarting"; AVATAR=$(start_avatar); fi
  if ! alive "$RELAYP"; then log "watchdog: relay died, restarting"; RELAYP=$(start_relay); fi
  if ! alive "$REND"; then log "watchdog: renderer loop died, restarting"; renderer & REND=$!; fi
  if ! alive "$PUSH"; then log "watchdog: pusher loop died, restarting"; pusher & PUSH=$!; fi
  if ! alive "$KEEP"; then log "watchdog: keeper loop died, restarting"; keeper & KEEP=$!; fi
  # fresh game window every 3 hours (Chrome gets slow over very long runs)
  if [ $(( $(date +%s) - GAME_STARTED )) -gt 10800 ]; then
    log "watchdog: scheduled fresh game window"; kill "$GAME" 2>/dev/null; sleep 3; GAME=$(start_game); GAME_STARTED=$(date +%s)
  fi
  if [ $((n % 20)) -eq 0 ]; then
    log "health: cpu $(cut -d' ' -f1-3 /proc/loadavg) · mem free $(free -m | awk '/Mem/{print $7}') MB · disk free $(df -h "$H" | awk 'NR==2{print $4}') · $(cat "$RUN/uptime.txt")"
  fi
done
