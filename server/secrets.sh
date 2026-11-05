#!/usr/bin/env bash
# Asks for Hubie's logins/keys and saves them to /etc/hubie.env (never into the repo).
# Press Enter on a question to keep what's already saved.
set -euo pipefail
F=/etc/hubie.env
touch "$F"
set -a; . "$F"; set +a

ask(){ # key, question
  local key=$1 q=$2 cur="${!1:-}" v
  if [ -n "$cur" ]; then read -rp "$q [Enter = keep saved]: " v; else read -rp "$q: " v; fi
  v="$(printf '%s' "$v" | tr -d '\r' | sed 's/^ *//;s/ *$//')"
  [ -z "$v" ] && v="$cur"
  printf -v "$key" '%s' "$v"
}

echo "Paste or type each one, then press Enter."
ask HB_EMAIL     "Housebets login email (Hubie's account)"
ask HB_PASSWORD  "Housebets password"
ask KICK_URL     "Kick Stream URL (starts with rtmps://)"
ask KICK_KEY     "Kick Stream Key"

{
  for k in HB_EMAIL HB_PASSWORD KICK_URL KICK_KEY GEMINI_API_KEY; do
    if [ -n "${!k:-}" ]; then printf '%s=%q\n' "$k" "${!k}"; fi
  done
} > "$F.tmp"
mv "$F.tmp" "$F"; chown root:hubie "$F"; chmod 640 "$F"
clear
echo "Saved. Check (secrets hidden):"
for k in HB_EMAIL HB_PASSWORD KICK_URL KICK_KEY; do
  v="${!k:-}"; if [ -z "$v" ]; then echo "  $k: MISSING"
  elif [ "$k" = HB_EMAIL ] || [ "$k" = KICK_URL ]; then echo "  $k: $v"
  else echo "  $k: set (${#v} characters)"; fi
done
