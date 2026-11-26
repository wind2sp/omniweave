// A conv pool worker (convPool.ts): parses the model once, keeps its own slice (part `part` of `parts`) of every conv's
// output channels, and runs one layer at a time on the input it is sent.

import { parseGraph, type GraphModel } from "./graph";
import { convLayer } from "./cpu";
import { parseModel, type ConvLayer, type Model } from "./model";
import { graphJob, type ConvWorkerMsg, type ConvWorkerReply } from "./convPool";

interface Scope {
  onmessage: ((e: MessageEvent<ConvWorkerMsg>) => void) | null;
  postMessage(msg: ConvWorkerReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as Scope;

let graph: GraphModel | null = null;
let u2: Model | null = null;
let part = 0, parts = 1;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.kind === "init") {
    part = m.part;
    parts = m.parts;
    if (m.model === "graph") graph = parseGraph(new Uint8Array(m.bytes));
    else u2 = parseModel(new Uint8Array(m.bytes)); // (U²-Netp is split by rows: every worker holds the whole model)
    return;
  }
  try {
    let s: number[], d: Float32Array;
    if (graph) {
      const r = graphJob(graph, m, part, parts);
      (s = r.s), (d = r.d);
    } else if (u2) {
      const L = u2.layers[m.layer] as ConvLayer;
      const r = convLayer(u2, L, { c: m.s[1], h: m.s[2], w: m.s[3], d: m.d });
      // the band's own rows (the reach rows above and below were only input)
      const [top, bh] = m.crop ?? [0, r.h];
      d = new Float32Array(r.c * bh * r.w);
      for (let c = 0; c < r.c; c++) d.set(r.d.subarray((c * r.h + top) * r.w, (c * r.h + top + bh) * r.w), c * bh * r.w);
      s = [1, r.c, bh, r.w];
    } else throw new Error("conv pool worker: no model");
    scope.postMessage({ id: m.id, s, d }, [d.buffer]);
  } catch (err) {
    scope.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
