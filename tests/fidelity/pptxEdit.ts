// "한 곳 편집 보존" for scripts/fidelity-pptx.mjs (docs/design/FIDELITY_PPTX.md): a deck opened in Omniweave, edited
// in one place and saved as PPTX — before (the whole deck written anew, exportPptx) and after (Office Surgeon stage 1,
// the app's own save). A save preserves the deck when the edit is in it and nothing else changed: the same package
// inventory (slides, shapes, pictures, groups, connectors, runs, media, notes, charts, animations, transitions,
// layouts, masters) and the same slide text read back. Counts and labels only — never deck content.

import { strFromU8, unzipSync } from "fflate";
import { newPage, newText, type OmwDocument, type Page, type SceneNode, type TextNode } from "../../src/core/types";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { sameTypeExport } from "../../src/io/formats";

export type Scenario = "text" | "move" | "slide";
export const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "text", label: "글자 하나 고치기" },
  { id: "move", label: "도형 하나 옮기기" },
  { id: "slide", label: "슬라이드 하나 추가" },
];

export function pptxInventory(bytes: Uint8Array): Record<string, number> {
  const names: string[] = [];
  const f = unzipSync(bytes, { filter: (x) => (names.push(x.name), /^ppt\/slides\/slide\d+\.xml$/.test(x.name)) });
  const slides = Object.values(f).map(strFromU8).join("");
  const n = (re: RegExp) => (slides.match(re) ?? []).length;
  const parts = (re: RegExp) => names.filter((x) => re.test(x)).length;
  return {
    슬라이드: parts(/^ppt\/slides\/slide\d+\.xml$/),
    도형: n(/<p:sp[\s>]/g),
    그림: n(/<p:pic[\s>]/g),
    "표·차트 틀": n(/<p:graphicFrame[\s>]/g),
    그룹: n(/<p:grpSp[\s>]/g),
    연결선: n(/<p:cxnSp[\s>]/g),
    "글자 런": n(/<a:r>/g),
    "미디어 파일": parts(/^ppt\/media\//),
    "발표자 노트": parts(/^ppt\/notesSlides\/notesSlide\d+\.xml$/),
    차트: parts(/^ppt\/charts\/chart\d+\.xml$/),
    SmartArt: parts(/^ppt\/diagrams\/data\d+\.xml$/),
    애니메이션: n(/<p:timing[\s>]/g),
    "애니메이션 효과": n(/presetClass="/g),
    "화면 전환": n(/<p:transition[\s>]/g),
    레이아웃: parts(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/),
    마스터: parts(/^ppt\/slideMasters\/slideMaster\d+\.xml$/),
  };
}

const plain = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const slideTexts = (bytes: Uint8Array) => importPptx(bytes, "x.pptx").pages.map((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").map(plain));

/** Node ids of each slide-tree element of a page (its map), the layout's copies left out. */
const elementsOf = (p: Page): string[][] => (p.source?.office?.parts.length === 1 ? p.source.office.parts[0].blocks.slice(2).map((b) => b.ids) : []);

/** The edit, applied to a copy of the document; null when the deck has nothing to edit that way. */
export function applyEdit(doc0: OmwDocument, what: Scenario): { doc: OmwDocument; where: string; added?: Page } | null {
  const doc = structuredClone(doc0) as OmwDocument;
  const pages = doc.pages;
  if (what === "slide") {
    const p = newPage("SLIDE", pages[0].width, pages[0].height, "new");
    const t = newText("Omniweave QA", 400);
    t.transform = { x: 80, y: 80, rotation: 0, scale: 1 };
    p.nodes = [t];
    pages.push(p);
    return { doc, where: `슬라이드 ${pages.length}`, added: p };
  }
  for (let si = 0; si < pages.length; si++) {
    const els = elementsOf(pages[si]);
    const byId = new Map(pages[si].nodes.map((n) => [n.id, n] as [string, SceneNode]));
    if (what === "text") {
      for (const ids of els)
        for (const id of ids) {
          const n = byId.get(id);
          if (n?.type !== "TEXT") continue;
          const p = n.paragraphs.find((x) => x.runs.some((r) => r.text.trim()));
          if (!p) continue;
          const runs = p.runs;
          let k = runs.length - 1;
          while (k > 0 && !runs[k].text) k--;
          runs[k].text += "~";
          return { doc, where: `슬라이드 ${si + 1}` };
        }
    } else {
      // a shape of one node (a picture, a plain shape) first, else a shape with its text, moved together
      const one = els.find((ids) => ids.length === 1 && byId.get(ids[0])?.type !== "TEXT") ?? els.find((ids) => ids.length > 0);
      if (!one) continue;
      for (const id of one) {
        const n = byId.get(id)!;
        n.transform = { ...n.transform, x: n.transform.x + 24, y: n.transform.y + 12 };
      }
      return { doc, where: `슬라이드 ${si + 1}` };
    }
  }
  return null;
}

export interface EditResult {
  scenario: Scenario;
  where: string;
  before: { kept: boolean; diffs: string[]; bytes: Uint8Array };
  after: { kept: boolean; diffs: string[]; bytes: Uint8Array; same: number };
}

/** Differences of a saved deck from the original beyond the edit itself. */
function judge(orig: Uint8Array, out: Uint8Array, what: Scenario, added?: Page): string[] {
  const a = pptxInventory(orig), b = pptxInventory(out);
  // the added slide: one text box of one run, and the transition of a new Omniweave slide
  const expect: Record<string, number> = added ? { 슬라이드: 1, 도형: 1, "글자 런": 1, "화면 전환": added.transition.type === "NONE" ? 0 : 1 } : {};
  const diffs = Object.keys(a).filter((k) => a[k] + (expect[k] ?? 0) !== b[k]).map((k) => `${k} ${a[k]}→${b[k]}`);
  const ta = slideTexts(orig), tb = slideTexts(out);
  let text = 0, hit = what !== "text";
  ta.forEach((s, i) =>
    s.forEach((x, k) => {
      const y = tb[i]?.[k];
      if (y === x) return;
      if (!hit && y !== undefined && y.replace("~", "") === x) hit = true;
      else text++;
    }),
  );
  if (text) diffs.push(`슬라이드 텍스트 ${text}곳 다름`);
  if (!hit) diffs.push("편집 반영 안 됨");
  if (what === "slide" && !tb[tb.length - 1]?.some((x) => x === "Omniweave QA")) diffs.push("새 슬라이드 없음");
  return diffs;
}

/** Package entries (by name) whose bytes are as in the original. */
function sameEntries(orig: Uint8Array, out: Uint8Array): number {
  const a = unzipSync(orig), b = unzipSync(out);
  return Object.keys(a).filter((k) => b[k] && b[k].length === a[k].length && b[k].every((v, i) => v === a[k][i])).length;
}

export async function editTest(doc0: OmwDocument, orig: Uint8Array, what: Scenario): Promise<EditResult | null> {
  const e = applyEdit(doc0, what);
  if (!e) return null;
  const { doc } = e;
  const before = (await exportPptx(doc, doc.pages)).bytes;
  const def = sameTypeExport(doc.pages[0])!;
  const after = (await def.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
  const bd = judge(orig, before, what, e.added), ad = judge(orig, after, what, e.added);
  return { scenario: what, where: e.where, before: { kept: !bd.length, diffs: bd, bytes: before }, after: { kept: !ad.length, diffs: ad, bytes: after, same: sameEntries(orig, after) } };
}
