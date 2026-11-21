// QA (cad-text): a text drawn as several nodes — the upper part of each MTEXT stack (\S) is a text of its own — must
// still be one object on the drawing screen: picked, moved, copied, erased, re-layered and saved together, and an
// EXPLODE of a dimension keeps its tolerance stack whole.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type Page, type TextNode } from "../../src/core/types";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { arrayRect, cancel, eraseNodes, explodeNodes, submit, textParts, transformNodes } from "../../src/ui/cad/engine";
import { moveToLayer } from "../../src/ui/cad/CadScreen";
import { translate } from "../../src/ui/cad/geom";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { useLang } from "../../src/i18n";
import { cssFont } from "../../src/core/text";
import { CJK_FALLBACK } from "../../src/io/formats/cad/build";

useLang.getState().set("ko", false);
const S = () => useStore.getState();
const pg = () => currentPage()!;
const texts = (p: Page = pg()) => p.nodes.filter((n) => n.type === "TEXT") as TextNode[];
const plain = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const byText = (s: string, p?: Page) => texts(p).filter((n) => plain(n) === s);
const host = () => texts().find((n) => plain(n).includes("분수"))!;

async function open(name: string) {
  S().load(newDocument());
  resetSessionsForTest();
  cancel(true);
  await openInTab({ name: `${name}-2018.dxf`, path: null, bytes: new Uint8Array(readFileSync(`qa/interop/autocad-made/${name}-2018.dxf`)) });
  S().set({ selection: [] });
}

describe("stacked MTEXT stays one object on the drawing screen", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(() => open("omni-cad-03-text"));

  it("the text and its stack tops share a text group under the layer", () => {
    const h = host();
    const g = pg().groups!.find((x) => x.id === h.groupId)!;
    expect(g.cad?.text).toBe(true);
    expect(pg().groups!.find((x) => x.id === g.parentId)?.cad?.layer).toBeTruthy();
    for (const up of ["1", "5", "3"]) expect(byText(up)[0].groupId, up).toBe(g.id);
    // picking any part takes the whole text
    expect(new Set(textParts(pg(), [byText("1")[0].id]))).toEqual(new Set(pg().nodes.filter((n) => n.groupId === g.id).map((n) => n.id)));
  });

  it("MOVE of the text (selected alone) takes its stack tops along", () => {
    const h = host(), up = byText("1")[0];
    const dx = up.transform.x - h.transform.x, dy = up.transform.y - h.transform.y;
    S().set({ selection: [h.id] });
    submit("M");
    submit("0,0");
    submit("@10,5");
    const h2 = pg().nodes.find((n) => n.id === h.id)!, up2 = pg().nodes.find((n) => n.id === up.id)!;
    expect(h2.transform.x).not.toBeCloseTo(h.transform.x, 3);
    expect(up2.transform.x - h2.transform.x).toBeCloseTo(dx, 6);
    expect(up2.transform.y - h2.transform.y).toBeCloseTo(dy, 6);
  });

  it("COPY and ARRAY copy the stack tops into a text group of their own", () => {
    const h = host();
    const g0 = h.groupId!;
    const made = transformNodes("copy", [h.id], translate(50, 0), true);
    expect(made.length).toBe(4);
    expect(byText("1").length).toBe(2);
    const copyG = new Set(made.map((id) => pg().nodes.find((n) => n.id === id)!.groupId));
    expect(copyG.size).toBe(1);
    expect(copyG.has(g0)).toBe(false);
    expect(pg().groups!.find((x) => x.id === [...copyG][0])?.cad?.text).toBe(true);
    // the original's parts are still only its own
    expect(pg().nodes.filter((n) => n.groupId === g0).length).toBe(4);
    const arr = arrayRect([h.id], 2, 1, 0, 30);
    expect(arr.length).toBe(4);
    expect(new Set(arr.map((id) => pg().nodes.find((n) => n.id === id)!.groupId)).size).toBe(1);
  });

  it("ERASE of the text erases its stack tops (no group left behind)", () => {
    const h = host(), g = h.groupId;
    eraseNodes([h.id]);
    expect(byText("1").length).toBe(0);
    expect(byText("5").length).toBe(0);
    expect(pg().groups!.some((x) => x.id === g)).toBe(false);
  });

  it("a layer change moves the whole text, still one group", () => {
    const h = host();
    // 03 draws on layer 0 only: a second layer to move to
    const id = pg().id;
    S().commit("layer", (d) => {
      const p = d.pages.find((x) => x.id === id)!;
      p.groups!.push({ id: "g-qa-notes", name: "QA-NOTES", parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { layer: "QA-NOTES", color: "#ff0000" } });
    });
    const other = pg().groups!.find((x) => x.id === "g-qa-notes")!;
    moveToLayer(pg(), [h.id], other.cad!.layer!);
    const g = pg().groups!.find((x) => x.id === pg().nodes.find((n) => n.id === h.id)!.groupId)!;
    expect(g.cad?.text).toBe(true);
    expect(g.parentId).toBe(other.id);
    expect(byText("1")[0].groupId).toBe(g.id);
  });

  it("saves to .omw and reopens with the text group", () => {
    const back = unpackOmw(packOmw(S().doc).bytes).doc.pages[0];
    const h = texts(back).find((n) => plain(n).includes("분수"))!;
    expect(back.groups!.find((x) => x.id === h.groupId)?.cad?.text).toBe(true);
    expect(byText("1", back)[0].groupId).toBe(h.groupId);
  });
});

describe("굴림 fallback where 굴림 is missing (web, macOS)", () => {
  it("the fallback runs name Korean system / bundled fonts after Gulim, so Hangul never drops out", () => {
    const f = cssFont({ fontSize: 10, fontFamily: CJK_FALLBACK, bold: false, italic: false });
    for (const k of ["Gulim", "Apple SD Gothic Neo", "Noto Sans KR", "Pretendard"]) expect(f, k).toContain(k);
  });
});

describe("tolerance dimension", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(() => open("omni-cad-06-dims"));

  it("EXPLODE of the dimension (picked on its text) frees the block, the stack stays one text", () => {
    const low = byText("50-0,05")[0], up = byText("+0,1")[0];
    const tg = pg().groups!.find((x) => x.id === low.groupId)!;
    expect(tg.cad?.text).toBe(true);
    const block = tg.parentId;
    expect(pg().groups!.find((x) => x.id === block)?.cad?.layer).toBeFalsy();
    expect(explodeNodes([low.id])).toBe(1);
    expect(pg().groups!.some((x) => x.id === block)).toBe(false);
    const g2 = pg().groups!.find((x) => x.id === pg().nodes.find((n) => n.id === low.id)!.groupId)!;
    expect(g2.cad?.text).toBe(true);
    expect(pg().nodes.find((n) => n.id === up.id)!.groupId).toBe(g2.id);
  });
});
