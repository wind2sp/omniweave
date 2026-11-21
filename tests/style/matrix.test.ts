// Property × format round-trip matrix, generated from the capability table (core/style/caps.ts; design ch. 9.4 (2)).
// For every property with a test builder and every format that can be written and read back in Node, a node with
// the property is saved and reopened through the real format registry, then checked against what caps.ts claims:
//   native     the value comes back equal,
//   approx     it comes back close (numbers within 10 %, everything else equal),
//   rasterize  the object does not come back as the same editable kind,
//   drop       the value does not come back (if it does, the table under-claims and must be updated).
// Combinations without a builder or without a Node round trip are listed as pending — the generated report grows as
// builders are added, and the matrix reproduces the property × format table of design ch. 3.
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { CAP_FORMATS, CAP_PROPS, capOf, newEffect, type CapFormat, type CapLevel, type Effect, type EffectType } from "../../src/core/style";
import { newDocument, newPage, newTable, newText, newVector, type NodeType, type Page, type SceneNode, type TableNode, type TextNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { expandSheetPages } from "../../src/io/sheet/pages";
import { EXPORTS, FORMATS } from "../../src/io/formats";
import { rasterFromRgba } from "../../src/io/formats/raster";
import { renumber } from "../../src/core/richtext";
import { toPx as toPxLen } from "../../src/core/style/len";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

interface Builder {
  node: NodeType;
  make: () => SceneNode;
  /** the value under test, read from a node of the same kind */
  read: (n: SceneNode) => unknown;
}

const vec = (extra: Partial<SceneNode> = {}) => ({ ...newVector([rectContour(10, 10, 80, 40)]), ...extra }) as SceneNode;
const raster = (extra: Partial<SceneNode> = {}) => {
  const rgba = new Uint8Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
  return { ...rasterFromRgba(rgba, 32, 32, "R"), ...extra } as SceneNode;
};
const text = (run: Partial<TextNode["paragraphs"][0]["runs"][0]> = {}, para: Partial<TextNode["paragraphs"][0]> = {}) => {
  const t = newText("Hello world", 400, { fontSize: 24, ...run });
  t.paragraphs = t.paragraphs.map((p) => ({ ...p, ...para }));
  return t as SceneNode;
};
const run0 = (n: SceneNode) => (n as TextNode).paragraphs.flatMap((p) => p.runs).find((r) => r.text.trim())!;
const para0 = (n: SceneNode) => (n as TextNode).paragraphs.find((p) => p.runs.some((r) => r.text.trim()))!;
const cell = (n: SceneNode, r: number, c: number) => (n as TableNode).rows[r]?.[c];
/** a cell is bold when its own flag says so or (imported cells) every run of its paragraphs is bold */
const cellBold = (n: SceneNode, r: number, c: number) => {
  const x = cell(n, r, c);
  const runs = (x?.richText ?? []).flatMap((p) => p.runs).filter((q) => q.text.trim());
  return !!x?.bold || (runs.length > 0 && runs.every((q) => q.bold));
};
const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : s ?? null);

