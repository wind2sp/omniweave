// Fidelity worker: scores one PSD/PSB against its merged image off the UI thread (one worker per run, so cancelling
// is terminate() and a huge file's memory goes away with it). Pure engine code only (no DOM).
// It also reads a CMYK PSD's channels for the screen (core/image/cmykComposite.ts prepareCmykStore) — the same PSD
// reader, so no second copy of it in the app.

import { cmykTilesOf, type CmykKeyPage } from "../image/cmykComposite";
import { importPsdPage } from "../../io/formats/psd";
import { scorePsd, type PsdScore } from "./psdScore";

export type FidelityRequest = { kind?: "score"; bytes: Uint8Array } | { kind: "cmyk"; bytes: Uint8Array; page: CmykKeyPage | null };
export type FidelityReply =
  | { kind: "progress"; done: number; total: number; partial: PsdScore }
  | { kind: "done"; run: Awaited<ReturnType<typeof scorePsd>> }
  | { kind: "cmyk"; tiles: [string, Uint8Array][] | null }
  | { kind: "error"; message: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<FidelityRequest>) => void) | null;
  postMessage(msg: FidelityReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (e) => {
  try {
    const m = e.data;
    if (m.kind === "cmyk") {
      // without the import's page (an .omw that stored every tile) the file is imported here for the keys
      const page = m.page ?? importPsdPage(m.bytes, "cmyk.psd", "cmyk", { id: "cmyk", hash: "" }).page;
      const s = cmykTilesOf(m.bytes, page);
      const tiles = s ? [...s] : null;
      scope.postMessage({ kind: "cmyk", tiles }, tiles ? tiles.map(([, d]) => d.buffer as ArrayBuffer) : []);
      return;
    }
    let last = 0;
    const run = await scorePsd(m.bytes, {
      onProgress: (done, total, partial) => {
        // at most ~10 progress messages a second (each carries the mismatching tiles found so far)
        const now = performance.now();
        if (done < total && now - last < 100) return;
        last = now;
        scope.postMessage({ kind: "progress", done, total, partial });
      },
    });
    scope.postMessage({ kind: "done", run });
  } catch (err) {
    scope.postMessage({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
