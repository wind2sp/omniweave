// Every key the UI asks for exists: literal t("…") keys in src, and keys built from registries
// (image ops, trace presets, crop ratios, animation presets, page / node kinds, quick tools).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTS } from "../src/i18n";
import { ANIM_PRESETS } from "../src/core/anim";
import { CROP_RATIOS } from "../src/core/crop";
import { OPS } from "../src/core/image/ops";
import { TRACE_PRESETS } from "../src/core/image/trace";
import { QUICK_TOOLS } from "../src/ui/shell/ToolsDialog";
import { TOOLS } from "../src/ui/shell/Ribbon";

const ko = DICTS.ko;
const hangul = /[가-힣]/;

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe("i18n keys used by the UI", () => {
  it("literal keys passed to t / tr / tx / tNow exist", () => {
    const missing: string[] = [];
    for (const f of files("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(?:t|tr|tx|tNow)\(\s*"((?:doc|dock|image|ribbon|shell|quick|cmd|menu|about|prefs|engine)\.[\w.\-]+)"/g))
        if (!(m[1] in ko)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/\btn\(\s*(?:t,\s*)?"([\w.\-]+)"/g))
        for (const k of [m[1], `${m[1]}_one`]) if (!(k in ko)) missing.push(`${f}: ${k}`);
      // any complete "engine.…" string — also keys picked inside a ternary or passed on to a helper
      for (const m of src.matchAll(/"(engine\.[\w.\-]*\w)"/g)) if (!(m[1] in ko) && !(`${m[1]}_one` in ko)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("registry-built keys exist wherever the registry text is Korean", () => {
    const need: string[] = [];
    const want = (key: string, fallback?: string) => {
      if (fallback === undefined || hangul.test(fallback)) need.push(key);
    };
    for (const op of OPS) {
      want(`image.op.${op.id}.label`, op.label);
      if (op.hint) want(`image.op.${op.id}.hint`, op.hint);
      want(`image.menu.group.${op.group}`);
      for (const p of op.params) {
        want(`image.op.${op.id}.param.${p.key}`, p.label);
        if (p.kind === "triple") p.labels.forEach((l, i) => want(`image.op.${op.id}.param.${p.key}.${i}`, l));
        if (p.kind === "choice") for (const o of p.options) want(`image.op.${op.id}.param.${p.key}.opt.${o.value}`, o.label);
      }
    }
    for (const p of TRACE_PRESETS) {
      want(`image.trace.preset.${p.id}.label`, p.label);
      want(`image.trace.preset.${p.id}.hint`, p.hint);
    }
    for (const r of CROP_RATIOS) want(`ribbon.cropRatio.${r.id}`, r.label);
    for (const k of Object.keys(ANIM_PRESETS)) {
      want(`doc.anim.${k}`);
      want(`dock.anim.preset.${k}`);
    }
    for (const k of ["DESIGN", "DOCUMENT", "SLIDE", "PDF", "MASTER"]) {
      want(`dock.kind.${k}`);
      want(`doc.kind.${k}`);
      want(`shell.pageKind.${k}`);
    }
    for (const k of ["RASTER", "VECTOR", "TEXT", "IMAGE", "PDF", "TABLE", "MEDIA"]) {
      want(`dock.node.${k}`);
      want(`ribbon.node.${k}`);
    }
    for (const q of QUICK_TOOLS) {
      want(`quick.${q.id}`);
      want(`image.quick.${q.id}.hint`);
      want(`image.quick.${q.id}.desc`);
    }
    for (const tl of TOOLS) want(`ribbon.tool.${tl.id}`);
    expect(need.filter((k) => !(k in ko))).toEqual([]);
  });

  it("Korean object particle matches the syllable before it (을 after a final consonant, 를 after a vowel)", () => {
    const final = (c: string) => (c.charCodeAt(0) - 0xac00) % 28;
    const bad: string[] = [];
    for (const [k, v] of Object.entries(ko))
      for (const m of v.matchAll(/([가-힣])(를|을)(?=[\s.,)·]|$)/g))
        if ((m[2] === "를") !== (final(m[1]) === 0)) bad.push(`${k}: ${m[0]}`);
    expect(bad).toEqual([]);
  });
});
