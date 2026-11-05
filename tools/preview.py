import json, sys
from PIL import Image
rig = sys.argv[1]; out = sys.argv[2]
m = json.load(open(f'{rig}/manifest.json')); L = m['layers']
def lay(c, n, dx=0, dy=0):
    im = Image.open(f'{rig}/{n}.png'); x, y = L[n]; c.alpha_composite(im, (x + dx, y + dy))
def head(eyes, mouth, base='head', rot=0):
    hc = Image.new('RGBA', (m['w'], m['h']), (0, 0, 0, 0))
    lay(hc, base); lay(hc, 'eyes_' + eyes); lay(hc, 'mouth_' + mouth)
    if rot: hc = hc.rotate(rot, resample=Image.BICUBIC, center=tuple(m['pivot']))
    return hc
combos = [('idle', 'open', 'smile', 0, 'body', 'head'), ('blink+talk', 'closed', 'open', 0, 'body', 'head'),
          ('happy', 'happy', 'grin', -4, 'body', 'head'), ('laugh', 'laugh', 'laugh', 4, 'body', 'head'),
          ('sad', 'sad', 'frown', -3, 'body', 'head'), ('shocked', 'shocked', 'o', 0, 'body', 'head'),
          ('sad talk', 'sad', 'small', 0, 'body', 'head'), ('thinking', 'shocked', 'o', 3, 'think_body', 'think_head')]
tiles = []
for name, e, mo, rot, b, hb in combos:
    c = Image.new('RGBA', (m['w'], m['h']), (10, 24, 30, 255))
    lay(c, b)
    h = Image.new('RGBA', (m['w'], m['h']), (0, 0, 0, 0)); lay(h, hb)
    if hb == 'think_head':
        hc = h  # thinking keeps its own face
        if rot: hc = hc.rotate(rot, resample=Image.BICUBIC, center=tuple(m['pivot']))
    else:
        hc = head(e, mo, hb, rot)
    c.alpha_composite(hc)
    tiles.append(c.convert('RGB').resize((360, 358)))
sheet = Image.new('RGB', (360 * 4, 358 * 2))
for i, t in enumerate(tiles): sheet.paste(t, ((i % 4) * 360, (i // 4) * 358))
sheet.save(out)
