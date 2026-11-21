// Zip central-directory reader for size measurement: compressed / uncompressed size and method of every entry.
// Groups .omw entries into the parts docs/design/FILE_SIZE.md reports (scene graph, rasters, assets, history, mirrors).

export interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  usize: number;
}

export function zipEntries(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.push({ name: dec.decode(b.subarray(p + 46, p + 46 + nl)), method, csize, usize });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export function partOf(name: string): string {
  if (name.startsWith("rasters/")) return "rasters";
  if (name.startsWith("assets/")) return "assets";
  if (name.startsWith("history/")) return "history";
  if (name === "scene_graph.cbor") return "scene";
  if (name === "manifest.json" || name === "mimetype") return "manifest";
  return "mirrors"; // slides/ vectors/ documents/
}

/** Bytes per part: compressed size + per-entry zip overhead (local + central headers). */
export function omwParts(b: Uint8Array): Record<string, { c: number; u: number; n: number }> {
  const parts: Record<string, { c: number; u: number; n: number }> = {};
  for (const e of zipEntries(b)) {
    const k = partOf(e.name);
    const p = (parts[k] ??= { c: 0, u: 0, n: 0 });
    p.c += e.csize + 30 + 46 + 2 * e.name.length;
    p.u += e.usize;
    p.n++;
  }
  return parts;
}
