#!/usr/bin/env bash
# hubie report: one screen on how the run is going (since the last 'hubie live')
H=/opt/hubie
since=$(cat "$H/data/live-since" 2>/dev/null || date +%s)
hours=$(( ($(date +%s) - since) / 3600 )); mins=$(( ($(date +%s) - since) % 3600 / 60 ))
L=$(journalctl -u hubie-live --since "@$since" -o cat --no-pager 2>/dev/null)
B=$(journalctl -u hubie-brain --since "@$since" -o cat --no-pager 2>/dev/null)
c(){ printf '%s\n' "$1" | grep -cE "$2"; }
echo "== Hubie report =="
echo "live for:        ${hours}h ${mins}m   (stream service: $(systemctl is-active hubie-live))"
echo "stream restarts: $(c "$L" 'starting Hubie LIVE') · Kick reconnects: $(c "$L" 'Kick connection ended')"
echo "autobet runs:    $(c "$L" 'auto: [0-9]+ bets on .*, [0-9]+ wins')   bets in them: $(printf '%s\n' "$L" | grep -oE 'auto: [0-9]+ bets on [^,]+, [0-9]+ wins' | awk '{s+=$2} END{print s+0}')"
echo "slot sessions:   $(c "$L" 'done with .* spins')"
echo "games opened:    $(printf '%s\n' "$L" | grep -oE 'opening [A-Za-z'"'"' ]+' | sort | uniq -c | sort -rn | head -6 | awk '{printf "%s %s %s · ", $1, $3, $4}')"
echo "logins:          ok $(c "$L" 'login: ✅') · failed $(c "$L" 'login: ❌') · logged out $(c "$L" 'logged out: logging in')"
echo "security check:  $(c "$L" 'security check stuck') stuck · lounge $(c "$L" "showing Hubie's Lounge")"
echo "self-repairs:    $(c "$L" 'watchdog:') (screens/windows/stream/game bot)"
printf '%s\n' "$L" | grep -oE 'watchdog: [a-z ]+' | sort | uniq -c | sort -rn | head -6 | sed 's/^/                 /'
echo "safety stops:    $(c "$L" 'BET BOX NOT 0|bet box not confirmed')"
echo "AI:              gemini limit hits $(c "$B" 'status 429|429') · backup used $(c "$B" 'using openrouter') · Kick token refresh fails $(c "$B" 'refresh failed')"
echo "last health:     $(printf '%s\n' "$L" | grep 'health:' | tail -1 | cut -c12-)"
echo "last memory:     $(printf '%s\n' "$L" | grep 'memory:' | tail -1 | cut -c20-)"
echo "first memory:    $(printf '%s\n' "$L" | grep 'memory:' | head -1 | cut -c20-)"
echo "recent problems:"
printf '%s\n' "$L" | grep -E 'error|failed|❌|stuck|died|NOT 0' | tail -5 | sed 's/^/  /'
