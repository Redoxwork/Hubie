"""Make Hubie voice samples.  usage: tts_samples.py kokoro|piper|page <tts_dir> <out_dir>"""
import json, os, subprocess, sys, time

mode, V, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

# One line per Hubie mood (spelled out in full words so the voice reads them right)
LINES = [
    "Yooo Dave! Welcome in man, grab a branch and chill with me.",
    "Let's gooo! Mike's call hit! Told you, sick pick!",
    "Ohh man. Not again. Who called this slot? I'm just gonna lie on my branch for a sec.",
    "Whoa whoa, slow it down chat! It's just demo money, we're here for fun.",
]
TEXT = " ... ".join(LINES)

KOKORO = [  # voice id, label
    ("am_puck", "Puck - upbeat, playful (US)"),
    ("am_michael", "Michael - warm, friendly (US)"),
    ("am_fenrir", "Fenrir - deeper, confident (US)"),
    ("am_liam", "Liam - young, casual (US)"),
    ("bm_fable", "Fable - British storyteller"),
    ("bm_george", "George - British gentleman"),
]
PIPER = [
    ("en_US-ryan-high", "Ryan - clear (US, light)"),
    ("en_US-joe-medium", "Joe - casual (US, light)"),
    ("en_GB-alan-medium", "Alan - British (light)"),
]

def to_mp3(wav, name):
    mp3 = os.path.join(OUT, name + ".mp3")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-b:a", "96k", mp3], check=True)
    os.remove(wav)

def note(label, secs, audio_secs):
    with open(os.path.join(OUT, "samples.jsonl"), "a") as f:
        f.write(json.dumps({"label": label, "make": round(secs, 1), "len": round(audio_secs, 1)}) + "\n")
    print(f"  {label}: {audio_secs:.1f}s of speech made in {secs:.1f}s")

if mode == "kokoro":
    import soundfile as sf
    from kokoro_onnx import Kokoro
    k = Kokoro(os.path.join(V, "kokoro-v1.0.onnx"), os.path.join(V, "voices-v1.0.bin"))
    for i, (vid, label) in enumerate(KOKORO, 1):
        try:
            t = time.time()
            audio, sr = k.create(TEXT, voice=vid, speed=1.05, lang="en-us" if vid.startswith("a") else "en-gb")
            wav = os.path.join(OUT, f"k{i}.wav"); sf.write(wav, audio, sr)
            note(f"k{i}|Kokoro {label}", time.time() - t, len(audio) / sr); to_mp3(wav, f"k{i}")
        except Exception as e:
            print("  failed", vid, e)

elif mode == "piper":
    for i, (vid, label) in enumerate(PIPER, 1):
        try:
            t = time.time(); wav = os.path.join(OUT, f"p{i}.wav")
            subprocess.run([os.path.join(V, "piper", "piper"), "-m", os.path.join(V, vid + ".onnx"), "-f", wav,
                            "--sentence_silence", "0.35"], input=" ".join(LINES).encode(), check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                                       capture_output=True, text=True).stdout.strip() or 0)
            note(f"p{i}|Piper {label}", time.time() - t, dur); to_mp3(wav, f"p{i}")
        except Exception as e:
            print("  failed", vid, e)

elif mode == "page":
    rows = []
    p = os.path.join(OUT, "samples.jsonl")
    if os.path.exists(p):
        for line in open(p):
            d = json.loads(line); fid, label = d["label"].split("|", 1)
            speed = d["len"] / d["make"] if d["make"] else 0
            rows.append(f'<div class=c><b>{fid.upper()}</b> {label}<br><audio controls preload=none src="{fid}.mp3"></audio>'
                        f'<small>made {speed:.1f}x faster than real time</small></div>')
    html = f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Hubie voices</title><style>body{{background:#0b1418;color:#e6f4f5;font:15px system-ui;margin:14px}}
.c{{background:#12232a;border:1px solid #234;border-radius:12px;padding:12px;margin:10px 0}}audio{{width:100%;margin:8px 0 4px}}
small{{color:#8fb0b6}}</style><h2>Hubie voice samples</h2>
<p>Each sample says:</p><ol>{''.join(f'<li>{l}</li>' for l in LINES)}</ol>{''.join(rows) or '<p>No samples were made.</p>'}"""
    open(os.path.join(OUT, "index.html"), "w").write(html)
