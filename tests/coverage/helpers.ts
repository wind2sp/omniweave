// Shared setup for feature-coverage tests (docs/coverage/features.json).
// Each test title starts with the feature IDs it proves, e.g. "[WD-002][HG-007] ...".
// scripts/coverage-report.mjs checks that every `testId` in features.json appears here.

import { DOMParser } from "@xmldom/xmldom";
import { pathToFileURL } from "node:url";
import { newDocument, type OmwDocument } from "../../src/core/types";
import { useStore } from "../../src/core/store";

export function installDom() {
  (globalThis as any).DOMParser = DOMParser;
}

/** pdf.js resolves its worker relative to the bundle; in Node point it at the real file. */
export async function installPdfWorker() {
  const pdfjs: any = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
}

/** Fresh store state with the given document (no history, not dirty). */
export function freshStore(doc: OmwDocument = newDocument()) {
  useStore.getState().load(doc);
  useStore.getState().set({ pageId: doc.pages[0].id, selection: [], mode: "AUTO" });
  return useStore.getState();
}

export const S = () => useStore.getState();
export const page = () => {
  const s = S();
  return s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId)!;
};

/** Shoelace area of a polygon given as [x,y][] (absolute value). */
export function polyArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
