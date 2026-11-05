"""Build index.html (repo, loads rig/*.webp) and a standalone demo with layers embedded."""
import json, base64, os, sys
from PIL import Image
root = sys.argv[1]
rig = f'{root}/rig'; m = json.load(open(f'{rig}/manifest.json'))
os.makedirs(f'{rig}/webp', exist_ok=True)
emb, rel = {}, {}
for n in m['layers']:
    Image.open(f'{rig}/{n}.png').save(f'{rig}/webp/{n}.webp', 'WEBP', quality=88, method=6)
    emb[n] = 'data:image/webp;base64,' + base64.b64encode(open(f'{rig}/webp/{n}.webp', 'rb').read()).decode()
    rel[n] = f'rig/webp/{n}.webp'
t = open(f'{root}/hubie.template.html').read()
open(f'{root}/index.html', 'w').write(t.replace('__RIG__', json.dumps({'manifest': m, 'src': rel})))
open(f'{root}/hubie-avatar-demo.html', 'w').write(t.replace('__RIG__', json.dumps({'manifest': m, 'src': emb})))
print('demo KB', os.path.getsize(f'{root}/hubie-avatar-demo.html') // 1024)
