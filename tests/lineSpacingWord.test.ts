// Line spacing "배수" = Word's multiple (제품 결정 2026-11-12 "워드 기준으로"): the font's single line × v, with HWPX staying
// 한글-native (percent of the size) and every existing document drawing exactly as before (core/lineSpacing.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { emOfWordMultiple, fontLineRatio, withWordDefaults, withWordMultiple, wordMultipleOf, WORD_DEFAULT_AFTER } from "../src/core/lineSpacing";
import { applyParaFormat, paraFormat, paraText } from "../src/core/richtext";
import { paraStyleFromParagraph, paragraphFromParaStyle } from "../src/core/style/text";
import { layoutText, lineHeightOf } from "../src/core/text";
import { newPage, newParagraph, newText, type OmwDocument, type Page, type TextNode, type TextParagraph } from "../src/core/types";
import { exportDocx, exportHwpx, hwpxLineSpacing, parseDocx, parseHwpx } from "../src/io/office";
import { exportPptx, importPptx } from "../src/io/formats/pptx";
import { packOmw, unpackOmw } from "../src/io/omw";
import { MODEL_VERSION, MODEL_WORD_MULTIPLE, preWordMultipleView } from "../src/io/officesurgeon/common";
import { paraDialogPatch, type ParaDialogState } from "../src/ui/shell/paraDialogPatch";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const PT = 96 / 72;
const P = (text: string, run: Partial<TextParagraph["runs"][0]> = {}, extra: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(text, run), ...extra });
const node = (paras: TextParagraph[], width = 600): TextNode => {
  const t = newText("", width);
  t.paragraphs = paras;
  return t;
};
const pageOf = (paras: TextParagraph[]): Page => {
  const pg = newPage("DOCUMENT", 794, 1123, "P");
  pg.nodes.push(node(paras));
  return pg;
};
/** median line pitch (pt) of paragraph `pi` of a laid-out node */
const pitchPt = (t: TextNode, pi: number) => {
  const ys = layoutText(t).lines.filter((l) => l.paragraph === pi).map((l) => l.y);
  const d = ys.slice(1).map((y, i) => y - ys[i]).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] / PT : NaN;
};
const LONG_KO = "한글 문단 줄 간격을 재는 문장입니다. ".repeat(12).trim();
const LONG_EN = "Line spacing measurement sentence for Word and PowerPoint. ".repeat(8).trim();

const textNodes = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT"));

describe("existing documents draw exactly as before", () => {
  for (const file of ["qa/samples/doc-features/omni-sample.omw", "docs/demo/omniweave-demo.omw"]) {
    // (layouts and HWPX / PPTX exports of both files were also compared with the code before this change: identical)
    it.skipIf(!existsSync(file))(`${file}: every percent paragraph's line is size × lineSpacing, as before`, () => {
      const { doc } = unpackOmw(new Uint8Array(readFileSync(file)));
      const ts = textNodes(doc);
      expect(ts.length).toBeGreaterThan(0);
      for (const t of ts) {
        // the demo predates Word multiples; the feature sample shows one (부록 B, 배수 2.0) next to its 200%
        if (file.includes("demo")) for (const p of t.paragraphs) expect(p.lineMultiple, paraText(p)).toBeUndefined();
        for (const l of layoutText(t).lines) {
          const p = t.paragraphs[l.paragraph];
          const size = Math.max(...l.pieces.map((x) => x.run.fontSize), 0) || p.runs[0]?.fontSize || 16;
          if (!p.lineHeight && !wordMultipleOf(p)) expect(l.height).toBe(size * p.lineSpacing);
        }
      }
      // saved again: the paragraphs are unchanged (no new field written)
      const again = unpackOmw(packOmw(doc).bytes).doc;
      expect(textNodes(again).map((t) => t.paragraphs)).toEqual(ts.map((t) => t.paragraphs));
    });
  }
});

