// Spelling (맞춤법 검사) in the document mode: Word's red wavy underline under misspelled words of the body text, table
// cells and notes, checked by Windows (ISpellChecker through src-tauri/src/spell.rs — the language packs the user has,
// no dictionary in the installer). Words are checked a batch at a time once typing pauses, only those of the pages
// painted (the page on screen first), and remembered per language. The underline is drawn on the screen canvas only:
// exports, prints, thumbnails and saved files never contain it. Right click on an underlined word: suggestions,
// 모두 무시 (Windows Ignore, this session), 사전에 추가 (Windows Add: the user's own Windows dictionary).
// The web version has no checker (the review tab says so).

import { create } from "zustand";
import { invertTransform } from "../core/geom";
import { replaceInRuns, tableMarks, textMarks, wavePoints, type SpellMark } from "../core/spell";
import { draftPage, useStore, type View } from "../core/store";
import type { Page, SceneNode, TableNode, TextNode, Vec2 } from "../core/types";
import { isTauri } from "../io/platform";
import { t as tr } from "../i18n";
import { docModeNow } from "./docView";

const KEY = "omw.spell";
const readOn = () => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

interface SpellState {
  /** checking on (검토 ▸ 맞춤법 검사; remembered on this PC) */
  on: boolean;
  /** bumps when results arrive (repaint, menus) */
  epoch: number;
  /** languages in the document Windows cannot check (no spelling for that language pack) */
  missing: string[];
  set: (p: Partial<SpellState>) => void;
}

export const useSpell = create<SpellState>((set) => ({ on: readOn(), epoch: 0, missing: [], set: (p) => set(p) }));

/** Spelling can run here at all (the Windows app; the browser has no checker). */
export const spellAvailable = () => isTauri;

export function setSpellOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private window: on for this session only */
  }
  useSpell.setState({ on });
  repaint?.();
}

const active = () => isTauri && useSpell.getState().on && docModeNow();

// ───────── checking (batched, after typing pauses) ─────────

/** lang + NUL + word → misspelled */
const verdict = new Map<string, boolean>();
const unsupported = new Set<string>();
const queue = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let repaint: (() => void) | null = null;

const kOf = (lang: string, word: string) => `${lang}\u0000${word}`;

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Misspelled per what is known; an unknown word is queued and counts as right until Windows answers. */
export function isBad(word: string, lang: string): boolean {
  if (unsupported.has(lang)) return false;
  const v = verdict.get(kOf(lang, word));
  if (v !== undefined) return v;
  let q = queue.get(lang);
  if (!q) queue.set(lang, (q = new Set()));
  q.add(word);
  if (timer) clearTimeout(timer);
  // checked once typing has paused (each keystroke repaints and so pushes this back)
  timer = setTimeout(() => void flush(), 400);
  return false;
}

async function flush() {
  timer = null;
  if (busy) {
    timer = setTimeout(() => void flush(), 200);
    return;
  }
  busy = true;
  let changed = false;
  try {
    for (const [lang, set] of [...queue]) {
      queue.delete(lang);
      const words = [...set].filter((w) => !verdict.has(kOf(lang, w)));
      for (let i = 0; i < words.length; i += 500) {
        const part = words.slice(i, i + 500);
        try {
          const bad = await invoke<boolean[]>("spell_check", { lang, words: part });
          part.forEach((w, j) => verdict.set(kOf(lang, w), !!bad[j]));
          changed = true;
        } catch (e) {
          if (String(e).includes("unsupported")) {
            unsupported.add(lang);
            useSpell.setState((s) => ({ missing: s.missing.includes(lang) ? s.missing : [...s.missing, lang] }));
          } else part.forEach((w) => verdict.set(kOf(lang, w), false));
          break;
        }
      }
    }
  } finally {
    busy = false;
  }
  if (changed) {
    useSpell.setState((s) => ({ epoch: s.epoch + 1 }));
    repaint?.();
  }
}

// ───────── drawing ─────────

/** The Latin-text language of a page's document (TextNode.lang from DOCX w:lang), en-US when none says. */
function latinOf(page: Page): string {
  for (const n of page.nodes) if (n.type === "TEXT" && n.lang) return n.lang;
  // (frames the body flow made later may not carry it: the document's first one that does)
  for (const p of useStore.getState().doc.pages) for (const n of p.nodes) if (n.type === "TEXT" && n.lang) return n.lang;
  return "en-US";
}

const marksMemo = new WeakMap<SceneNode, { epoch: number; latin: string; marks: SpellMark[] }>();

