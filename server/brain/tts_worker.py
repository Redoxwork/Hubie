"""Kokoro TTS worker. Reads JSON lines {id,text,voice,speed} on stdin, writes <id>.wav, prints {id,file,dur}."""
import json, os, sys

import soundfile as sf
from kokoro_onnx import Kokoro

V, OUT = sys.argv[1], sys.argv[2]
THREADS = int(os.environ.get("TTS_THREADS", "2"))
try:
    os.nice(10)                     # the video encoder always goes first
except Exception:
    pass
MODEL, VOICES = os.path.join(V, "kokoro-v1.0.onnx"), os.path.join(V, "voices-v1.0.bin")
try:                                # cap CPU use: by default onnxruntime grabs every core
    import onnxruntime as ort
    so = ort.SessionOptions(); so.intra_op_num_threads = THREADS; so.inter_op_num_threads = 1
    k = Kokoro.from_session(ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"]), VOICES)
except Exception as e:
    print(json.dumps({"note": f"thread cap not applied: {e}"}), flush=True)
    k = Kokoro(MODEL, VOICES)
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