describe("the model: a Word multiple next to the legacy lineSpacing", () => {
  it("lineSpacing holds the same height as a size multiple (what older apps draw)", () => {
    const p = withWordMultiple(P(LONG_KO, { fontFamily: "Pretendard", fontSize: 16 }), 1.5);
    expect(p.lineMultiple).toEqual({ v: 1.5, lineSpacing: 2.33 }); // 1.5 × 1.551
    expect(p.lineSpacing).toBe(2.33);
    expect(wordMultipleOf(p)).toBe(1.5);
    // an older app drawing size × lineSpacing is within 0.5% of our height
    const ours = lineHeightOf(p, 16);
    expect(Math.abs(16 * p.lineSpacing - ours) / ours).toBeLessThan(0.005);
  });
  it("a lineSpacing edited by an older app wins (the paragraph is a percent paragraph again)", () => {
    const p = { ...withWordMultiple(P("abc"), 2), lineSpacing: 1.6 };
    expect(wordMultipleOf(p)).toBeUndefined();
    expect(lineHeightOf(p, 20)).toBe(32);
  });
  it("ParaStyle: basis font ↔ the Word multiple, basis em ↔ percent", () => {
    const w = withWordMultiple(P("가나다"), 1.15);
    expect(paraStyleFromParagraph(w).lineHeight).toEqual({ mode: "multiple", v: 1.15, basis: "font" });
    expect(wordMultipleOf(paragraphFromParaStyle("x", w.runs, paraStyleFromParagraph(w)))).toBe(1.15);
    expect(paraStyleFromParagraph(P("a")).lineHeight).toEqual({ mode: "multiple", v: 1.6, basis: "em" });
  });
});

