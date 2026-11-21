// QA 0bed950 (style system phase A): defects found in review, each pinned by a test.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { newDocument, newPage, newText, type OmwDocument } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { colorFromHex, liveEdit } from "../../src/ui/style";
import type { Color } from "../../src/core/style";

const manifestOf = (bytes: Uint8Array) => JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));

function omniDoc(): OmwDocument {
  const doc = newDocument("omniweave qa");
  const p = newPage("DESIGN", 120, 80, "omni-page");
  p.nodes = [{ ...newText("오메"), name: "omni-text" }];
  doc.pages = [p];
  return doc;
}

/** A file as a newer Omniweave would write it: manifest version `v`, an unknown document field. */
function newerFile(v: number): Uint8Array {
  const doc = omniDoc();
  (doc as any).omniFuture = { weave: 1 };
  const files = unzipSync(packOmw(doc).bytes);
  const m = JSON.parse(strFromU8(files["manifest.json"]));
  m.version = v;
  files["manifest.json"] = strToU8(JSON.stringify(m));
  return zipSync(files);
}

describe("QA 0bed950 — .omw from a newer version", () => {
  it("open + save keeps the newer version number (no silent downgrade a newer app would re-migrate)", () => {
    const { doc, report } = unpackOmw(newerFile(7));
    expect(report.version.newer).toBe(true);
    const again = packOmw(doc).bytes;
    expect(manifestOf(again).version).toBe(7);
    const back = unpackOmw(again);
    expect(back.report.version).toEqual({ from: 7, to: 7, steps: [], newer: true });
    expect((back.doc as any).omniFuture).toEqual({ weave: 1 });
    expect(back.report.rootMatches).toBe(true);
  });

  it("history entries of a newer file keep its version too (undo then save does not downgrade)", () => {
    const doc = omniDoc();
    (doc as any).omniFuture = { weave: 2 };
    const entries = [
      { id: "h1", time: 1, label: "omni-1", root: "r1", doc },
      { id: "h2", time: 2, label: "omni-2", root: "r2", doc: { ...doc, title: "omniweave 2" } },
    ];
    const files = unzipSync(packOmw(doc, entries).bytes);
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    m.version = 5;
    files["manifest.json"] = strToU8(JSON.stringify(m));
    const { history } = unpackOmw(zipSync(files));
    expect(history).toHaveLength(2);
    for (const e of history) expect(manifestOf(packOmw(e.doc).bytes).version).toBe(5);
  });

  it("v1 documents still save byte-identically and say version 1", () => {
    // (one frozen clock: the zip entries carry the save time in DOS 2-second steps — fflate's Date.now())
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 17, 9, 0, 0) });
    try {
      const doc = omniDoc();
      const a = packOmw(doc).bytes;
      const { doc: back } = unpackOmw(a);
      expect(manifestOf(a).version).toBe(1);
      expect(back.version).toBe(1);
      expect(Buffer.from(packOmw(back).bytes).equals(Buffer.from(a))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QA 0bed950 — ColorPicker", () => {
  it("an alpha typed in the hex field (#rrggbbaa / #rgba) wins over the old alpha", () => {
    const old: Color = { hex: "#ff0000", a: 0.5 };
    expect(colorFromHex("#00ff0080", old)).toEqual({ hex: "#00ff00", a: 128 / 255 });
    expect(colorFromHex("#0f08", old)).toEqual({ hex: "#00ff00", a: 136 / 255 });
    // same hex, new alpha: the alpha changes, the original components stay
    const cmyk: Color = { hex: "#ff0000", space: "cmyk", v: [0, 1, 1, 0] };
    expect(colorFromHex("#FF000080", cmyk)).toEqual({ ...cmyk, a: 128 / 255 });
    // same hex and alpha: the very same object (no edit)
    expect(colorFromHex("#ff000080", { hex: "#ff0000", a: 128 / 255 })).toEqual({ hex: "#ff0000", a: 128 / 255 });
    // six digits keep the old alpha as before
    expect(colorFromHex("#00ff00", old)).toEqual({ hex: "#00ff00", a: 0.5 });
  });

  it("a control that streamed live changes commits once when the gesture ends, even if the value already matches", () => {
    const e = liveEdit();
    expect(e.end()).toBe(false); // nothing changed: no undo step
    e.live();
    e.live();
    expect(e.end()).toBe(true); // one commit
    expect(e.end()).toBe(false);
  });
});
