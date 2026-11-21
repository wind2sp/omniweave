// Canvas crop → PSD → real Photoshop check (2026-11-20). Opens repository omni-fid-* references, applies the canvas
// crop the crop tool uses (shrink with an offset origin, extend past the canvas, straighten 5°), saves each as PSD with
// Omniweave's merged image as PNG and a manifest for qa/interop/scripts/ps_crop_check.jsx. Runs only with
// OMW_CROP_PS_WORK=<folder> set (a manual QA helper, skipped in the normal suite).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { useStore } from "../src/core/store";
import { newDocument } from "../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout } from "../src/io/formats/psd";
import { encodePng } from "../src/io/formats/png";
import { writePsd } from "../src/io/formats/psdWrite";
import { applyCrop, cancelCrop, setCropAngle, startCrop, useCrop } from "../src/ui/cropTool";

const WORK = process.env.OMW_CROP_PS_WORK;
const FILES = ["omni-fid-smart-embedded", "omni-fid-shape-ellipse", "omni-fid-text-latin", "omni-fid-vmask-ellipse", "omni-fid-mask-ellipse"];
const S = () => useStore.getState();

describe.skipIf(!WORK)("canvas crop → PSD for Photoshop", () => {
  it("writes cropped PSDs and a manifest", async () => {
    mkdirSync(WORK!, { recursive: true });
    const manifest: any[] = [];
    for (const f of FILES) {
      const src = new Uint8Array(readFileSync(join("qa/interop/adobe-made/fidelity", f + ".psd")));
      const L0 = parsePsdLayout(src);
      const W = L0.width, H = L0.height;
      const cases: [string, { x: number; y: number; w: number; h: number } | null, number][] = [
        ["shrink", { x: Math.round(W * 0.15), y: Math.round(H * 0.1), w: Math.round(W * 0.6), h: Math.round(H * 0.7) }, 0],
        ["extend", { x: -20, y: -10, w: W + 50, h: H + 30 }, 0],
        ["rot5", null, 5],
      ];
      for (const [tag, rect, angle] of cases) {
        const asset = makeAsset(src, "image/vnd.adobe.photoshop", f + ".psd");
        const r = importPsdPage(src, f + ".psd", f, asset);
        const doc = newDocument(f);
        doc.pages = [r.page];
        doc.assets[asset.id] = asset;
        S().load(doc);
        S().set({ mode: "IMAGE", selection: [] });
        if (useCrop.getState().id) cancelCrop();
        startCrop();
        if (rect) useCrop.getState().set({ rect });
        if (angle) setCropAngle(angle);
        applyCrop();
        const pg = S().doc.pages[0];
        const res = await writePsd(S().doc, pg);
        const name = `omw-crop-${f.replace("omni-fid-", "")}-${tag}`;
        writeFileSync(join(WORK!, name + ".psd"), res.bytes);
        const img = decodePsd(res.bytes);
        if (img.composite) writeFileSync(join(WORK!, name + ".omw.png"), encodePng(img.composite, img.width, img.height));
        manifest.push({
          name, source: f, tag, rect, angle, srcSize: [W, H], size: [pg.width, pg.height], method: res.method, warnings: res.warnings,
          nodes: pg.nodes.map((n: any) => ({ name: n.name, type: n.type, x: n.transform?.x, y: n.transform?.y, rot: n.transform?.rotation })),
        });
      }
    }
    writeFileSync(join(WORK!, "manifest.json"), JSON.stringify(manifest, null, 1));
  });
});