describe("layout: the font's single line × the multiple (measured in Word)", () => {
  it("Pretendard 1.551 and 맑은 고딕 1.729 per size, Latin and Hangul (Word's own PDF pitch)", () => {
    // Word (Microsoft 365) pitch, pt per pt of size at 1.0: Pretendard 1.548–1.554, 맑은 고딕 1.728–1.730, 바탕 1.296–1.302,
    // Calibri Latin 1.224, Arial Latin 1.152 (qa: office_pitch / embedded-Pretendard DOCX, 2026-11-12)
    const cases: [string, number, string, number][] = [
      ["Pretendard", 10, LONG_KO, 15.48], ["Pretendard", 12, LONG_EN, 18.6], ["Pretendard", 20, LONG_KO, 30.99],
      ["맑은 고딕", 10, LONG_KO, 17.28], ["맑은 고딕", 12, LONG_EN, 20.76], ["바탕", 12, LONG_KO, 15.6],
      ["Calibri", 12, LONG_EN, 14.64], ["Arial", 10, LONG_EN, 11.52],
    ];
    for (const [font, pt, text, wordPitch] of cases)
      for (const m of [1, 1.5, 2]) {
        const t = node([withWordMultiple(P(text, { fontFamily: font, fontSize: pt * PT }), m)]);
        expect(Math.abs(pitchPt(t, 0) - wordPitch * m), `${font} ${pt}pt ×${m}`).toBeLessThan(0.06 * m + 0.02);
      }
  });

  it("fonts not in the table: Korean fonts get one line for all text (Korean code page), Latin ones 1.2 + the 맑은 고딕 rule", async () => {
    const { fontLineRatios } = await import("../src/core/lineSpacing");
    // (winAscent + winDescent) × 1.3 from the font files: HY (H2*.TTF) 1.0 em, 나눔고딕 / 나눔명조 / 나눔바른고딕 1.15 em
    for (const f of ["HY견고딕", "HY중고딕", "HY헤드라인M", "HYGothic-Extra"]) expect(fontLineRatios(f), f).toEqual([1.3, 1.3]);
    for (const f of ["나눔고딕", "NanumGothic", "나눔명조", "NanumMyeongjo", "나눔바른고딕", "NanumBarunGothic"]) expect(fontLineRatios(f), f).toEqual([1.495, 1.495]);
    // unknown Korean fonts (Korean name or a Korean family prefix): measured Korean fonts span 1.30–1.73, 1.5 between
    for (const f of ["함초롬바탕", "HCR Batang", "함초롬돋움"]) expect(fontLineRatios(f), f).toEqual([1.69, 1.69]); // HANBatang win 1.3 em
    for (const f of ["KoPubWorld돋움체", "Noto Sans KR", "본고딕", "HCR Gothic"]) expect(fontLineRatios(f), f).toEqual([1.5, 1.5]);
    // unknown Latin fonts: 1.2, their Hangul drawn with the East Asian fallback (맑은 고딕)
    for (const f of ["Georgia", "Verdana", "", undefined]) expect(fontLineRatios(f), String(f)).toEqual([1.2, 1.729]);
  });

  it("mixed fonts on a line: each run's own text decides its single line (Latin text in Calibri, Hangul → 맑은 고딕 rule)", () => {
    // Calibri 20 pt "Title" + 맑은 고딕 10 pt Hangul: max(20 × 1.221, 10 × 1.729) = 24.42 pt, not 20 × 1.729
    const p = withWordMultiple({ ...P("Title ", { fontFamily: "Calibri", fontSize: 20 * PT }), runs: [{ ...newParagraph("Title ", { fontFamily: "Calibri", fontSize: 20 * PT }).runs[0] }, { ...newParagraph("가나다", { fontFamily: "맑은 고딕", fontSize: 10 * PT }).runs[0] }] }, 1);
    const l = layoutText(node([p])).lines[0];
    expect(l.height / PT).toBeCloseTo(24.42, 1);
    // Hangul in the Latin font itself: the East Asian fallback (맑은 고딕 1.729)
    const q = withWordMultiple(P("Title 가나다", { fontFamily: "Calibri", fontSize: 20 * PT }), 1);
    expect(layoutText(node([q])).lines[0].height / PT).toBeCloseTo(34.58, 1);
    // a Latin-only Calibri line next to a Hangul line of the same paragraph keeps Calibri's own line
    const r = withWordMultiple(P("Title\n가나다", { fontFamily: "Calibri", fontSize: 20 * PT }), 1);
    expect(layoutText(node([r])).lines.map((x) => Math.round((x.height / PT) * 100) / 100)).toEqual([24.42, 34.58]);
  });

  const WORD_MADE = join(process.cwd(), "qa/interop/word-made/omni-word-paragraphs.docx");
  it.skipIf(!existsSync(WORD_MADE))("Word-made omni-word-paragraphs.docx: 배수 1.0 / 1.5 / 2.0 pitch = Word's PDF (17.28 / 25.92 / 34.56 pt)", () => {
    const read = parseDocx(new Uint8Array(readFileSync(WORD_MADE)));
    // Word drew the file in its theme font 맑은 고딕 at 10 pt (no w:sz anywhere). The runs are set to exactly that so
    // this checks the line model alone, w:line 240 / 360 / 480 read as 1.0 / 1.5 / 2.0 (the import defaults: below).
    const ps = read.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, fontFamily: "맑은 고딕", fontSize: 10 * PT })) }));
    const t = node(ps, 794 - (2 * 1134) / 15); // A4 less Word's 2 cm margins (1134 twips)
    const after = (label: string) => ps.findIndex((p) => paraText(p).includes(label)) + 1;
    for (const [label, v, word] of [["배수 1.0", 1, 17.28], ["배수 1.5", 1.5, 25.92], ["배수 2.0", 2, 34.56]] as const) {
      const pi = after(label);
      expect(wordMultipleOf(ps[pi]), label).toBe(v);
      expect(Math.abs(pitchPt(t, pi) - word), label).toBeLessThan(0.05);
    }
  });
  it.skipIf(!existsSync(WORD_MADE))("Word-made omni-word-paragraphs.docx as imported: theme font 맑은 고딕, no w:sz = 10 pt, pitch = Word's PDF", () => {
    // docDefaults: rFonts asciiTheme minorHAnsi / eastAsiaTheme minorEastAsia (theme: latin 맑은 고딕, ea "", Hang 맑은
    // 고딕, lang eastAsia ko-KR), szCs 22 but no w:sz → Word draws 10 pt 맑은 고딕 (its PDF: MalgunGothic 10.0)
    const read = parseDocx(new Uint8Array(readFileSync(WORD_MADE)));
    const body = read.filter((p) => !p.role);
    for (const p of body) for (const r of p.runs) {
      expect(r.fontFamily, paraText(p)).toBe("맑은 고딕");
      expect(r.fontSize, paraText(p)).toBeCloseTo(10 * PT, 2);
    }
    const t = node(read, 794 - (2 * 1134) / 15);
    const after = (label: string) => read.findIndex((p) => paraText(p).includes(label)) + 1;
    for (const [label, word] of [["배수 1.0", 17.28], ["배수 1.5", 25.92], ["배수 2.0", 34.56], ["고정 18pt", 18]] as const)
      expect(Math.abs(pitchPt(t, after(label)) - word), label).toBeLessThan(0.05);
  });

  // Office Surgeon on the Word-made file: an edited paragraph keeps its runs' original w:rPr (theme fonts, no w:sz),
  // with a new map and with a map made by the importer before theme fonts / 10 pt (model 2, 11 pt Pretendard)
  const surgeonEdit = async (oldMap: boolean) => {
    const { exportById, formatForExt } = await import("../src/io/formats");
    const { docxMeta } = await import("../src/io/officesurgeon/docx");
    const { newDocument } = await import("../src/core/types");
    const orig = new Uint8Array(readFileSync(WORD_MADE));
    const opened = await formatForExt("docx")!.open({ name: "w.docx", path: null, bytes: orig }, {} as any);
    const doc = { ...newDocument("d"), pages: opened.pages, assets: (opened as any).assets ?? {} } as OmwDocument;
    const ts = doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT"));
    if (oldMap) {
      // what v0.1.2 made of the file: 11 pt Pretendard runs, Word's w:line kept in wordLine, no lineMultiple, and the
      // paragraph properties of the importer before Word styles (model 6: alignment, indents, keep flags from the paragraph only)
      const { docxContext, docxParagraph } = await import("../src/io/office");
      const files = unzipSync(orig);
      const before = Array.from(new DOMParser().parseFromString(strFromU8(files["word/document.xml"]), "text/xml").getElementsByTagNameNS("*", "p")).map(
        (e) => docxParagraph(e as unknown as Element, docxContext(files, true, true, true)).para,
      );
      const used = new Set<TextParagraph>();
      const oldProps = (p: TextParagraph) => {
        const o = before.find((x) => !used.has(x) && paraText(x) === paraText(p));
        if (!o) return {};
        used.add(o);
        const { id: _i, runs: _r, lineSpacing: _l, lineMultiple: _m, ...props } = o;
        return { keepNext: undefined, indentLeft: undefined, ...props };
      };
      for (const t of ts)
        t.paragraphs = t.paragraphs.map((p0) => {
          const p = { ...p0, ...oldProps(p0) } as TextParagraph;
          for (const k of Object.keys(p) as (keyof TextParagraph)[]) if (p[k] === undefined) delete p[k];
          const { lineMultiple, ...rest } = p;
          const runs = p.runs.map((r) => (p.role ? r : { ...r, fontFamily: "Pretendard", fontSize: 14.7 }));
          return lineMultiple ? { ...rest, runs, wordLine: { line: Math.round(lineMultiple.v * 240), lineSpacing: p.lineSpacing } } : { ...rest, runs };
        });
      const src = doc.pages[0].source!;
      const meta = docxMeta(doc.pages, src.office!.parts[0].blocks.map((b) => b.ids.length), { id: src.office!.assetId, hash: src.office!.hash })!;
      meta.model = 2;
      for (const pg of doc.pages) if (pg.source?.office) pg.source.office = meta;
    }
    const same = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(Buffer.from(same).equals(Buffer.from(orig)), "unchanged save").toBe(true);
    const t = ts.find((x) => x.paragraphs.some((p) => paraText(p).includes("[문자 간격 기본]")))!;
    const i = t.paragraphs.findIndex((p) => paraText(p).includes("[문자 간격 기본]")) + 1;
    const p = t.paragraphs[i];
    t.paragraphs = t.paragraphs.map((q, k) => (k === i ? { ...q, runs: q.runs.map((r, j) => (j === q.runs.length - 1 ? { ...r, text: r.text + " 끝" } : r)) } : q));
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    const para = /<w:p\b(?:(?!<\/w:p>).)*끝<\/w:t>(?:(?!<\/w:p>).)*<\/w:p>/s.exec(xml)?.[0] ?? "";
    expect(para, paraText(p)).toContain("끝");
    expect(para).not.toMatch(/<w:sz |w:rFonts|Pretendard/);
    // every other paragraph as it was
    const paras = (x: string) => x.match(/<w:p\b(?:(?!<\/w:p>).)*<\/w:p>/gs) ?? [];
    const before = paras(strFromU8(unzipSync(orig)["word/document.xml"]));
    const after = paras(xml);
    expect(after.length).toBe(before.length);
    expect(after.filter((x, k) => x !== before[k]).length).toBe(1);
  };
  it.skipIf(!existsSync(WORD_MADE))("Office Surgeon, new map: an edited Word paragraph keeps its theme-font runs as they were", () => surgeonEdit(false));
  it.skipIf(!existsSync(WORD_MADE))("Office Surgeon, map before model 3 (11 pt Pretendard import): the same", () => surgeonEdit(true));
});

