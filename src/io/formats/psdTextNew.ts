// A type tool block (TySh) made from scratch for a text box drawn here, so a new PSD opens with an editable text
// layer in Photoshop instead of a picture of the text: the text engine data (font, size, colour, tracking, leading,
// alignment, horizontal / vertical, point / paragraph text) in the structure Photoshop writes (the reference files
// qa/interop/adobe-made/fidelity/omni-fid-text-*.psd), the text descriptor, and an empty warp. The layer's pixels
// stay our drawing of the text (Photoshop shows them until it composes the text again).

import { applyTransform } from "../../core/geom";
import { verticalLayout } from "../../core/textVertical";
import type { TextNode } from "../../core/types";
import { descBytes, type Desc, type DVal } from "./psdFx";
import { fmtFloat, uString, writeEngineData, type EVal } from "./psdText";
import { writeTyShData } from "./psdText";

const D = (items: [string, EVal][]): EVal => ({ t: "dict", items });
const A = (v: EVal[]): EVal => ({ t: "arr", v });
const S = (s: string): EVal => uString(s);
const F = (n: number): EVal => ({ t: "atom", v: fmtFloat(n) });
const I = (n: number): EVal => ({ t: "atom", v: String(Math.round(n)) });
const B = (b: boolean): EVal => ({ t: "atom", v: b ? "true" : "false" });
const color = (hex: string): EVal => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex) ?? ["", "00", "00", "00"];
  return D([["Type", I(1)], ["Values", A([F(1), ...[m[1], m[2], m[3]].map((h) => F(Math.round((parseInt(h, 16) / 255) * 1e5) / 1e5))])]]);
};

/** PostScript name Photoshop looks a family up by (the common Korean and Latin faces; else the family without spaces). */
export function postScriptName(family: string, bold: boolean, italic: boolean): string {
  const f = family.trim().toLowerCase().replace(/\s+/g, " ");
  const table: Record<string, [string, string]> = {
    "malgun gothic": ["MalgunGothic", "MalgunGothicBold"],
    "\uB9D1\uC740 \uACE0\uB515": ["MalgunGothic", "MalgunGothicBold"],
    pretendard: ["Pretendard-Regular", "Pretendard-Bold"],
    "noto sans kr": ["NotoSansKR-Regular", "NotoSansKR-Bold"],
    "nanum gothic": ["NanumGothic", "NanumGothicBold"],
    "nanum myeongjo": ["NanumMyeongjo", "NanumMyeongjoBold"],
    batang: ["Batang", "Batang"],
    gulim: ["Gulim", "Gulim"],
    arial: ["ArialMT", "Arial-BoldMT"],
    georgia: ["Georgia", "Georgia-Bold"],
    consolas: ["Consolas", "Consolas-Bold"],
    "times new roman": ["TimesNewRomanPSMT", "TimesNewRomanPS-BoldMT"],
  };
  const hit = table[f];
  if (hit) return bold ? hit[1] : hit[0];
  const base = family.replace(/\s+/g, "");
  return bold && italic ? `${base}-BoldItalic` : bold ? `${base}-Bold` : italic ? `${base}-Italic` : base;
}

const PARA_PROPS = (just: number, autoLeading: number, mojiKumi: boolean): [string, EVal][] => [
  ["Justification", I(just)],
  ["FirstLineIndent", F(0)],
  ["StartIndent", F(0)],
  ["EndIndent", F(0)],
  ["SpaceBefore", F(0)],
  ["SpaceAfter", F(0)],
  ["AutoHyphenate", B(false)],
  ["HyphenatedWordSize", I(6)],
  ["PreHyphen", I(2)],
  ["PostHyphen", I(2)],
  ["ConsecutiveHyphens", I(8)],
  ["Zone", F(36)],
  ["WordSpacing", A([F(0.8), F(1), F(1.33)])],
  ["LetterSpacing", A([F(0), F(0), F(0)])],
  ["GlyphSpacing", A([F(1), F(1), F(1)])],
  ["AutoLeading", F(autoLeading)],
  ["LeadingType", I(0)],
  ["Hanging", B(false)],
  ["Burasagari", B(false)],
  ["KinsokuOrder", I(0)],
  ...(mojiKumi ? ([["Kinsoku", I(0)], ["MojiKumi", I(1)]] as [string, EVal][]) : []),
  ["EveryLineComposer", B(false)],
];

