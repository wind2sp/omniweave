// Shared by every place that embeds a TrueType subset with pdf-lib (pdfVector.ts export, PDF Surgeon edits and
// form filling): call padTtfSubsetGlyphs(font.embedder.subset) right after embedFont(…, { subset: true }).

/**
 * Work around a fontkit 1.1.1 TrueType subsetting bug: glyph records are copied unpadded, but the
 * subset's loca table switches to the short format (offset / 2) whenever it is small, so every
 * glyph after an odd-length record is read from the wrong offset and renders as garbage or blank.
 * Pretendard has many odd-length glyphs. Padding each record to 4 bytes (the format's own
 * recommendation) makes every offset even. Patched once on the TTFSubset prototype.
 */
export function padTtfSubsetGlyphs(subset: object | undefined) {
  if (!subset) return;
  const proto = Object.getPrototypeOf(subset) as { _addGlyph?: (gid: number) => number; __omwPadded?: boolean };
  if (!proto || proto.__omwPadded || typeof proto._addGlyph !== "function") return;
  const orig = proto._addGlyph;
  proto._addGlyph = function (this: { glyf: Uint8Array[]; offset: number }, gid: number) {
    const r = orig.call(this, gid);
    const i = this.glyf.length - 1;
    const buf = this.glyf[i];
    const extra = buf ? (4 - (buf.length % 4)) % 4 : 0;
    if (extra) {
      const Ctor = buf.constructor as { alloc?: (n: number) => Uint8Array };
      const padded = typeof Ctor.alloc === "function" ? Ctor.alloc(buf.length + extra) : new Uint8Array(buf.length + extra);
      padded.set(buf);
      this.glyf[i] = padded;
      this.offset += extra;
    }
    return r;
  };
  proto.__omwPadded = true;
}
