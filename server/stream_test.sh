#!/usr/bin/env bash
# Stream test: Housebets (Chrome) + Hubie avatar -> local relay -> Kick.
# Halfway through it cuts the Kick connection on purpose to prove it reconnects with no human.
#
#   screen :99  Housebets in Chrome (later: driven by the game bot)
#   screen :98  Hubie avatar on flat green (keyed out by ffmpeg)
#   renderer    ffmpeg: grabs both screens + audio, keys out green, encodes, sends to the local relay
#   relay       mediamtx on 127.0.0.1:1935 (never needs restarting)
#   pusher      ffmpeg: copies the relay to Kick; if Kick drops, only this restarts
set -u
MINS="${1:-6}"
H=/opt/hubie
set -a; . /etc/hubie.env; set +a
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
if [ -z "${KICK_URL:-}" ] || [ -z "${KICK_KEY:-}" ]; then log "Kick URL/key missing. Run: hubie secrets"; exit 1; fi
BASE="${KICK_URL%/}"
# Kick's ingest needs /app before the key (rtmps://...live-video.net/app/<key>); add it if the saved URL lacks it
case "$BASE" in */app) ;; *) BASE="$BASE/app" ;; esac
DEST="$BASE/${KICK_KEY}"
hide(){ sed -u "s#${KICK_KEY}#sk_****(hidden)#g"; }   # never print the stream key
RELAY=rtmp://127.0.0.1:1935/hubie

RUN=/tmp/hubie-run; rm -rf "$RUN"; mkdir -p "$RUN"; chmod 700 "$RUN"
export XDG_RUNTIME_DIR="$RUN"
trap 'trap - EXIT TERM INT; log "test ending, cleaning up"; kill 0 2>/dev/null' EXIT TERM INT

log "starting virtual screens"
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
Xvfb :98 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
sleep 2

AUDIO_IN=(-f lavfi -i anullsrc=r=44100:cl=stereo)
if command -v pulseaudio >/dev/null && pulseaudio --daemonize=yes --exit-idle-time=-1 >/dev/null 2>&1; then
  sleep 1
  if pactl load-module module-null-sink sink_name=hubie >/dev/null 2>&1 && pactl set-default-sink hubie; then
    AUDIO_IN=(-f pulse -i hubie.monitor); log "audio: game sound via pulseaudio"
  fi
fi
[ "${AUDIO_IN[1]}" = lavfi ] && log "audio: silent (pulseaudio not available)"

log "starting chrome windows"
CH=(google-chrome --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage
    --disable-features=Translate --autoplay-policy=no-user-gesture-required --force-device-scale-factor=1
    --window-position=0,0 --window-size=1280,720 --kiosk)
DISPLAY=:99 "${CH[@]}" --user-data-dir="$RUN/chrome-game" "https://www.housebets.com/" >/dev/null 2>&1 &
AV="file://$H/avatar/hubie-avatar-demo.html?overlay=1&keyed=1"
if curl -fs http://127.0.0.1:8090/health >/dev/null; then
  AV="http://127.0.0.1:8090/avatar/hubie-avatar-demo.html?overlay=1&keyed=1&ws=ws://127.0.0.1:8090/ws"; log "avatar: connected to Hubie's brain"
else log "avatar: brain not running (avatar only, no talking)"; fi
DISPLAY=:98 "${CH[@]}" --user-data-dir="$RUN/chrome-avatar" "$AV" >/dev/null 2>&1 &
sleep 8

log "starting local relay"
(cd "$H/bin" && exec ./mediamtx) >"$RUN/relay.log" 2>&1 &
sleep 2

FONT=/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf
renderer(){
  while :; do
    ffmpeg -hide_banner -loglevel error -nostdin \
      -thread_queue_size 1024 -f x11grab -framerate 30 -video_size 1280x720 -draw_mouse 0 -i :99 \
      -thread_queue_size 1024 -f x11grab -framerate 30 -video_size 1280x720 -draw_mouse 0 -i :98 \
      -thread_queue_size 1024 "${AUDIO_IN[@]}" \
      -filter_complex "[1:v]colorkey=0x00FF00:0.30:0.08[av];[0:v][av]overlay=format=auto,drawtext=fontfile=$FONT:text='%{localtime} UTC  stream test':x=12:y=12:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6,format=yuv420p[v]" \
      -map "[v]" -map 2:a -af aresample=async=1000 -fps_mode cfr -r 30 \
      -c:v libx264 -preset veryfast -tune zerolatency -bf 0 -b:v 2500k -maxrate 2500k -bufsize 5000k \
      -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -f flv "$RELAY"
    log "renderer stopped (code $?), restarting in 1s"; sleep 1
  done
}
pusher(){
  while :; do
    log "pusher: sending to Kick ($BASE/sk_****)"
    ffmpeg -hide_banner -loglevel error -nostdin -i "$RELAY" -c copy -f flv "$DEST" 2>&1 | hide
    log "pusher: Kick connection ended (code ${PIPESTATUS[0]}), reconnecting in 2s"; sleep 2
  done
}
renderer & sleep 4
pusher &

( while :; do sleep 30; log "cpu load: $(cut -d' ' -f1-3 /proc/loadavg)  (4 cores = 4.0 max)"; done ) &

total=$(( MINS * 60 )); half=$(( total / 2 ))
sleep "$half"
log "KILL TEST: cutting the Kick connection on purpose now"
pkill -f -- "-c copy -f flv" || true
sleep $(( total - half ))
log "STREAM TEST DONE ($MINS min)"