/** Builders for the properties the model holds today (one per CAP_PROPS id; node kinds share one shape). */
const BUILDERS: Record<string, Builder[]> = {
  "node.TEXT": [{ node: "TEXT", make: () => text(), read: (n) => n.type }],
  "node.TABLE": [{ node: "TABLE", make: () => newTable([["a", "b"], ["c", "d"]]), read: (n) => n.type }],
  "node.VECTOR": [{ node: "VECTOR", make: () => vec(), read: (n) => n.type }],
  "node.RASTER": [{ node: "RASTER", make: () => raster(), read: (n) => n.type }],
  "fill.solid": [
    { node: "VECTOR", make: () => vec({ fill: "#12ab34" } as any), read: (n) => lc((n as any).fill) },
    { node: "TABLE", make: () => newTable([[{ text: "a", fill: "#12ab34" }, { text: "b" }]]), read: (n) => lc(cell(n, 0, 0)?.fill) },
  ],
  "stroke.solid": [{ node: "VECTOR", make: () => vec({ stroke: "#ab1234", strokeWidth: 3 } as any), read: (n) => [lc((n as any).stroke), (n as any).strokeWidth] }],
  opacity: [
    { node: "VECTOR", make: () => vec({ opacity: 0.5 }), read: (n) => n.opacity },
    { node: "RASTER", make: () => raster({ opacity: 0.5 }), read: (n) => n.opacity },
  ],
  blend: [
    { node: "VECTOR", make: () => vec({ blendMode: "MULTIPLY" }), read: (n) => n.blendMode },
    { node: "RASTER", make: () => raster({ blendMode: "SCREEN" }), read: (n) => n.blendMode },
  ],
  "transform.rotate": [{ node: "VECTOR", make: () => vec({ transform: { x: 100, y: 50, rotation: 30, scale: 1 } }), read: (n) => n.transform.rotation }],
  "transform.flip": [{ node: "VECTOR", make: () => vec({ transform: { x: 100, y: 50, rotation: 0, scale: 1, scaleY: -1 } }), read: (n) => Math.sign(n.transform.scaleY ?? n.transform.scale) }],
  "text.font": [{ node: "TEXT", make: () => text({ fontFamily: "Arial" }), read: (n) => run0(n).fontFamily }],
  "text.size": [{ node: "TEXT", make: () => text({ fontSize: 30 }), read: (n) => run0(n).fontSize }],
  "text.color": [{ node: "TEXT", make: () => text({ color: "#aa3311" }), read: (n) => lc(run0(n).color) }],
  "text.bold": [{ node: "TEXT", make: () => text({ bold: true }), read: (n) => run0(n).bold }],
  "text.italic": [{ node: "TEXT", make: () => text({ italic: true }), read: (n) => run0(n).italic }],
  "text.underline": [{ node: "TEXT", make: () => text({ underline: true }), read: (n) => run0(n).underline }],
  "text.strike": [{ node: "TEXT", make: () => text({ strike: true }), read: (n) => !!run0(n).strike }],
  "text.script": [{ node: "TEXT", make: () => text({ script: "super" }), read: (n) => run0(n).script ?? null }],
  "text.highlight": [{ node: "TEXT", make: () => text({ highlight: "#ffff00" }), read: (n) => lc(run0(n).highlight) }],
  "text.tracking": [{ node: "TEXT", make: () => text({ letterSpacing: 2 }), read: (n) => run0(n).letterSpacing ?? Math.round(((run0(n).spacingPct ?? 0) / 100) * run0(n).fontSize) }],
  "para.align": [{ node: "TEXT", make: () => text({}, { align: "CENTER" }), read: (n) => para0(n).align }],
  "para.lineSpacing": [{ node: "TEXT", make: () => text({}, { lineSpacing: 2 }), read: (n) => para0(n).lineSpacing }],
  "para.indent": [{ node: "TEXT", make: () => text({}, { indent: 24, indentLeft: 12 }), read: (n) => [para0(n).indent, para0(n).indentLeft ?? 0] }],
  "para.spaceAfter": [{ node: "TEXT", make: () => text({}, { spaceAfter: 20 }), read: (n) => para0(n).spaceAfter }],
  "para.list": [{ node: "TEXT", make: () => text({}, { role: "li" }), read: (n) => para0(n).role ?? null }],
  "text.hscale": [{ node: "TEXT", make: () => text({ hscale: 90 }), read: (n) => run0(n).hscale ?? 100 }],
  "text.spacingPct": [{ node: "TEXT", make: () => text({ spacingPct: -10 }), read: (n) => run0(n).spacingPct ?? Math.round(((run0(n).letterSpacing ?? 0) / run0(n).fontSize / 0.55) * 100) }],
  "para.spaceBefore": [{ node: "TEXT", make: () => text({}, { spaceBefore: 20 }), read: (n) => para0(n).spaceBefore ?? 0 }],
  "para.indentRight": [{ node: "TEXT", make: () => text({}, { indentRight: 30 }), read: (n) => para0(n).indentRight ?? 0 }],
  "para.lineHeight": [{ node: "TEXT", make: () => text({}, { lineHeight: { mode: "exact", v: { v: 20, u: "pt" } } }), read: (n) => (para0(n).lineHeight ? [para0(n).lineHeight!.mode, Math.round(toPxLen(para0(n).lineHeight!.v))] : null) }],
  "para.keep": [{ node: "TEXT", make: () => text({}, { keepNext: true, keepLines: true }), read: (n) => [!!para0(n).keepNext, !!para0(n).keepLines] }],
  "para.listLevel": [
    {
      node: "TEXT",
      make: () => {
        const t = text();
        (t as TextNode).paragraphs = renumber([{ ...(t as TextNode).paragraphs[0], list: { id: "L", def: "decimal", level: 1 }, indentLeft: 48, indent: -24 }]).paras;
        return t;
      },
      read: (n) => [para0(n).list?.level ?? null, para0(n).runs.map((r) => r.text).join("")],
    },
  ],
  "table.merge": [{ node: "TABLE", make: () => newTable([[{ text: "ab", colSpan: 2 }, { text: "" }], [{ text: "c" }, { text: "d" }]]), read: (n) => cell(n, 0, 0)?.colSpan ?? 1 }],
  "table.cellFormat": [{ node: "TABLE", make: () => newTable([[{ text: "a", bold: true, align: "CENTER" }, { text: "b" }]]), read: (n) => [cellBold(n, 0, 0), cell(n, 0, 0)?.align ?? "LEFT"] }],
  "table.formula": [{ node: "TABLE", make: () => newTable([[{ text: "1" }, { text: "2" }, { text: "3", formula: "A1+B1" }]]), read: (n) => cell(n, 0, 2)?.formula ?? null }],
  "table.numFmt": [{ node: "TABLE", make: () => newTable([[{ text: "1200", numFmt: '"$"#,##0' }, { text: "b" }]]), read: (n) => cell(n, 0, 0)?.numFmt ?? null }],
  ...fxBuilders(),
};

