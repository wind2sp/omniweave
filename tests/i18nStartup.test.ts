// Engine text that is produced before the UI language is known (module load) or off the UI thread (image worker).
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relabelStartDocument, useHistory } from "../src/core/history";
import { useStore } from "../src/core/store";
import { useLang } from "../src/i18n";

afterEach(() => useLang.getState().set("ko", false));

describe("first document follows the chosen UI language", () => {
  it("the document made at module load is remade in the language picked at startup", () => {
    // module load ran in Korean (the language is only settled afterwards by initLang)
    expect(useStore.getState().doc.pages[0].name).toBe("아트보드 1");
    useLang.getState().set("en", false);
    relabelStartDocument();
    const s = useStore.getState();
    expect(s.doc.pages[0].name).toBe("Artboard 1");
    expect(s.doc.pages[0].nodes[0].name).toBe("Background raster");
    expect(s.pageId).toBe(s.doc.pages[0].id);
    expect(useHistory.getState().entries.map((e) => e.label)).toEqual(["New document"]);
  });

  it("leaves a document alone once something was done or opened", () => {
    useLang.getState().set("en", false);
    useStore.getState().set({ dirty: true } as any);
    const before = useStore.getState().doc;
    useLang.getState().set("ja", false);
    relabelStartDocument();
    expect(useStore.getState().doc).toBe(before);
    useStore.getState().set({ dirty: false } as any);
  });
});

/** value imports reachable from a module (type-only imports skipped) */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)([\s\S]*?)\bfrom\s+"(\.[^"]+)"/gm)) {
      const spec = m[1].trim();
      if (/^\{[^}]*\}$/.test(spec) && spec.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
      const p = join(dirname(f), m[2]);
      const hit = [p + ".ts", p + ".tsx", join(p, "index.ts"), p].find((c) => existsSync(c) && statSync(c).isFile());
      if (hit) stack.push(hit);
    }
  }
  return [...seen];
}

describe("image worker bundle", () => {
  it("does not pull in the language files (errors go back as codes and are translated on the UI thread)", () => {
    const deps = reachable(join("src", "core", "image", "worker.ts"));
    expect(deps.filter((f) => f.split(/[\\/]/).includes("i18n"))).toEqual([]);
  });
});
