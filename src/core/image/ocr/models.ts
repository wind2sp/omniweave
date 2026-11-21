// OCR models: where they come from and the one entry point the worker calls.
//
// Phase 1 ships no weights in the repository (bundling vs. download-on-first-use is an open decision, see
// docs/design/OCR.md §6). The loader reads `models/ocr/<file>` next to the app (public/models/ocr in development;
// the converted files come from scripts/convert-ppocr.mjs). Nothing is fetched from another origin.

import { parseGraph, type GraphModel } from "../infer/graph";
import type { Img } from "../pixels";
import { ocrPage, ocrPageWith, type LineRecognizer, type NetRun, type OcrOptions, type OcrPage } from "./pipeline";
import { recognizeLine } from "./recognize";

export type OcrLang = "auto" | "ko" | "en";

/** Recognizer per language. The Korean PP-OCRv5 model also reads Latin letters, digits and symbols. */
export const OCR_FILES = { det: "ppocr-det.lwt", ko: "ppocr-rec-ko.lwt", en: "ppocr-rec-ko.lwt" } as const;

const cache = new Map<string, Promise<GraphModel>>();
let provided: { det?: GraphModel; rec?: GraphModel } = {};

/** Tests / callers that already hold the models. */
export function setOcrModels(det: GraphModel, rec: GraphModel) {
  provided = { det, rec };
}

let pageBase: string | undefined;
/** The app page's base URL. The image worker gets it with each request: its own location is the worker script
 *  (assets/… in a build, src/core/image/… in development), where models/ocr is not. */
export function setModelBase(base: string | undefined) {
  if (base) pageBase = base;
}

function modelUrl(file: string): string {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  const base = pageBase ?? g.document?.baseURI ?? g.location?.href;
  return base ? new URL(`models/ocr/${file}`, base).href : `models/ocr/${file}`;
}

export class OcrModelMissing extends Error {
  constructor(public file: string) {
    super("ocr model missing: " + file);
  }
}

function load(file: string): Promise<GraphModel> {
  let p = cache.get(file);
  if (!p) {
    p = (async () => {
      const res = await fetch(modelUrl(file));
      if (!res.ok) throw new OcrModelMissing(file);
      const bytes = await res.arrayBuffer();
      const m = parseGraph(new Uint8Array(bytes));
      fileBytes.set(m, bytes);
      return m;
    })();
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}

export async function ocrModels(lang: OcrLang = "auto"): Promise<{ det: GraphModel; rec: GraphModel }> {
  if (provided.det && provided.rec) return provided as { det: GraphModel; rec: GraphModel };
  const [det, rec] = await Promise.all([load(OCR_FILES.det), load(OCR_FILES[lang === "en" ? "en" : "ko"])]);
  return { det, rec };
}

/** The model file a loaded model came from (recognition workers parse their own copy); null for provided models. */
const fileBytes = new WeakMap<GraphModel, ArrayBuffer>();
export function modelFile(m: GraphModel): ArrayBuffer | null {
  return fileBytes.get(m) ?? null;
}

/** Faster ways to run a page: line recognition elsewhere (worker pool, WebGPU) and the detector on WebGPU. */
export interface OcrAccel {
  lines: LineRecognizer | null;
  detRun?: NetRun;
}

/**
 * Recognize a page. `accel(det, rec)` may return a line recognizer running in other workers / on the GPU (it gets
 * the recognizer before detection starts, so workers load it meanwhile) and a GPU detector; without them, or when
 * they fail, the page runs on this thread.
 */
export async function recognizePage(img: Img, lang: OcrLang = "auto", o: OcrOptions = {}, accel?: (det: GraphModel, rec: GraphModel) => Promise<OcrAccel>): Promise<OcrPage> {
  const { det, rec } = await ocrModels(lang);
  const a = await accel?.(det, rec).catch(() => null);
  if (a && (a.lines || a.detRun)) {
    try {
      return await ocrPageWith(det, a.lines ?? lineByLine(rec), img, o, a.detRun);
    } catch (e) {
      // a recognition worker or the GPU failed: the same page on this thread
      console.warn("OCR: accelerated run failed, recognizing on this thread:", e);
    }
  }
  return ocrPage(det, rec, img, o);
}

const lineByLine = (rec: GraphModel): LineRecognizer => async (tasks, done) =>
  tasks.map((t) => {
    const r = recognizeLine(rec, t.crop, t.opts);
    done();
    return r;
  });