function marksOf(n: TextNode | TableNode, latin: string): SpellMark[] {
  const epoch = useSpell.getState().epoch;
  const m = marksMemo.get(n);
  if (m && m.epoch === epoch && m.latin === latin) return m.marks;
  const marks = n.type === "TEXT" ? textMarks(n, isBad, n.lang ?? latin) : tableMarks(n, isBad, latin);
  marksMemo.set(n, { epoch, latin, marks });
  return marks;
}

const checked = (n: SceneNode): n is TextNode | TableNode => n.visible && (n.type === "TEXT" || n.type === "TABLE");

/**
 * The wavy underlines of a page's misspelled words, over what the renderer drew (the screen canvas, `c` in device
 * pixels; `view` places the page). `skip`: the text node being edited in place (its editor shows it).
 */
export function drawSpelling(c: CanvasRenderingContext2D, page: Page, view: View, dpr: number, again: () => void, skip?: string | null) {
  repaint = again;
  if (!active()) return;
  const latin = latinOf(page);
  c.save();
  c.strokeStyle = "#e5262c";
  c.lineJoin = "round";
  for (const n of page.nodes) {
    if (!checked(n) || n.id === skip) continue;
    const marks = marksOf(n, latin);
    if (!marks.length) continue;
    const t = n.transform;
    const sx = t.scale || 1, sy = t.scaleY ?? sx;
    c.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, view.panX * dpr, view.panY * dpr);
    c.translate(t.x, t.y);
    if (t.rotation) c.rotate((t.rotation * Math.PI) / 180);
    c.scale(sx, sy);
    // one screen pixel (at least one device pixel) wide, waves 2 px high and 4 px long on screen, whatever the zoom
    const css = 1 / (view.zoom * Math.abs(sy));
    c.lineWidth = Math.max(1 / dpr, 1) * css;
    c.beginPath();
    for (const m of marks)
      for (const s of m.segs) {
        const pts = wavePoints(s.x0, s.x1, s.y, 2 * css, 4 * css);
        c.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) c.lineTo(p[0], p[1]);
      }
    c.stroke();
  }
  c.restore();
}

// ───────── right click ─────────

export interface SpellHit {
  pageId: string;
  nodeId: string;
  mark: SpellMark;
}

/** The underlined word under a page point, or null. */
export function spellAt(page: Page, p: Vec2): SpellHit | null {
  if (!active()) return null;
  const latin = latinOf(page);
  for (const n of [...page.nodes].reverse()) {
    if (!checked(n)) continue;
    const [x, y] = invertTransform(n.transform, p);
    for (const m of marksOf(n, latin))
      for (const s of m.segs) if (x >= s.x0 - 1 && x <= s.x1 + 1 && y >= s.y - s.size * 1.05 && y <= s.y + s.size * 0.35) return { pageId: page.id, nodeId: n.id, mark: m };
  }
  return null;
}

export async function suggestionsFor(m: SpellMark): Promise<string[]> {
  try {
    return await invoke<string[]>("spell_suggest", { lang: m.lang, word: m.word });
  } catch {
    return [];
  }
}

function forget(m: SpellMark) {
  verdict.set(kOf(m.lang, m.word), false);
  useSpell.setState((s) => ({ epoch: s.epoch + 1 }));
  repaint?.();
}

/** 모두 무시: the word is right everywhere for the rest of this session (Windows Ignore). */
export function ignoreAll(m: SpellMark) {
  forget(m);
  void invoke("spell_ignore", { lang: m.lang, word: m.word }).catch(() => {});
}

/** 사전에 추가: into the user's Windows dictionary for the language (Windows Add; every app using it sees it). */
export function addToDictionary(m: SpellMark) {
  forget(m);
  void invoke("spell_add", { lang: m.lang, word: m.word }).catch(() => {});
}

/** Replace the word with a suggestion (one undo step; a flowing body flows again on its own). */
export function replaceWord(h: SpellHit, text: string) {
  const { mark: m } = h;
  useStore.getState().commit(tr("spell.hist.replace"), (d) => {
    const n = draftPage(d, h.pageId)?.nodes.find((x) => x.id === h.nodeId);
    if (!n) return;
    if (n.type === "TEXT") {
      const p = n.paragraphs[m.para];
      if (p) p.runs = replaceInRuns(p.runs as never, m.start, m.end, text) as never;
      return;
    }
    if (n.type !== "TABLE" || !m.cell) return;
    const cell = n.rows[m.cell.r]?.[m.cell.c];
    if (!cell) return;
    if (m.cell.rich && cell.richText?.[m.para]) {
      const p = cell.richText[m.para];
      p.runs = replaceInRuns(p.runs as never, m.start, m.end, text) as never;
      cell.text = cell.richText.map((q) => q.runs.map((r) => r.text).join("")).join("\n");
    } else cell.text = cell.text.slice(0, m.start) + text + cell.text.slice(m.end);
  });
}
