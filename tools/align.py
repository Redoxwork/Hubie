"""Align every Hubie frame to idle.jpg (head/hat region), remove black bars, save aligned PNGs."""
import cv2, numpy as np, sys, os
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
names = ['idle','talk_small','talk_open','blink','happy','laugh','sad','shocked','thinking']
GREEN = (79,245,115)  # BGR

def debar(img):
    g = img.max(axis=2)
    rows = (g < 14).mean(axis=1) > 0.97
    top = 0
    while top < len(rows) and rows[top]: top += 1
    bot = len(rows)
    while bot > 0 and rows[bot-1]: bot -= 1
    cols = (g < 14).mean(axis=0) > 0.97
    l = 0
    while l < len(cols) and cols[l]: l += 1
    r = len(cols)
    while r > 0 and cols[r-1]: r -= 1
    return img[top:bot, l:r], (top, bot, l, r)

ref = cv2.imread(f'{src}/idle.jpg'); ref, _ = debar(ref)
H, W = ref.shape[:2]
refg = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY).astype(np.float32)/255
mask = np.zeros((H, W), np.uint8); mask[:int(H*0.52), :] = 255   # hat + head only
for n in names:
    im = cv2.imread(f'{src}/{n}.jpg'); im, bars = debar(im)
    # pad/crop to ref size first, centred top-left
    canvas = np.full((H, W, 3), GREEN, np.uint8)
    h, w = min(H, im.shape[0]), min(W, im.shape[1])
    canvas[:h, :w] = im[:h, :w]
    g = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY).astype(np.float32)/255
    M = np.eye(2, 3, dtype=np.float32)
    if n != 'idle':
        try:
            # coarse-to-fine: half size then full
            s = 0.5
            gs = cv2.resize(g, None, fx=s, fy=s); rs = cv2.resize(refg, None, fx=s, fy=s); ms = cv2.resize(mask, None, fx=s, fy=s)
            _, M = cv2.findTransformECC(rs, gs, M, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT, 200, 1e-6), ms, 5)
            M[:, 2] /= s
            _, M = cv2.findTransformECC(refg, g, M, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT, 100, 1e-6), mask, 5)
        except cv2.error as e:
            print(n, 'ECC failed', e)
    al = cv2.warpAffine(canvas, M, (W, H), flags=cv2.INTER_CUBIC|cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT, borderValue=GREEN)
    cv2.imwrite(f'{out}/{n}.png', al)
    print(n, 'bars', bars, 'M', np.round(M, 3).tolist())
print('size', W, H)