describe("DOCX import defaults: theme fonts and Word's 10 pt", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const theme = (latin: string, ea: string, hang: string, jpan = "游明朝") =>
    `<?xml version="1.0" encoding="UTF-8"?><a:theme ${A}><a:themeElements><a:fontScheme name="x"><a:majorFont><a:latin typeface="Major Latin"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hang" typeface="Major Hang"/></a:majorFont><a:minorFont><a:latin typeface="${latin}"/><a:ea typeface="${ea}"/><a:cs typeface=""/><a:font script="Jpan" typeface="${jpan}"/><a:font script="Hang" typeface="${hang}"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const docx = async (styles: string, body: string, themeXml?: string) => {
    const { zipSync } = await import("fflate");
    const files = unzipSync(exportDocx([pageOf([P("x")])]));
    files["word/styles.xml"] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${styles}</w:styles>`);
    files["word/document.xml"] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
    if (themeXml) files["word/theme/theme1.xml"] = new TextEncoder().encode(themeXml);
    return parseDocx(zipSync(files));
  };
  const defaults = (rPr: string) => `<w:docDefaults><w:rPrDefault><w:rPr>${rPr}</w:rPr></w:rPrDefault></w:docDefaults>`;
  const para = (rPr = "", text = "가나다 abc") => `<w:p><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t>${text}</w:t></w:r></w:p>`;
  const THEMED = '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi"/>';

  it("no w:sz anywhere = 10 pt (Word), w:sz in docDefaults or the Normal style wins", async () => {
    expect((await docx(defaults('<w:szCs w:val="22"/>'), para()))[0].runs[0].fontSize).toBeCloseTo(10 * PT, 2);
    expect((await docx(defaults('<w:sz w:val="22"/>'), para()))[0].runs[0].fontSize).toBeCloseTo(11 * PT, 2);
    const normal = '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style>';
    expect((await docx(defaults('<w:sz w:val="22"/>') + normal, para()))[0].runs[0].fontSize).toBeCloseTo(12 * PT, 2);
    expect((await docx(defaults(""), para('<w:sz w:val="30"/>')))[0].runs[0].fontSize).toBeCloseTo(15 * PT, 2);
  });
  it("theme fonts: eastAsiaTheme → the theme's ea font, else its script font for the East Asian language; asciiTheme → latin", async () => {
    const ko = '<w:lang w:val="en-US" w:eastAsia="ko-KR"/>';
    expect((await docx(defaults(THEMED + ko), para(), theme("맑은 고딕", "", "맑은 고딕")))[0].runs[0].fontFamily).toBe("맑은 고딕");
    expect((await docx(defaults(THEMED + ko), para(), theme("Calibri", "", "바탕")))[0].runs[0].fontFamily).toBe("바탕");
    expect((await docx(defaults(THEMED + ko), para(), theme("Calibri", "굴림", "바탕")))[0].runs[0].fontFamily).toBe("굴림");
    expect((await docx(defaults(THEMED + '<w:lang w:eastAsia="ja-JP"/>'), para(), theme("Calibri", "", "바탕", "MS Mincho")))[0].runs[0].fontFamily).toBe("MS Mincho");
    // no East Asian font in the theme for the language: the latin theme font
    expect((await docx(defaults('<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>'), para(), theme("Calibri", "", "바탕")))[0].runs[0].fontFamily).toBe("Calibri");
    // a run's own theme reference
    expect((await docx(defaults(ko), para('<w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia"/>'), theme("Calibri", "", "바탕")))[0].runs[0].fontFamily).toBe("Major Hang");
    // explicit names still win over the defaults' theme
    expect((await docx(defaults(THEMED + ko), para('<w:rFonts w:ascii="Arial" w:eastAsia="굴림"/>'), theme("Calibri", "", "바탕")))[0].runs[0].fontFamily).toBe("굴림");
  });
});

