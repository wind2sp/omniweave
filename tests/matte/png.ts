// Bench previews: side-by-side strips written with the engine's own PNG writer.
import { encodePngImg } from "../../src/core/image/png";
import type { Img } from "../../src/core/image/pixels";

export const encodePngRgba = encodePngImg;

/** Side-by-side strip: original | cut-out on checkerboard | matte. */
export function strip(orig: Img, cut: Img, alpha: Uint8ClampedArray): Img {
  const W = orig.width, H = orig.height;
  const out = { width: W * 3, height: H, data: new Uint8ClampedArray(W * 3 * H * 4) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const o = (y * W * 3 + x) * 4;
      out.data.set([orig.data[i], orig.data[i + 1], orig.data[i + 2], 255], o);
      const chk = ((x >> 3) + (y >> 3)) & 1 ? 200 : 255;
      const a = cut.data[i + 3] / 255;
      out.data.set([cut.data[i] * a + chk * (1 - a), cut.data[i + 1] * a + chk * (1 - a), cut.data[i + 2] * a + chk * (1 - a), 255], o + W * 4);
      const m = alpha[y * W + x];
      out.data.set([m, m, m, 255], o + W * 8);
    }
  return out;
}
