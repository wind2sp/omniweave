// 머리글/바닥글 of slides (PowerPoint 삽입 › 머리글/바닥글): the date, footer text and slide number a slide shows at its
// foot (Page.slideHf), drawn in PowerPoint's default places (date left, footer centre, number right, 12 pt grey) with
// the slide's master (core/headerFooter.ts renderMasterOf), and written as dt / ftr / sldNum placeholders
// (io/formats/pptx.ts slideHfXml) so PowerPoint's own dialog shows them checked.

import { DEFAULT_RUN, newParagraph, newText, type OmwDocument, type Page, type SlideHF, type TextNode } from "./types";

export type HfSlot = "dt" | "ftr" | "sldNum";

/** Box of a slot on a W × H slide as PowerPoint's default master places it: x, y, w, h px. */
export function hfBox(slot: HfSlot, W: number, H: number): [number, number, number, number] {
  const y = H * 0.9268, h = H * 0.0533;
  if (slot === "dt") return [W * 0.0375, y, W * 0.225, h];
  if (slot === "ftr") return [W * 0.3313, y, W * 0.3375, h];
  return [W * 0.7063, y, W * 0.225, h];
}

export const HF_ALIGN: Record<HfSlot, "LEFT" | "CENTER" | "RIGHT"> = { dt: "LEFT", ftr: "CENTER", sldNum: "RIGHT" };
export const HF_GREY = "#898989";

/** Today's date as the date slot shows it. */
export function hfDate(fmt: "ymd" | "long" | "mdy" = "ymd", now = new Date()): string {
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  if (fmt === "long") return `${y}년 ${m}월 ${d}일`; // i18n: keep (the Korean long date PowerPoint shows; its field is datetime1)
  if (fmt === "mdy") return `${m}/${d}/${y}`;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The number a slide shows: its place among the deck's slides (hidden ones count, as in PowerPoint). */
export function slideNumber(doc: Pick<OmwDocument, "pages">, page: Page): number {
  const slides = doc.pages.filter((p) => p.kind === "SLIDE");
  return Math.max(0, slides.findIndex((p) => p.id === page.id)) + 1;
}

/** The text of each slot a slide shows (in slot order); empty when it shows none. */
export function hfTexts(doc: Pick<OmwDocument, "pages">, page: Page, hf: SlideHF | undefined = page.slideHf): { slot: HfSlot; text: string }[] {
  if (!hf) return [];
  const out: { slot: HfSlot; text: string }[] = [];
  if (hf.date) out.push({ slot: "dt", text: hf.date.auto ? hfDate(hf.date.fmt) : hf.date.text });
  if (hf.footer) out.push({ slot: "ftr", text: hf.footer });
  if (hf.num) out.push({ slot: "sldNum", text: String(slideNumber(doc, page)) });
  return out;
}

const pt = (v: number, H: number) => ((v * 96) / 72) * (H / 720);

/** The text nodes a slide's foot is drawn with (not part of the slide's own content). */
export function hfNodes(doc: Pick<OmwDocument, "pages" | "theme">, page: Page): TextNode[] {
  const W = page.width, H = page.height;
  const color = doc.theme?.dark ? "#BFBFBF" : HF_GREY;
  const font = doc.theme?.minor ?? DEFAULT_RUN.fontFamily;
  return hfTexts(doc, page).map(({ slot, text }) => {
    const [x, y, w, h] = hfBox(slot, W, H);
    const n = newText("", w);
    n.id = `hf:${page.id}:${slot}`;
    n.name = slot;
    n.locked = true;
    n.paragraphs = [{ ...newParagraph(text, { fontSize: pt(12, H), color, fontFamily: font }, HF_ALIGN[slot]), lineSpacing: 1.2, spaceAfter: 0 }];
    // vertically centred in its box (PowerPoint's anchor="ctr")
    n.transform = { x, y: y + (h - pt(12, H) * 1.2) / 2, rotation: 0, scale: 1 };
    return n;
  });
}

/** Same settings (to keep the memo of the drawn nodes). */
export const hfKey = (doc: Pick<OmwDocument, "pages" | "theme">, page: Page) => (page.slideHf ? JSON.stringify([hfTexts(doc, page), page.width, page.height, doc.theme?.dark, doc.theme?.minor]) : "");
