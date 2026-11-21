# Dev-only numerics check for Loom Infer (never shipped, never imported by the app).
# Runs the reference ONNX Runtime on normalized 1x3x320x320 float32 inputs and writes the fused saliency output (d0).
#
#   python -I scripts/u2netp-reference.py <u2netp.onnx> <out-dir> [n]
#   python -I scripts/u2netp-reference.py <u2netp.onnx> <out-dir> --inputs   (use the in<i>.f32 already in out-dir)
#
# Writes <out-dir>/in<i>.f32 (input, 3*320*320 float32 LE) and <out-dir>/ref<i>.f32 (output, 320*320 float32 LE).
# Inputs are deterministic synthetic pictures (shapes, gradients, noise) normalized with the ImageNet mean/std, the
# same preprocessing Loom Infer uses. tests/infer/fixture.dev.test.ts packs the outputs into the test fixture.
import sys, os
import numpy as np
import onnxruntime as ort

model, out_dir = sys.argv[1], sys.argv[2]
given = len(sys.argv) > 3 and sys.argv[3] == "--inputs"
n = int(sys.argv[3]) if len(sys.argv) > 3 and not given else 4
os.makedirs(out_dir, exist_ok=True)
sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
name = sess.get_inputs()[0].name
if given:
    i = 0
    while os.path.exists(os.path.join(out_dir, f"in{i}.f32")):
        x = np.fromfile(os.path.join(out_dir, f"in{i}.f32"), "<f4").reshape(1, 3, 320, 320)
        y = sess.run(None, {name: x})[0][0, 0].astype(np.float32)
        y.astype("<f4").tofile(os.path.join(out_dir, f"ref{i}.f32"))
        print(i, float(y.min()), float(y.max()), float(y.mean()))
        i += 1
    sys.exit(0)
mean = np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]
std = np.array([0.229, 0.224, 0.225], np.float32)[:, None, None]
yy, xx = np.mgrid[0:320, 0:320].astype(np.float32)
for i in range(n):
    rng = np.random.default_rng(1234 + i)
    img = np.zeros((3, 320, 320), np.float32)
    bg = rng.random(3).astype(np.float32)
    img[:] = bg[:, None, None] * (0.6 + 0.4 * xx / 320)
    for _ in range(1 + i):
        cx, cy, r = rng.uniform(80, 240), rng.uniform(80, 240), rng.uniform(30, 90)
        col = rng.random(3).astype(np.float32)
        m = ((xx - cx) ** 2 + (yy - cy) ** 2) < r * r
        img[:, m] = col[:, None]
    img += rng.normal(0, 0.03 * i, img.shape).astype(np.float32)
    img = np.clip(img, 0, 1)
    x = ((img - mean) / std).astype(np.float32)
    y = sess.run(None, {name: x[None]})[0][0, 0].astype(np.float32)
    x.astype("<f4").tofile(os.path.join(out_dir, f"in{i}.f32"))
    y.astype("<f4").tofile(os.path.join(out_dir, f"ref{i}.f32"))
    print(i, float(y.min()), float(y.max()), float(y.mean()))
