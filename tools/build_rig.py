"""Turn aligned green-screen Hubie frames into rig layers + manifest.json.
Layers: body, head, eyes_<x>, mouth_<x>, thinking body/head. All share one canvas (scaled)."""
import cv2, numpy as np, json, os, sys
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
SCALE = 0.8

def load(n): return cv2.imread(f'{src}/{n}.png')

def key(img):
    b, g, r = [img[..., i].astype(np.float32) for i in range(3)]
    green = g - np.maximum(r, b)
    a = np.clip((95 - green) / (95 - 35), 0, 1)
    # despill: pull green down toward the other channels on edges / everywhere slightly green
    spill = np.clip(green, 0, None)
    g2 = g - spill * 0.85
    rgb = np.dstack([r, g2, b])
    a = cv2.GaussianBlur(a, (3, 3), 0)
    # keep only the largest blob (the character)
    m = (a > 0.5).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n > 1:
        k = 1 + np.argmax(st[1:, 4]); keep = (lab == k).astype(np.uint8)
        keep = cv2.dilate(keep, np.ones((5, 5), np.uint8))
        a = a * keep
    return np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)

def feather_ellipses(shape, ells, f):
    m = np.zeros(shape[:2], np.float32)
    for (cx, cy, rx, ry) in ells:
        cv2.ellipse(m, (cx, cy), (rx, ry), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(m, (0, 0), f)

H, W = load('idle').shape[:2]
EYES = [(462, 386, 118, 84), (718, 386, 118, 84)]
MOUTH = [(590, 480, 140, 70)]
NECK = 600

def head_mask(shape, extra=0):
    m = np.zeros(shape[:2], np.float32); m[:NECK + extra, :] = 1
    return cv2.GaussianBlur(m, (0, 0), 6)

manifest = {'w': int(W * SCALE), 'h': int(H * SCALE), 'pivot': [590 * SCALE, NECK * SCALE], 'layers': {}}

def save(name, rgba, mask=None):
    if mask is not None:
        rgba = rgba.copy(); rgba[..., 3] = (rgba[..., 3].astype(np.float32) * mask).astype(np.uint8)
    rgba = cv2.resize(rgba, (int(W * SCALE), int(H * SCALE)), interpolation=cv2.INTER_AREA)
    ys, xs = np.where(rgba[..., 3] > 2)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    crop = rgba[y0:y1, x0:x1]
    bgra = cv2.cvtColor(crop, cv2.COLOR_RGBA2BGRA)
    cv2.imwrite(f'{out}/{name}.png', bgra)
    manifest['layers'][name] = [int(x0), int(y0)]

idle = key(load('idle'))
# body: everything except the head above the neck; keep a fur band under the chin so tilts never show a gap
body_m = np.ones((H, W), np.float32)
band = np.zeros((H, W), np.float32); band[NECK - 70:NECK + 5, 360:820] = 1
body_m = np.clip(1 - head_mask((H, W), -30) + cv2.GaussianBlur(band, (0, 0), 10), 0, 1)
save('body', idle, body_m)
save('head', idle, head_mask((H, W)))

eyes = {'open': 'idle', 'closed': 'blink', 'happy': 'happy', 'laugh': 'laugh', 'sad': 'sad', 'shocked': 'shocked'}
mouths = {'smile': 'idle', 'small': 'talk_small', 'open': 'talk_open', 'grin': 'happy',
          'laugh': 'laugh', 'frown': 'sad', 'o': 'shocked'}
em = feather_ellipses((H, W), EYES, 14); mm = feather_ellipses((H, W), MOUTH, 12)
cache = {}
def K(n):
    if n not in cache: cache[n] = key(load(n))
    return cache[n]
for k, n in eyes.items():  save(f'eyes_{k}', K(n), em)
for k, n in mouths.items(): save(f'mouth_{k}', K(n), mm)

th = K('thinking')
save('think_body', th, body_m)
save('think_head', th, head_mask((H, W)))
json.dump(manifest, open(f'{out}/manifest.json', 'w'), indent=1)
print(json.dumps(manifest))