/** Layer effects: a vector, a raster layer and (shadow) a text box with one effect; read = its main parameters. */
function fxBuilders(): Record<string, Builder[]> {
  const summary = (e: Effect | undefined) => {
    if (!e) return null;
    switch (e.type) {
      case "dropShadow":
      case "innerShadow":
        return [e.type, e.distance.v, e.size.v, e.angle, e.opacity ?? 1];
      case "outerGlow":
      case "innerGlow":
        return [e.type, e.size.v, e.opacity ?? 1];
      case "softEdge":
        return [e.type, e.radius.v];
      case "fxStroke":
        return [e.type, e.stroke.width.v];
      default:
        return [e.type];
    }
  };
  const out: Record<string, Builder[]> = {};
  const types: EffectType[] = ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "fxStroke", "overlay", "softEdge", "bevel", "satin"];
  for (const type of types) {
    const fx = (): Effect[] => [{ ...newEffect(type), ...(type === "dropShadow" || type === "innerShadow" ? { distance: { v: 6, u: "px" }, size: { v: 8, u: "px" }, opacity: 0.6 } : {}) } as Effect];
    const read = (n: SceneNode) => summary(n.effects?.find((e) => e.type === type));
    out[`fx.${type}`] = [
      { node: "VECTOR", make: () => vec({ fill: "#4f7cff", effects: fx() } as any), read },
      { node: "RASTER", make: () => raster({ effects: fx() }), read },
      ...(type === "dropShadow" ? [{ node: "TEXT" as const, make: () => ({ ...text(), effects: fx() }) as SceneNode, read: (n: SceneNode) => (n.effects?.some((e) => e.type === type) ? type : null) }] : []),
    ];
  }
  return out;
}

/** Formats with a Node round trip (export and import through the registry), and the node kinds each can carry. */
const ROUND_TRIP: Partial<Record<CapFormat, { kinds: NodeType[] }>> = {
  pptx: { kinds: ["TEXT", "VECTOR", "TABLE", "RASTER"] },
  docx: { kinds: ["TEXT", "TABLE", "VECTOR", "RASTER"] },
  hwpx: { kinds: ["TEXT", "TABLE", "VECTOR", "RASTER"] },
  xlsx: { kinds: ["TABLE"] },
  // PSD writes every non-raster node through a canvas rasteriser (browser only): raster layers here
  psd: { kinds: ["RASTER"] },
};

