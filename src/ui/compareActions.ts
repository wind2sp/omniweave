// 문서 비교 (Word 검토 ▸ 비교 ▸ 비교): the document open now is the original; the person picks the revised file. A new
// tab "비교 결과" holds the revised document with every change against the original marked as a tracked change
// (core/docCompare.ts) — accept / reject them in 검토, save as DOCX (w:ins / w:del). The original's tab is unchanged.

import { compareParagraphs } from "../core/docCompare";
import { gatherStory, reflowSegment, segments } from "../core/flow";
import { activeSessionId, newSession, removeSession, switchTo } from "../core/sessions";
import { useStore } from "../core/store";
import type { Page } from "../core/types";
import { t } from "../i18n";
import { openFilters } from "../io/formats";
import { openFiles } from "../io/platform";
import { importFile } from "./actions";

const S = () => useStore.getState();

/** The body stories of a document, segment by segment (paragraphs only). */
const stories = (pages: readonly Page[]) => segments(pages).map((seg) => ({ seg, story: gatherStory(pages, seg) }));

export async function compareDocuments(): Promise<boolean> {
  const orig = S().doc;
  const origStories = stories(orig.pages);
  if (!origStories.length) {
    S().notify(t("doccompare.noBody"));
    return false;
  }
  const files = await openFiles(openFilters(), false);
  const f = files[0];
  if (!f) return false;
  const from = activeSessionId();
  const id = newSession(t("doccompare.title", { name: f.name.replace(/\.[^.]+$/, "") }));
  let pages: Page[] = [];
  try {
    pages = await importFile(f);
  } catch {
    pages = [];
  }
  const rev = S().doc.pages;
  const revStories = stories(rev);
  if (!pages.length || !revStories.length) {
    removeSession(id);
    switchTo(from);
    S().notify(t("doccompare.noBody"));
    return false;
  }
  // segment by segment (the first ones when the counts differ, the rest of the original against the last)
  let out = rev as Page[];
  let changes = 0;
  const author = f.name.replace(/\.[^.]+$/, "");
  for (let k = revStories.length - 1; k >= 0; k--) {
    const a = k < origStories.length ? origStories[k].story.paras : [];
    const extra = k === revStories.length - 1 ? origStories.slice(revStories.length).flatMap((x) => x.story.paras) : [];
    const res = compareParagraphs([...a, ...extra], revStories[k].story.paras, { author });
    changes += res.changes;
    out = reflowSegment(out, revStories[k].seg.start, { ...revStories[k].story, paras: res.paras });
  }
  S().commit(t("doccompare.hist"), (d) => {
    d.pages = out as typeof d.pages;
    d.title = t("doccompare.title", { name: author });
  });
  S().notify(changes ? t("doccompare.done", { n: changes }) : t("doccompare.same"));
  return true;
}