const STYLE = (o: { font: number; size: number; bold: boolean; italic: boolean; leading: number | null; tracking: number; color: string; vertical: boolean }): [string, EVal][] => [
  ["Font", I(o.font)],
  ["FontSize", F(o.size)],
  ["FauxBold", B(o.bold)],
  ["FauxItalic", B(o.italic)],
  ["AutoLeading", B(o.leading === null)],
  ["Leading", F(o.leading ?? 0)],
  ["HorizontalScale", F(1)],
  ["VerticalScale", F(1)],
  ["Tracking", I(o.tracking)],
  ["AutoKerning", B(true)],
  ["Kerning", I(0)],
  ["BaselineShift", F(0)],
  ["FontCaps", I(0)],
  ["FontBaseline", I(0)],
  ["Underline", B(false)],
  ["Strikethrough", B(false)],
  ["Ligatures", B(true)],
  ["DLigatures", B(false)],
  ["BaselineDirection", I(2)],
  ["Tsume", F(0)],
  ["StyleRunAlignment", I(2)],
  ["Language", I(0)],
  ["NoBreak", B(false)],
  ["FillColor", color(o.color)],
  ["StrokeColor", color("#000000")],
  ["FillFlag", B(true)],
  ["StrokeFlag", B(false)],
  ["FillFirst", B(true)],
  ["YUnderline", I(1)],
  ["OutlineWidth", F(1)],
  ["CharacterDirection", I(0)],
  ["HindiNumbers", B(false)],
  ["Kashida", I(1)],
  ["DiacriticPos", I(2)],
];

const KINSOKU: EVal = A([
  D([
    ["Name", S("PhotoshopKinsokuHard")],
    ["NoStart", S("、。，．・：；？！ー―’”）〕］｝〉》」』】ヽヾゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ゛゜?!)]},.:;℃℉¢％‰")],
    ["NoEnd", S("‘“（〔［｛〈《「『【([{￥＄£＠§〒＃")],
    ["Keep", S("―‥")],
    ["Hanging", S("、。.,")],
  ]),
  D([
    ["Name", S("PhotoshopKinsokuSoft")],
    ["NoStart", S("、。，．・：；？！’”）〕］｝〉》」』】ヽヾゝゞ々")],
    ["NoEnd", S("‘“（〔［｛〈《「『【")],
    ["Keep", S("―‥")],
    ["Hanging", S("、。.,")],
  ]),
]);

function resources(fontNames: string[]): EVal {
  return D([
    ["KinsokuSet", KINSOKU],
    ["MojiKumiSet", A([1, 2, 3, 4].map((k) => D([["InternalName", S(`Photoshop6MojiKumiSet${k}`)]])))],
    ["TheNormalStyleSheet", I(0)],
    ["TheNormalParagraphSheet", I(0)],
    ["ParagraphSheetSet", A([D([["Name", S("Normal RGB")], ["DefaultStyleSheet", I(0)], ["Properties", D(PARA_PROPS(0, 1.2, false))]])])],
    ["StyleSheetSet", A([D([["Name", S("Normal RGB")], ["StyleSheetData", D(STYLE({ font: fontNames.length, size: 12, bold: false, italic: false, leading: null, tracking: 0, color: "#000000", vertical: false }))]])])],
    ["FontSet", A([...fontNames.map((fontName) => D([["Name", S(fontName)], ["Script", I(/[\uAC00-\uD7A3]|Malgun|Gulim|Batang|Nanum|Noto|Pretendard/.test(fontName) ? 4 : 0)], ["FontType", I(1)], ["Synthetic", I(0)]])), D([["Name", S("AdobeInvisFont")], ["Script", I(0)], ["FontType", I(0)], ["Synthetic", I(0)]])])],
    ["SuperscriptSize", F(0.583)],
    ["SuperscriptPosition", F(0.333)],
    ["SubscriptSize", F(0.583)],
    ["SubscriptPosition", F(0.333)],
    ["SmallCapSize", F(0.7)],
  ]);
}

