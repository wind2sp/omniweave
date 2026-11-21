// OCR recognition worker (one of the pool in recPool.ts): parses the recognizer once, then recognizes line crops.

import { parseGraph, type GraphModel } from "../infer/graph";
import { recognizeLine } from "./recognize";
import type { RecWorkerMsg, RecWorkerReply } from "./recPool";

interface Scope {
  onmessage: ((e: MessageEvent<RecWorkerMsg>) => void) | null;
  postMessage(msg: RecWorkerReply): void;
}
const scope = self as unknown as Scope;
let model: GraphModel | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.kind === "model") {
    model = parseGraph(new Uint8Array(m.bytes));
    // one blank line while the page is still being detected: the engine compiles the WebAssembly kernels with its
    // fast baseline compiler first and only optimizes them once they ran a while (≈ 3× slower until then)
    recognizeLine(model, { width: 320, height: 32, data: new Uint8ClampedArray(320 * 32 * 4).fill(255) }, { spaces: false });
    return;
  }
  try {
    if (!model) throw new Error("recognizer not loaded");
    scope.postMessage({ i: m.i, r: recognizeLine(model, m.task.crop, m.task.opts) });
  } catch (err) {
    scope.postMessage({ i: m.i, error: err instanceof Error ? err.message : String(err) });
  }
};
