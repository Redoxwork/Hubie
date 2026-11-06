#!/usr/bin/env bash
# Hourly: turn each finished 1-hour recording into a small 480p copy in /opt/hubie/archive (kept 10 days).
# This is the proof of the whole run: Kick only keeps the first 48 h of a stream as a VOD.
H=/opt/hubie; SRC="$H/recordings/hubie"; DST="$H/archive"
mkdir -p "$DST"
for f in $(find "$SRC" -name '*.mp4' -mmin +65 2>/dev/null | sort); do
  out="$DST/$(basename "${f%.*}")-480p.mp4"
  [ -s "$out" ] && continue
  nice -n 19 ffmpeg -hide_banner -loglevel error -nostdin -y -threads 1 -i "$f" \
    -vf scale=-2:480 -c:v libx264 -preset veryfast -crf 30 -maxrate 700k -bufsize 1400k \
    -c:a aac -b:a 64k -movflags +faststart "$out.tmp.mp4" && mv "$out.tmp.mp4" "$out" && echo "[archive] saved $(basename "$out") ($(du -h "$out" | cut -f1))"
  rm -f "$out.tmp.mp4"
done
find "$DST" -name '*-480p.mp4' -mtime +10 -delete 2>/dev/null
