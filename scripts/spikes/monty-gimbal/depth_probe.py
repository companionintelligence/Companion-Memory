"""Prove a metric depth array comes out of Depth Anything V2 Metric Indoor.
Uses a synthetic scene when no real camera frame is available."""

import sys
import time

import numpy as np
import torch
from PIL import Image, ImageDraw
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

MID = "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"
src = sys.argv[1] if len(sys.argv) > 1 else None
if src:
    img = Image.open(src).convert("RGB")
    label = src
else:
    # synthetic: a "table" gradient with a box on it
    W, H = 640, 480
    a = np.zeros((H, W, 3), np.uint8)
    for y in range(H):
        a[y, :, :] = int(40 + 160 * (y / H))  # floor receding
    img = Image.fromarray(a)
    d = ImageDraw.Draw(img)
    d.rectangle([250, 250, 400, 390], fill=(220, 90, 60))  # near box
    d.rectangle([120, 180, 190, 240], fill=(70, 130, 200))  # far box
    label = "SYNTHETIC"

proc = AutoImageProcessor.from_pretrained(MID)
model = AutoModelForDepthEstimation.from_pretrained(MID).eval()
dev = "mps" if torch.backends.mps.is_available() else "cpu"
model.to(dev)

inp = proc(images=img, return_tensors="pt").to(dev)
t0 = time.time()
with torch.no_grad():
    out = model(**inp)
torch.mps.synchronize() if dev == "mps" else None
dt = time.time() - t0

post = proc.post_process_depth_estimation(out, target_sizes=[(img.height, img.width)])
depth = post[0]["predicted_depth"].cpu().numpy()

print(f"source            : {label}  ({img.width}x{img.height})")
print(f"device            : {dev}   inference: {dt * 1000:.0f} ms")
print(f"depth dtype/shape : {depth.dtype} {depth.shape}")
print(
    f"depth min/max     : {depth.min():.3f} / {depth.max():.3f}   (config units = METRES, max_depth=20)"
)
print(f"depth mean/median : {depth.mean():.3f} / {np.median(depth):.3f}")
print(f"centre pixel      : {depth[img.height // 2, img.width // 2]:.3f} m")
np.save(sys.argv[2] if len(sys.argv) > 2 else "/tmp/depth.npy", depth)
print("saved npy ->", sys.argv[2] if len(sys.argv) > 2 else "/tmp/depth.npy")
