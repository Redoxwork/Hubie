"""Kokoro TTS worker. Reads JSON lines {id,text,voice,speed} on stdin, writes <id>.wav, prints {id,file,dur}."""
import json, os, sys

import soundfile as sf
from kokoro_onnx import Kokoro

V, OUT = sys.argv[1], sys.argv[2]
k = Kokoro(os.path.join(V, "kokoro-v1.0.onnx"), os.path.join(V, "voices-v1.0.bin"))
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    m = {}
    try:
        m = json.loads(line)
        voice = m.get("voice", "am_puck")
        audio, sr = k.create(m["text"], voice=voice, speed=float(m.get("speed", 1.05)),
                             lang="en-gb" if voice.startswith("b") else "en-us")
        name = f"{m['id']}.wav"
        sf.write(os.path.join(OUT, name), audio, sr)
        print(json.dumps({"id": m["id"], "file": name, "dur": len(audio) / sr}), flush=True)
    except Exception as e:  # keep the worker alive whatever happens
        print(json.dumps({"id": m.get("id"), "error": str(e)}), flush=True)