interface MatrixCase {
  prop: string;
  format: CapFormat;
  level: CapLevel;
  /** written natively, not read back by Omniweave yet (caps.ts readGap) */
  readGap: boolean;
  builder: Builder;
}

/** Generate the cases from caps.ts; everything else is reported as pending. */
function generate(): { cases: MatrixCase[]; pending: string[] } {
  const cases: MatrixCase[] = [];
  const pending: string[] = [];
  for (const p of CAP_PROPS)
    for (const f of CAP_FORMATS) {
      const rt = ROUND_TRIP[f];
      const bs = (BUILDERS[p.id] ?? []).filter((b) => rt?.kinds.includes(b.node));
      if (!bs.length) pending.push(`${p.id} × ${f}`);
      for (const b of bs) cases.push({ prop: p.id, format: f, level: capOf(p.id, f, b.node), readGap: !!p.readGap?.includes(f), builder: b });
    }
  return { cases, pending };
}

async function roundTrip(format: CapFormat, node: SceneNode): Promise<Page[]> {
  const doc = newDocument("m");
  const page = newPage(format === "pptx" ? "SLIDE" : "DOCUMENT", format === "pptx" ? 1280 : 794, format === "pptx" ? 720 : 1123, "P");
  if (node.type === "TEXT" || node.type === "TABLE") node.transform = { ...node.transform, x: node.transform.x || 40, y: node.transform.y || 40 };
  page.nodes = [node];
  doc.pages = [page];
  const ex = EXPORTS.find((e) => e.id === format)!;
  const out = await ex.run(doc, page, { confirm: () => true });
  const bytes = typeof out === "string" ? new TextEncoder().encode(out) : out;
  const fmt = FORMATS.find((f) => f.id === format)!;
  const opened = await fmt.open!({ name: `m.${format}`, path: null, bytes }, { confirm: () => true });
  // a workbook opens as sheet grids: its tables are what a sheet lays out (printing, sending to a document)
  return expandSheetPages({ ...doc, pages: opened.pages ?? [] }).doc.pages;
}

const close = (a: unknown, b: unknown, rel: number): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * rel);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i], rel));
  return JSON.stringify(a) === JSON.stringify(b);
};

const { cases, pending } = generate();

describe("caps.ts round-trip matrix", () => {
  it("covers every property and format in the table (tested or pending, nothing silently skipped)", () => {
    const covered = new Set([...cases.map((c) => `${c.prop} × ${c.format}`), ...pending]);
    expect(covered.size).toBe(CAP_PROPS.length * CAP_FORMATS.length);
    expect(cases.length).toBeGreaterThan(60);
  });

  for (const c of cases)
    it(`${c.prop} × ${c.format} (${c.builder.node}): ${c.level}${c.readGap ? " (reader gap)" : ""}`, async () => {
      const orig = c.builder.make();
      const want = c.builder.read(orig);
      const back = (await roundTrip(c.format, structuredClone(orig))).flatMap((p) => p.nodes);
      const same = back.find((n) => n.type === orig.type);
      const got = same ? c.builder.read(same) : undefined;
      if (c.readGap) {
        expect(same && close(got, want, 0.005), "the reader reads it back now — remove the readGap entry in caps.ts").toBeFalsy();
        return;
      }
      switch (c.level) {
        case "native":
          expect(same, "node kind kept").toBeTruthy();
          expect(close(got, want, 0.005), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`).toBe(true);
          break;
        case "approx":
          expect(same, "node kind kept").toBeTruthy();
          expect(close(got, want, 0.1), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`).toBe(true);
          break;
        case "rasterize":
          expect(same, "not kept as the same editable kind").toBeFalsy();
          break;
        case "drop":
          expect(same && close(got, want, 0.005), `value survives — caps.ts under-claims (${JSON.stringify(got)})`).toBeFalsy();
          break;
      }
    });
});
