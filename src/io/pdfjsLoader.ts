// pdf.js (≈0.35 MB of code + its worker) loads with the first PDF that is opened, printed or converted — not at
// startup (docs/design/INSTALLER_SIZE.md §4). Every caller goes through here so the worker URL is always set.
// A worker URL set earlier (tests point it at node_modules) is kept.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let pdfjsP: Promise<typeof import("pdfjs-dist")> | null = null;

export function pdfjsLib(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsP) {
    pdfjsP = import("pdfjs-dist").then((m) => {
      if (!m.GlobalWorkerOptions.workerSrc) m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
    pdfjsP.catch(() => (pdfjsP = null));
  }
  return pdfjsP;
}