/** The empty warp (warpNone) and the four bounds Photoshop writes after the text descriptor. */
const WARP_TAIL = "00010000001000000001000000000004776172700000000500000009776172705374796c65656e756d00000009776172705374796c6500000008776172704e6f6e65000000097761727056616c7565646f756200000000000000000000000f776172705065727370656374697665646f75620000000000000000000000147761727050657273706563746976654f74686572646f756200000000000000000000000a77617270526f74617465656e756d000000004f726e740000000048727a6e00000000000000000000000000000000";
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

const ALIGN: Record<string, number> = { LEFT: 0, RIGHT: 1, CENTER: 2, JUSTIFY: 3 };

/**
 * TySh data for a text box on the page: its first character run's font, size, colour, bold / italic and tracking,
 * the first paragraph's alignment and line spacing; horizontal text as paragraph text in its box (it wraps here at
 * its width), vertical text as point text from the top of its right-hand column; the box's turn and scale go into the
 * text transform.
 */
export function newTextTySh(n: TextNode, height: number): Uint8Array {
  const p0 = n.paragraphs[0];
  const r0 = p0?.runs[0];
  const size = r0?.fontSize ?? 24;
  const lineSpacing = p0?.lineSpacing ?? 1.2;
  const vertical = !!n.vertical;
  const paras = n.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
  const full = paras.join("\r") + "\r";
  // every character run with its own look (font, size, colour, bold / italic, tracking); the paragraph mark joins the
  // paragraph's last run; neighbouring runs that look the same are one run, as Photoshop keeps them
  const fonts: string[] = [];
  const fontIndex = (name: string) => {
    let i = fonts.indexOf(name);
    if (i < 0) i = fonts.push(name) - 1;
    return i;
  };
  const runs: { key: string; len: number; style: EVal }[] = [];
  for (const p of n.paragraphs) {
    const rs = p.runs.length ? p.runs : r0 ? [{ ...r0, text: "" }] : [];
    rs.forEach((r, ri) => {
      const len = r.text.length + (ri === rs.length - 1 ? 1 : 0);
      if (!len) return;
      const ps = postScriptName(r.fontFamily ?? "Malgun Gothic", !!r.bold, !!r.italic);
      const sz = r.fontSize ?? size;
      // tracking in 1/1000 em (the run's letter spacing, px)
      const tracking = sz ? ((r.letterSpacing ?? 0) / sz) * 1000 : 0;
      const o = { font: fontIndex(ps), size: sz, bold: !!r.bold && !/bold/i.test(ps), italic: !!r.italic && !/italic/i.test(ps), leading: sz * (p.lineSpacing || lineSpacing), tracking, color: r.color ?? "#000000", vertical };
      const key = JSON.stringify(o);
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.len += len;
      else runs.push({ key, len, style: D([["StyleSheet", D([["StyleSheetData", D(STYLE(o))]])]]) });
    });
  }
  if (!fonts.length) fonts.push(postScriptName("Malgun Gothic", false, false));
  const paraOf = (p: TextNode["paragraphs"][number]) => D([["ParagraphSheet", D([["DefaultStyleSheet", I(0)], ["Properties", D(PARA_PROPS(ALIGN[p.align ?? "LEFT"] ?? 0, 1.2, true))]])], ["Adjustments", D([["Axis", A([F(1), F(0), F(1)])], ["XY", A([F(0), F(0)])]])]]);
  const box = !vertical;
  const dir = vertical ? 2 : 0;
  const v = verticalLayout(n);
  const w = vertical ? v.w : n.width, h = vertical ? v.h : Math.max(height, size * lineSpacing);
  const shape = D([
    ["ShapeType", I(box ? 1 : 0)],
    ["Procession", I(vertical ? 1 : 0)],
    ["Lines", D([["WritingDirection", I(dir)], ["Children", A([])]])],
    [
      "Cookie",
      D([
        [
          "Photoshop",
          D([
            ["ShapeType", I(box ? 1 : 0)],
            box ? ["BoxBounds", A([F(0), F(0), F(w), F(h)])] : ["PointBase", A([F(0), F(0)])],
            ["Base", D([["ShapeType", I(box ? 1 : 0)], ["TransformPoint0", A([F(1), F(0)])], ["TransformPoint1", A([F(0), F(1)])], ["TransformPoint2", A([F(0), F(0)])]])],
          ]),
        ],
      ]),
    ],
  ]);
  const engine = D([
    [
      "EngineDict",
      D([
        ["Editor", D([["Text", S(full)]])],
        ["ParagraphRun", D([["DefaultRunData", D([["ParagraphSheet", D([["DefaultStyleSheet", I(0)], ["Properties", D([])]])], ["Adjustments", D([["Axis", A([F(1), F(0), F(1)])], ["XY", A([F(0), F(0)])]])]])], ["RunArray", A(n.paragraphs.map(paraOf))], ["RunLengthArray", A(paras.map((p) => I(p.length + 1)))], ["IsJoinable", I(1)]])],
        ["StyleRun", D([["DefaultRunData", D([["StyleSheet", D([["StyleSheetData", D([])]])]])], ["RunArray", A(runs.map((r) => r.style))], ["RunLengthArray", A(runs.map((r) => I(r.len)))], ["IsJoinable", I(2)]])],
        ["GridInfo", D([["GridIsOn", B(false)], ["ShowGrid", B(false)], ["GridSize", F(18)], ["GridLeading", F(22)], ["GridColor", D([["Type", I(1)], ["Values", A([F(0), F(0), F(0), F(1)])]])], ["GridLeadingFillColor", D([["Type", I(1)], ["Values", A([F(0), F(0), F(0), F(1)])]])], ["AlignLineHeightToGridFlags", B(false)]])],
        ["AntiAlias", I(4)],
        ["UseFractionalGlyphWidths", B(true)],
        ["Rendered", D([["Version", I(1)], ["Shapes", D([["WritingDirection", I(dir)], ["Children", A([shape])]])]])],
      ]),
    ],
    ["ResourceDict", resources(fonts)],
    ["DocumentResources", resources(fonts)],
  ]);
  const ed = writeEngineData(engine);
  const raw = new Uint8Array(4 + ed.length);
  new DataView(raw.buffer).setUint32(0, ed.length);
  raw.set(ed, 4);
  // the text origin: a paragraph box's top-left; vertical point text: the top of its right-hand column's centre line
  const colW = size * Math.max(1, lineSpacing);
  // the box's turn, flip and scale as the text transform; its origin through the layer's transform
  const tr = n.transform;
  const ang = (tr.rotation * Math.PI) / 180, sx = tr.scale, sy = tr.scaleY ?? tr.scale;
  const [tx, ty] = applyTransform(tr, [vertical ? w - colW / 2 : 0, 0]);
  const m = [sx * Math.cos(ang), sx * Math.sin(ang), -sy * Math.sin(ang), sy * Math.cos(ang), tx, ty];
  const rect = (l: number, t: number, r: number, b: number, cls = "bounds"): DVal => ({ t: "Objc", v: { name: "\u0000", cls, items: [["Left", { t: "UntF", unit: "#Pxl", v: l }], ["Top ", { t: "UntF", unit: "#Pxl", v: t }], ["Rght", { t: "UntF", unit: "#Pxl", v: r }], ["Btom", { t: "UntF", unit: "#Pxl", v: b }]] } });
  const bb = vertical ? ([-(w - colW / 2), 0, colW / 2, h] as const) : ([0, 0, w, h] as const);
  const desc: Desc = {
    name: "\u0000",
    cls: "TxLr",
    items: [
      ["Txt ", { t: "TEXT", v: paras.join("\r") + "\u0000" }],
      ["textGridding", { t: "enum", type: "textGridding", v: "None" }],
      ["Ornt", { t: "enum", type: "Ornt", v: vertical ? "Vrtc" : "Hrzn" }],
      ["AntA", { t: "enum", type: "Annt", v: "antiAliasSharp" }],
      ["TxMP", { t: "bool", v: false }],
      ["bounds", rect(...bb)],
      ["boundingBox", rect(...bb, "boundingBox")],
      ["TextIndex", { t: "long", v: 0 }],
      ["EngineData", { t: "raw", type: "tdta", bytes: raw }],
    ],
  };
  void descBytes;
  return writeTyShData({ version: 1, transform: m, textVersion: 50, desc, engine, tail: hexBytes(WARP_TAIL) });
}
