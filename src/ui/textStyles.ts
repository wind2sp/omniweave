// Character and paragraph styles (Illustrator's Character Styles / Paragraph Styles panels): named sets of text
// attributes kept with the document. A style is made from the selected text, applied to selected text objects (every
// run / paragraph of them), redefined from the selection (every text that uses it follows), renamed and deleted (the
// text keeps its look). Runs and paragraphs remember the style they use (TextRun.charStyle / TextParagraph.paraStyle).

import { draftPage, selectedNodes, useStore } from "../core/store";
import type { OmwDocument, TextNode, TextParagraph, TextRun } from "../core/types";
import { t } from "../i18n";

const S = () => useStore.getState();

/** The run attributes a style carries. */
export const RUN_KEYS = ["fontFamily", "fontSize", "bold", "italic", "underline", "strike", "color", "letterSpacing"] as const;
/** The paragraph attributes a paragraph style carries (with the run attributes of its first run). */
export const PARA_KEYS = ["align", "lineSpacing", "indent", "indentLeft", "spaceAfter"] as const;

export type RunLook = Partial<Pick<TextRun, (typeof RUN_KEYS)[number]>>;
export type ParaLook = Partial<Pick<TextParagraph, (typeof PARA_KEYS)[number]>>;
export interface CharStyleDef {
  id: string;
  name: string;
  run: RunLook;
}
export interface ParaStyleDef {
  id: string;
  name: string;
  para: ParaLook;
  run: RunLook;
}
export interface TextStyles {
  char: CharStyleDef[];
  para: ParaStyleDef[];
}
export type StyleKind = keyof TextStyles;

type StyledDoc = OmwDocument & { textStyles?: TextStyles };

export const stylesOf = (doc: OmwDocument): TextStyles => (doc as StyledDoc).textStyles ?? { char: [], para: [] };

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

const selectedTexts = () => selectedNodes().filter((n): n is TextNode => n.type === "TEXT");
const newId = () => "ts_" + Math.random().toString(36).slice(2, 10);

/** The look of the first selected text (its first run / paragraph), or null when no text is selected. */
function sampleLook(): { run: RunLook; para: ParaLook } | null {
  const n = selectedTexts()[0];
  const p = n?.paragraphs[0];
  const r = p?.runs[0];
  if (!p || !r) return null;
  return { run: pick(r, RUN_KEYS), para: pick(p, PARA_KEYS) };
}

/** Every text node of the document (pages and masters), for redefining and deleting styles. */
function allTexts(d: OmwDocument): TextNode[] {
  return [...d.pages, ...d.masters].flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT"));
}

function stylesDraft(d: OmwDocument): TextStyles {
  const sd = d as StyledDoc;
  if (!sd.textStyles) sd.textStyles = { char: [], para: [] };
  return sd.textStyles;
}

/** A new style from the selected text's look (named "문자 스타일 1" … unless `name` is given); returns its id. */
export function newStyle(kind: StyleKind, name?: string): string | null {
  const look = sampleLook() ?? { run: {}, para: {} };
  const list = stylesOf(S().doc)[kind];
  const id = newId();
  let n = list.length + 1;
  const base = kind === "char" ? t("design.styles.charName") : t("design.styles.paraName");
  while (list.some((s) => s.name === `${base} ${n}`)) n++;
  const def = kind === "char" ? { id, name: name ?? `${base} ${n}`, run: look.run } : { id, name: name ?? `${base} ${n}`, para: look.para, run: look.run };
  S().commit(t("design.styles.hist.new"), (d) => {
    (stylesDraft(d as OmwDocument)[kind] as (CharStyleDef | ParaStyleDef)[]).push(def as never);
  });
  return id;
}

function applyChar(r: TextRun, def: CharStyleDef) {
  Object.assign(r, def.run);
  (r as TextRun & { charStyle?: string }).charStyle = def.id;
}
function applyPara(p: TextParagraph, def: ParaStyleDef) {
  Object.assign(p, def.para);
  (p as TextParagraph & { paraStyle?: string }).paraStyle = def.id;
  for (const r of p.runs) Object.assign(r, def.run);
}

/** Apply a style to the selected text objects (all their runs, or all their paragraphs). */
export function applyStyle(kind: StyleKind, id: string): number {
  const ids = selectedTexts().map((n) => n.id);
  const def = stylesOf(S().doc)[kind].find((s) => s.id === id);
  if (!ids.length || !def) return 0;
  S().commit(t("design.styles.hist.apply", { name: def.name }), (d) => {
    const pg = draftPage(d, S().pageId);
    for (const n of pg?.nodes ?? [])
      if (n.type === "TEXT" && ids.includes(n.id))
        for (const p of n.paragraphs) {
          if (kind === "para") applyPara(p, def as ParaStyleDef);
          else for (const r of p.runs) applyChar(r, def as CharStyleDef);
        }
  });
  return ids.length;
}

/** Redefine a style from the selected text's look; every text using it anywhere in the document follows. */
export function redefineStyle(kind: StyleKind, id: string): boolean {
  const look = sampleLook();
  if (!look) return false;
  S().commit(t("design.styles.hist.redefine"), (d) => {
    const st = stylesDraft(d as OmwDocument);
    const def = st[kind].find((s) => s.id === id);
    if (!def) return;
    def.run = look.run;
    if (kind === "para") (def as ParaStyleDef).para = look.para;
    for (const n of allTexts(d as OmwDocument))
      for (const p of n.paragraphs) {
        if (kind === "para" && (p as TextParagraph & { paraStyle?: string }).paraStyle === id) applyPara(p, def as ParaStyleDef);
        if (kind === "char") for (const r of p.runs) if ((r as TextRun & { charStyle?: string }).charStyle === id) applyChar(r, def as CharStyleDef);
      }
  });
  return true;
}

export function renameStyle(kind: StyleKind, id: string, name: string) {
  const v = name.trim();
  if (!v) return;
  S().commit(t("design.styles.hist.rename"), (d) => {
    const def = stylesDraft(d as OmwDocument)[kind].find((s) => s.id === id);
    if (def) def.name = v;
  });
}

/** Delete a style; the text that used it keeps its look and loses the link. */
export function deleteStyle(kind: StyleKind, id: string) {
  S().commit(t("design.styles.hist.delete"), (d) => {
    const st = stylesDraft(d as OmwDocument);
    st[kind] = (st[kind] as (CharStyleDef | ParaStyleDef)[]).filter((s) => s.id !== id) as never;
    for (const n of allTexts(d as OmwDocument))
      for (const p of n.paragraphs) {
        const pp = p as TextParagraph & { paraStyle?: string };
        if (kind === "para" && pp.paraStyle === id) delete pp.paraStyle;
        if (kind === "char") for (const r of p.runs) if ((r as TextRun & { charStyle?: string }).charStyle === id) delete (r as TextRun & { charStyle?: string }).charStyle;
      }
  });
}

/** The style the selected text uses (its first run / paragraph), for the panel's highlight. */
export function currentStyleId(kind: StyleKind): string | undefined {
  const p = selectedTexts()[0]?.paragraphs[0];
  if (!p) return undefined;
  return kind === "para" ? (p as TextParagraph & { paraStyle?: string }).paraStyle : (p.runs[0] as TextRun & { charStyle?: string } | undefined)?.charStyle;
}