describe("DOCX: lineRule auto ↔ the Word multiple, exactly", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docxOf = (body: string) => {
    const files = unzipSync(exportDocx([pageOf([P("x")])]));
    files["word/document.xml"] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
    return files;
  };
  const docXml = (pg: Page) => strFromU8(unzipSync(exportDocx([pg]))["word/document.xml"]);
  it("import reads v = w:line / 240 (no conversion) and export writes it back exactly", async () => {
    const { zipSync } = await import("fflate");
    for (const line of [240, 259, 264, 276, 300, 360, 480, 600])
      for (const font of ["Pretendard", "맑은 고딕", "Calibri"]) {
        const ps = parseDocx(zipSync(docxOf(`<w:p><w:pPr><w:spacing w:line="${line}" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/></w:rPr><w:t>가나다 abc</w:t></w:r></w:p>`)));
        expect(wordMultipleOf(ps[0])).toBe(line / 240);
        expect(ps[0].wordLine).toBeUndefined();
        expect(docXml(pageOf(ps))).toContain(`w:line="${line}" w:lineRule="auto"`);
      }
  });
  it("the paragraph dialog's 배수 2.0 → w:line 480 (and 1.15 → 276), whatever the font", () => {
    for (const [mult, line] of [[2, 480], [1.15, 276], [1.08, 259], [1, 240]] as const)
      for (const font of ["Pretendard", "맑은 고딕", "Arial"]) {
        const init: ParaDialogState = { align: "LEFT", left: 0, right: 0, firstMode: "none", first: 0, before: 0, after: 6, mode: "percent", mult: 1, pct: 160, pts: 12, keepNext: false, keepLines: false, breakBefore: false };
        const patch = paraDialogPatch(init, { ...init, mode: "multiple", mult }, 16);
        const ps = applyParaFormat([P("가나다 Omni", { fontFamily: font })], 0, 0, patch);
        expect(docXml(pageOf(ps)), `${font} ${mult}`).toContain(`w:line="${line}" w:lineRule="auto"`);
      }
  });
  it("percent paragraphs (older documents, HWPX) keep the height conversion; old DOCX imports keep their w:line", () => {
    // 200% of a Pretendard size → 2 ÷ 1.551 × 240 = 309.5 (Word draws it 2 × the size tall)
    expect(docXml(pageOf([P("가나다", {}, { lineSpacing: 2 })]))).toContain('w:line="309" w:lineRule="auto"');
    // a paragraph imported before Word multiples: its Word value as it was
    expect(docXml(pageOf([P("가나다", {}, { lineSpacing: 1.69, wordLine: { line: 259, lineSpacing: 1.69 } })]))).toContain('w:line="259" w:lineRule="auto"');
  });
  it("Office Surgeon: maps before model 3 compare the original in their older shape", () => {
    expect(MODEL_VERSION).toBe(11); // 4: heading styles, 5: pictures, 6: Word styles, 7: notes, 8: empty line after a table, 9: comments and tracked changes, 10: named paragraph styles, 11: shapes and text boxes (common.ts MODEL_WORD_MULTIPLE = 3 still decides this view)
    expect(MODEL_WORD_MULTIPLE).toBe(3);
    const read = withWordMultiple(P("가나다"), 259 / 240);
    const old = P("가나다", {}, { lineSpacing: 1.69, wordLine: { line: 259, lineSpacing: 1.69 } });
    const v = preWordMultipleView(read, old);
    expect(v.lineMultiple).toBeUndefined();
    expect(v.lineSpacing).toBe(1.69); // untouched: the stored lineSpacing
    expect(preWordMultipleView(read, { ...old, lineSpacing: 2 }).lineSpacing).toBe(read.lineSpacing); // edited: not the same
  });
});

