// pdf.js CMaps from one packed file (public/pdfjs/cmaps.pack, written by scripts/copy-pdfjs-assets.mjs) instead of
// 169 loose .bcmap files — the installer compresses each bundled file on its own, so one file is 0.5 MB smaller
// (docs/design/INSTALLER_SIZE.md). Pack: "OCM1" | u32 count | count × (u8 nameLength | name | u32 length | bytes).

export function readCMapPack(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 8 || bytes[0] !== 0x4f || bytes[1] !== 0x43 || bytes[2] !== 0x4d || bytes[3] !== 0x31) throw new Error("cmap pack expected");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(4, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let p = 8;
  for (let i = 0; i < n; i++) {
    if (p + 1 > bytes.length) throw new Error("cmap pack truncated");
    const nl = bytes[p++];
    if (p + nl + 4 > bytes.length) throw new Error("cmap pack truncated");
    const name = dec.decode(bytes.subarray(p, p + nl));
    p += nl;
    const len = dv.getUint32(p, true);
    p += 4;
    if (p + len > bytes.length) throw new Error("cmap pack truncated");
    out.set(name, bytes.subarray(p, p + len));
    p += len;
  }
  return out;
}

const packs = new Map<string, Promise<Map<string, Uint8Array>>>();

/** The pack next to the app (`<base>cmaps.pack`), fetched once per base URL. */
export function loadCMapPack(baseUrl: string): Promise<Map<string, Uint8Array>> {
  let p = packs.get(baseUrl);
  if (!p) {
    p = (async () => {
      const res = await fetch(baseUrl + "cmaps.pack");
      if (!res.ok) throw new Error("cmap pack missing");
      return readCMapPack(new Uint8Array(await res.arrayBuffer()));
    })();
    p.catch(() => packs.delete(baseUrl));
    packs.set(baseUrl, p);
  }
  return p;
}

/** pdf.js `CMapReaderFactory` (getDocument option): `cMapUrl` is the folder that holds cmaps.pack. */
export class PackedCMapReaderFactory {
  baseUrl: string | null;
  constructor({ baseUrl = null }: { baseUrl?: string | null; isCompressed?: boolean }) {
    this.baseUrl = baseUrl;
  }
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    if (!this.baseUrl) throw new Error("cmap pack: no base URL");
    const data = (await loadCMapPack(this.baseUrl)).get(name);
    if (!data) throw new Error(`Unable to load binary CMap: ${name}`);
    // pdf.js transfers the bytes to its worker — hand over a copy, not a view into the shared pack
    return { cMapData: data.slice(), isCompressed: true };
  }
}
