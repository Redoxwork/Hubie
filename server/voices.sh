#!/usr/bin/env bash
# Installs two free offline voice engines (Kokoro + Piper), makes Hubie samples, and serves them for listening.
#   hubie voices
set -uo pipefail
H=/opt/hubie
V=$H/tts
OUT=$H/shots/voices-$(date +%m%d-%H%M)
mkdir -p "$V" "$OUT"
say(){ printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
get(){ [ -s "$2" ] || curl -fL --retry 3 -o "$2.part" "$1" && mv -f "$2.part" "$2" 2>/dev/null; [ -s "$2" ]; }

say "1/4 tools"
apt-get install -y -q python3-venv python3-pip ffmpeg >/dev/null

say "2/4 Kokoro (natural voice, ~330 MB download, first time only)"
KOK=0
if [ ! -x "$V/venv/bin/python" ]; then python3 -m venv "$V/venv"; fi
if "$V/venv/bin/pip" install -q --upgrade kokoro-onnx soundfile; then
  R=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
  get "$R/kokoro-v1.0.onnx" "$V/kokoro-v1.0.onnx" && get "$R/voices-v1.0.bin" "$V/voices-v1.0.bin" && KOK=1
fi
[ $KOK = 1 ] || echo "WARN: Kokoro not available, Piper samples only"

say "3/4 Piper (light voice, small download)"
PIP=0
if [ ! -x "$V/piper/piper" ]; then
  curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar -xz -C "$V" || true
fi
HF=https://huggingface.co/rhasspy/piper-voices/resolve/main/en
for v in en_US/ryan/high/en_US-ryan-high en_US/joe/medium/en_US-joe-medium en_GB/alan/medium/en_GB-alan-medium; do
  n=$(basename "$v"); get "$HF/$v.onnx" "$V/$n.onnx" && get "$HF/$v.onnx.json" "$V/$n.onnx.json" && PIP=1
done
[ -x "$V/piper/piper" ] || PIP=0
[ $PIP = 1 ] || echo "WARN: Piper not available"

say "4/4 making samples"
[ $KOK = 1 ] && "$V/venv/bin/python" "$H/server/tts_samples.py" kokoro "$V" "$OUT"
[ $PIP = 1 ] && "$V/venv/bin/python" "$H/server/tts_samples.py" piper "$V" "$OUT"
python3 "$H/server/tts_samples.py" page "$V" "$OUT"
chown -R hubie:hubie "$H/shots" "$V"
echo; echo "VOICES-OK. Now run: hubie shots"