describe("HWPX: 한글-native percent, unchanged", () => {
  const percents = (bytes: Uint8Array) => (strFromU8(unzipSync(bytes)["Contents/header.xml"]).match(/<hh:lineSpacing type="[A-Z_]+" value="\d+"/g) ?? []).sort();
  const files = ["qa/samples/doc-features/omni-sample.hwpx", ...["breaking", "controls", "margins", "ratio-spacing"].map((n) => `qa/interop/hancom-made/omni-hwp-${n}.hwpx`)];
  for (const f of files)
    it.skipIf(!existsSync(f))(`${f}: import → export writes the same line spacing values; import stays percent`, () => {
      const src = new Uint8Array(readFileSync(f));
      const ps = parseHwpx(src);
      expect(ps.every((p) => wordMultipleOf(p) === undefined)).toBe(true);
      const out = exportHwpx([pageOf(ps)], "t");
      const want = new Set(percents(src).map((s) => s.replace(/value="(\d+)"/, (_, v) => `value="${v}"`)));
      for (const v of new Set(percents(out))) expect(want.has(v) || /value="160"/.test(v), v).toBe(true);
      // every paragraph's own value comes back exactly
      const again = parseHwpx(out);
      expect(again.map((p) => hwpxLineSpacing(p))).toEqual(ps.map((p) => hwpxLineSpacing(p)));
    });
  it("a Word multiple is written as the PERCENT of the same height (Pretendard 1.08 → 168, 2.0 → 310)", () => {
    expect(hwpxLineSpacing(withWordMultiple(P("가나다"), 1.08))).toEqual({ type: "PERCENT", value: 168 });
    expect(hwpxLineSpacing(withWordMultiple(P("가나다"), 2))).toEqual({ type: "PERCENT", value: 310 });
    expect(hwpxLineSpacing(withWordMultiple(P("가나다", { fontFamily: "맑은 고딕" }), 1))).toEqual({ type: "PERCENT", value: 173 });
    // older percent paragraphs: 1:1 as before
    expect(hwpxLineSpacing(P("가나다", {}, { lineSpacing: 1.6 }))).toEqual({ type: "PERCENT", value: 160 });
  });
});

