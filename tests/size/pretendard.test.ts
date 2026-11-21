// The app gets Pretendard Regular/Bold from the packed files (public/fonts/*.ttpack): one fetch + unpack per weight,
// shared by the UI (FontFace) and PDF export (fontkit). docs/design/INSTALLER_SIZE.md §7.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const ttf = (w: string) => readFileSync(`assets/fonts/Pretendard-${w}.ttf`);
const pack = (w: string) => readFileSync(`public/fonts/Pretendard-${w}.ttpack`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal("document", { baseURI: "https://app.test/app/" });
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    const m = /Pretendard-(\w+)\.ttpack$/.exec(String(url));
    return m ? new Response(new Uint8Array(pack(m[1]))) : new Response(null, { status: 404 });
  });
  return calls;
}

describe("Pretendard from the packed files", () => {
  it("pretendardTtf gives the original TTF bytes, fetched once per weight", async () => {
    const calls = stubFetch();
    const { pretendardTtf } = await import("../../src/io/pretendard");
    const [r, b, r2] = await Promise.all([pretendardTtf("regular"), pretendardTtf("bold"), pretendardTtf("regular")]);
    expect(Buffer.from(r).equals(ttf("Regular"))).toBe(true);
    expect(Buffer.from(b).equals(ttf("Bold"))).toBe(true);
    expect(r2).toBe(r);
    expect(calls).toEqual(["https://app.test/app/fonts/Pretendard-Regular.ttpack", "https://app.test/app/fonts/Pretendard-Bold.ttpack"]);
  });

  it("installUiFonts adds Regular as 400 and Bold as 700 to document.fonts", async () => {
    stubFetch();
    const added: { family: string; weight: string; size: number }[] = [];
    class FakeFace {
      constructor(public family: string, public src: ArrayBuffer | Uint8Array, public d: { weight: string }) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFace);
    vi.stubGlobal("document", { baseURI: "https://app.test/app/", fonts: { add: (f: FakeFace) => added.push({ family: f.family, weight: f.d.weight, size: f.src.byteLength }) } });
    const { installUiFonts } = await import("../../src/io/pretendard");
    await installUiFonts();
    expect(added).toEqual([
      { family: "Pretendard", weight: "400", size: ttf("Regular").length },
      { family: "Pretendard", weight: "700", size: ttf("Bold").length },
    ]);
  });

  it("a missing pack is reported with the file name", async () => {
    vi.stubGlobal("document", { baseURI: "https://app.test/" });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const { pretendardTtf } = await import("../../src/io/pretendard");
    await expect(pretendardTtf("bold")).rejects.toThrow(/Pretendard-Bold\.ttpack.*404/);
  });
});
