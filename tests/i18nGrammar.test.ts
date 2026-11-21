// Proofreading guards for the language files (app UI and the 4-language homepage):
// - Korean: no fixed particle glued to an interpolated value ("{name}을", "{n}이", "{fmt}로" …) — whether it
//   should be 을 or 를 depends on the value, so such sentences are written so the particle follows a fixed word
//   ("{name} 파일을", "{fmt} 형식으로"). Also 으로/로 must match the syllable before it.
// - en / zh / ja: no Hangul left, and on the homepage the same {placeholders} as Korean.
// - ja has no Simplified-Chinese-only glyphs; zh has no kana.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTS } from "../src/i18n";

type Json = string | Json[] | { [k: string]: Json };
const SITE_LANGS = ["ko", "en", "zh", "ja"] as const;
const site = Object.fromEntries(
  SITE_LANGS.map((l) => [l, flatten(JSON.parse(readFileSync(`website/i18n/${l}.json`, "utf8")) as Json)]),
) as Record<(typeof SITE_LANGS)[number], Record<string, string>>;

function flatten(v: Json, p = "", out: Record<string, string> = {}): Record<string, string> {
  if (typeof v === "string") out[p] = v;
  else if (Array.isArray(v)) v.forEach((x, i) => flatten(x, `${p}[${i}]`, out));
  else for (const [k, x] of Object.entries(v)) flatten(x, p ? `${p}.${k}` : k, out);
  return out;
}

const all = (lang: "ko" | "en" | "zh" | "ja") => [
  ...Object.entries(DICTS[lang]).map(([k, v]) => [`app ${k}`, v] as const),
  ...Object.entries(site[lang]).map(([k, v]) => [`site ${k}`, v] as const),
];

/** particles whose form depends on the final consonant of the word before them */
const VARIABLE_PARTICLE = /\{\w+\}(?:\*\*)?(을|를|이|가|은|는|와|과|으로|로|이나|나|이며|며|이라|라|이랑|랑)(?![가-힣])/;

const NOUNS_ENDING_IN_RO = new Set(["경로", "회로", "통로", "도로", "진로", "미로", "선로"]);

describe("Korean particles", () => {
  it("no particle that depends on 받침 is glued to a {placeholder}", () => {
    const bad = all("ko").filter(([, v]) => VARIABLE_PARTICLE.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
  });

  it("the particle checker itself flags the cases it is meant to", () => {
    for (const s of ["{name}을(를) 열지 못했습니다", "{fmt}로 내보냈습니다", "{n}이 남았습니다", "**새 버전 {version}**이"])
      expect(VARIABLE_PARTICLE.test(s), s).toBe(true);
    for (const s of ["{name} 파일을 열지 못했습니다", "{n}개를", "{n}쪽을", "{name}에서", "{title}의", "{n}가지"])
      expect(VARIABLE_PARTICLE.test(s), s).toBe(false);
  });

  it("으로 / 로 matches the syllable before it (로 after a vowel or ㄹ, 으로 after other finals)", () => {
    const final = (c: string) => (c.charCodeAt(0) - 0xac00) % 28;
    const bad: string[] = [];
    for (const [k, v] of all("ko"))
      for (const m of v.matchAll(/([가-힣])(으로|로)(?=[\s.,)·:]|$)/g)) {
        if (m[2] === "로" && /[으]/.test(m[1])) continue; // "으로" itself, seen from its second syllable
        if (NOUNS_ENDING_IN_RO.has(m[0])) continue; // 경로 (path) is a noun, not 경 + 로
        const f = final(m[1]);
        const wantsRo = f === 0 || f === 8; // no final consonant, or ㄹ
        if ((m[2] === "로") !== wantsRo) bad.push(`${k}: ${m[0]}`);
      }
    expect(bad).toEqual([]);
  });
});

describe("translations", () => {
  const hangul = /[가-힣]/;

  it("homepage en / zh / ja have no Korean left (except the Korean name of the language itself)", () => {
    const bad: string[] = [];
    for (const l of ["en", "zh", "ja"] as const)
      for (const [k, v] of Object.entries(site[l])) if (hangul.test(v.replace(/한국어|오메/g, ""))) bad.push(`${l} ${k}: ${v}`);
    expect(bad).toEqual([]);
  });

  it("homepage placeholders match Korean in every language", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    const bad: string[] = [];
    for (const l of ["en", "zh", "ja"] as const)
      for (const [k, v] of Object.entries(site.ko)) if (ph(site[l][k] ?? "") !== ph(v)) bad.push(`${l} ${k}`);
    expect(bad).toEqual([]);
  });

  it("Japanese uses Japanese glyphs (no Simplified-Chinese-only forms)", () => {
    const simplified = /[图层导删选设这们么为对时会说从产发应间页简换转复颜边线连关开压录击动态纸载输显语读个]/;
    const bad = all("ja").filter(([, v]) => simplified.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
  });

  it("house style: en says Couldn't, ja says ビデオ・オーディオ, zh uses half-width () only around ASCII", () => {
    expect(all("en").filter(([, v]) => /\bCould not\b/.test(v)).map(([k]) => k)).toEqual([]);
    expect(Object.entries(DICTS.ja).filter(([, v]) => /動画|音声/.test(v)).map(([k]) => k)).toEqual([]);
    const ascii = /^[\x00-\x7f×–—·…→↔°%]*$/;
    const bad: string[] = [];
    for (const [k, v] of all("zh")) {
      if (k === "site index.name.p1") continue; // the 欧梅 name story is written as-is on purpose
      for (const m of v.matchAll(/\(([^()]*)\)/g)) if (!ascii.test(m[1])) bad.push(`${k}: ${m[0]} → （）`);
      for (const m of v.matchAll(/（([^（）]*)）/g)) if (ascii.test(m[1])) bad.push(`${k}: ${m[0]} → ()`);
    }
    expect(bad).toEqual([]);
  });

  it("Chinese has no Japanese kana", () => {
    const bad = all("zh").filter(([, v]) => /[ぁ-ヿ]/.test(v.replace(/オメ/g, ""))).map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
  });
});