describe("PPTX: spcPct is 1.2 × the size in PowerPoint (measured), so it stays a percent of the size", () => {
  it("import keeps spcPct as before; a Word multiple exports at the same height; percent paragraphs as before", async () => {
    const slide = newPage("SLIDE", 1280, 720, "S");
    const t = node([P("가나다", { fontSize: 24 }, { lineSpacing: 1.8 }), withWordMultiple(P("가나다", { fontSize: 24 }), 1), withWordMultiple(P("Omni", { fontFamily: "Calibri", fontSize: 24 }), 1.5)], 800);
    t.transform = { x: 40, y: 40, rotation: 0, scale: 1 };
    slide.nodes.push(t);
    const doc: OmwDocument = { format: "omw", version: 1, id: "d", title: "", created: "", modified: "", pages: [slide], masters: [], assets: {} };
    const { bytes } = await exportPptx(doc, [slide]);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
    const pcts = [...xml.matchAll(/<a:spcPct val="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(pcts).toEqual([150000, Math.round((1.551 / 1.2) * 100000), Math.round(((1.5 * 1.221) / 1.2) * 100000)]);
    const back = importPptx(bytes, "x.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    // same heights back (percent of the size, as PowerPoint draws them)
    expect(back.paragraphs.map((p) => Math.round(p.lineSpacing * 100) / 100)).toEqual([1.8, 1.55, 1.83]);
  });
});

describe("new documents: Word's defaults; templates with their own spacing keep their look", () => {
  it("withWordDefaults: multiple 1.08, 8 pt after", () => {
    const p = withWordDefaults(P("새 문서"));
    expect(wordMultipleOf(p)).toBe(1.08);
    expect(p.spaceAfter).toBeCloseTo(8 * PT, 10);
    expect(p.lineSpacing).toBe(emOfWordMultiple(p, 1.08));
    expect(WORD_DEFAULT_AFTER).toBeCloseTo(10.6667, 3);
  });
  it("start-screen templates: the blank document gets them, the others are unchanged", async () => {
    const { TEMPLATES, buildTemplatePage } = await import("../src/ui/shell/templates");
    for (const tp of TEMPLATES) {
      const paras = buildTemplatePage(tp, false).nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs : []));
      if (tp.id === "doc-blank") expect(paras.every((p) => wordMultipleOf(p) === 1.08 && p.spaceAfter === WORD_DEFAULT_AFTER), tp.id).toBe(true);
      else expect(paras.every((p) => p.lineMultiple === undefined), tp.id).toBe(true);
    }
  });
});

describe("editing: the ribbon / dialog values", () => {
  it("paraFormat reports the Word multiple (null for percent paragraphs) and the ratio between them", () => {
    const ps = [withWordMultiple(P("a"), 1.15), withWordMultiple(P("b"), 1.15)];
    expect(paraFormat(ps, 0, 1).lineMultiple).toBe(1.15);
    expect(paraFormat([P("a")], 0, 0).lineMultiple).toBeNull();
    expect(paraFormat([ps[0], P("b")], 0, 1).lineMultiple).toBeUndefined();
    expect(paraFormat([P("가", { fontFamily: "맑은 고딕" })], 0, 0).lineRatio).toBe(fontLineRatio("맑은 고딕", "가"));
  });
  it("a lineSpacing patch (percent field) ends the Word multiple; a lineMultiple patch sets it and clears an exact height", () => {
    const w = withWordMultiple(P("a"), 2);
    expect(applyParaFormat([w], 0, 0, { lineSpacing: 1.6 })[0].lineMultiple).toBeUndefined();
    const ex = P("a", {}, { lineHeight: { mode: "exact", v: { v: 18, u: "pt" } } });
    const r = applyParaFormat([ex], 0, 0, { lineMultiple: 1.5 })[0];
    expect(r.lineHeight).toBeUndefined();
    expect(wordMultipleOf(r)).toBe(1.5);
  });
});
