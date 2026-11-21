// Dev-only: OCR_SAMPLE="<image.rgba>|<det.lwt>|<rec.lwt>|<out dir>|<name>[;…]" npx vitest run tests/ocr/sample-export.dev.test.ts
import { it } from "vitest";
import { ocrSample } from "../../scripts/ocr-sample";

const SPEC = process.env.OCR_SAMPLE;

it.runIf(!!SPEC)("OCR sample export", async () => {
  for (const one of SPEC!.split(";")) {
    const [src, det, rec, out, name] = one.split("|");
    await ocrSample(src, det, rec, out, name);
  }
}, 1800000);
