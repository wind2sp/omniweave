// docs/legal/IP_CHECKLIST.md §2-1: another company's product name is never what a feature or mode is called or "how"
// it works — "the AutoCAD way", "AutoCAD처럼", "AutoCAD のように", "像 AutoCAD 一样" — in any of the 4 languages.
// Naming a file format or the program a file came from (Word 문서, Illustrator 파일, DXF로 저장…) and stating what is
// compatible ("1 = single, as in Word") stay allowed.
import { describe, expect, it } from "vitest";
import { DICTS } from "../src/i18n";

const PRODUCTS = "(?:Word|Excel|PowerPoint|AutoCAD|Photoshop|Illustrator|Acrobat|InDesign|Hancom|한컴|한글 ?\\d{4})";
const LIKE = [
  new RegExp(`the ${PRODUCTS} way`, "i"),
  new RegExp(`${PRODUCTS}처럼`),
  new RegExp(`${PRODUCTS} ?(?:の|と同じ)ように`),
  new RegExp(`像 ?${PRODUCTS} ?一样`),
  new RegExp(`${PRODUCTS} (?:mode|tool|screen)\\b`, "i"),
  new RegExp(`${PRODUCTS} ?(?:모드|도구|화면)`),
  new RegExp(`${PRODUCTS} ?(?:モード|ツール|画面)`),
  new RegExp(`${PRODUCTS} ?(?:模式|工具|界面)`),
];

describe("IP: product names are not feature or mode names (IP_CHECKLIST §2-1)", () => {
  it("no UI string in ko / en / ja / zh describes a feature as another company's product", () => {
    const bad: string[] = [];
    for (const [lang, dict] of Object.entries(DICTS) as [string, Record<string, string>][])
      for (const [k, v] of Object.entries(dict)) if (typeof v === "string" && LIKE.some((re) => re.test(v))) bad.push(`${lang} ${k}: ${v}`);
    expect(bad).toEqual([]);
  });

  // §2-4: the slide placeholder / notes prompts are Omniweave's own wording, not the other program's prompt sentences
  it("slide placeholder prompts do not copy another program's prompt sentences", () => {
    const COPIED = [/^Click to add (?:title|subtitle|text|notes)$/i, /추가하려면 클릭하십시오/, /^单击此处添加/, /^(?:タイトル|サブタイトル|テキスト|ノート)を入力$/];
    const bad: string[] = [];
    for (const [lang, dict] of Object.entries(DICTS) as [string, Record<string, string>][])
      for (const k of ["slide.ph.title", "slide.ph.subtitle", "slide.ph.text", "slide.notes.prompt"]) {
        expect(dict[k], `${lang} ${k}`).toBeTruthy();
        if (COPIED.some((re) => re.test(dict[k]))) bad.push(`${lang} ${k}: ${dict[k]}`);
      }
    expect(bad).toEqual([]);
  });
});
