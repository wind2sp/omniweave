// Generates docs/demo/omniweave-demo.omw — the sample document used for screenshots and as a
// downloadable example. Run: npx vitest run scripts/make-demo.test.ts --dir scripts
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { makeTile } from "../src/core/loom";
import { ANIM_PRESETS } from "../src/core/anim";
import { corner, rectContour } from "../src/core/vector";
import { TILE, newDocument, newPage, newRaster, newText, newVector, uid, type PixelTile } from "../src/core/types";
import { paginate } from "../src/io/office";
import { packOmw } from "../src/io/omw";

(globalThis as any).DOMParser = DOMParser;

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/** Pixel-tile field drawn straight into RGBA tiles (no canvas needed). */
function tileField(w: number, h: number, seed = 7): Record<string, PixelTile> {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const bufs = new Map<string, Uint8ClampedArray>();
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const k = `${Math.floor(x / TILE)}_${Math.floor(y / TILE)}`;
    let d = bufs.get(k);
    if (!d) bufs.set(k, (d = new Uint8ClampedArray(TILE * TILE * 4)));
    const i = ((y % TILE) * TILE + (x % TILE)) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  };
  const cell = 34;
  const cols = ["#7c5cff", "#22d3c5", "#ff6b81", "#3b3470", "#2a2550"];
  for (let cy = 0; cy < Math.floor(h / cell); cy++)
    for (let cx = 0; cx < Math.floor(w / cell); cx++) {
      const t = cx / (w / cell);
      if (rnd() > Math.pow(1 - t, 1.5) * 0.9) continue;
      const [r, g, b] = hex(cols[rnd() < 0.4 ? Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 2)]);
      const inText = cy * cell > 150 && cy * cell < 450 && cx * cell > 60;
      const a = Math.round((inText ? 25 : 70) + (inText ? 45 : 140) * (1 - t) * rnd());
      for (let y = 3; y < cell - 3; y++)
        for (let x = 3; x < cell - 3; x++) {
          const corner = (x < 7 || x > cell - 8) && (y < 7 || y > cell - 8);
          if (corner && Math.hypot(Math.min(x - 7, cell - 8 - x) , Math.min(y - 7, cell - 8 - y)) > 4) continue;
          put(cx * cell + x, cy * cell + y, r, g, b, a);
        }
    }
  const tiles: Record<string, PixelTile> = {};
  for (const [k, d] of bufs) tiles[k] = makeTile(d);
  return tiles;
}

function ringBand(cx: number, cy: number, r: number, a0: number, a1: number, color: string) {
  const outer: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = ((a0 + ((a1 - a0) * i) / 48) * Math.PI) / 180;
    outer.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const inner = outer.map(([x, y]) => [cx + (x - cx) * 0.62, cy + (y - cy) * 0.62] as [number, number]).reverse();
  const v = newVector([{ closed: true, nodes: [...outer, ...inner].map(([x, y]) => corner(x, y)) }], "실 가닥");
  v.fill = color;
  return v;
}

it("writes the demo document", () => {
  const doc = newDocument("오메 소개 데크");
  const s1 = newPage("SLIDE", 1280, 720, "표지");
  s1.background = "#14122a";
  const r = newRaster("픽셀 타일 (래스터)");
  r.tiles = tileField(600, 720);
  s1.nodes.push(r, ringBand(930, 340, 190, -120, 10, "#7c5cff"), ringBand(930, 340, 190, 0, 130, "#22d3c5"), ringBand(930, 340, 190, 120, 250, "#ff6b81"));
  const sq = (x: number, y: number, c: string) => {
    const v = newVector([rectContour(0, 0, 40, 40)], "타일");
    v.fill = c;
    v.transform = { x, y, rotation: 0, scale: 1 };
    return v;
  };
  s1.nodes.push(sq(884, 294, "#ffffff"), sq(934, 294, "#ffffffaa"), sq(884, 344, "#ffffffaa"), sq(934, 344, "#ffffff"));
  const brand = newText("Omniweave 오메", 400, { fontSize: 22, bold: true, color: "#22d3c5" });
  brand.transform = { x: 82, y: 170, rotation: 0, scale: 1 };
  const title = newText("파일 형식은 출구일 뿐,\n편집은 하나의 캔버스에서.", 620, { fontSize: 46, bold: true, color: "#f4f3ff" });
  title.transform = { x: 80, y: 230, rotation: 0, scale: 1 };
  title.paragraphs.forEach((p) => (p.lineSpacing = 1.3));
  const sub = newText("래스터 · 벡터 · PDF · DOCX · HWPX · 슬라이드를 하나의 씬 그래프에서 직조합니다.", 560, { fontSize: 20, color: "#b9b5e0" });
  sub.transform = { x: 82, y: 400, rotation: 0, scale: 1 };
  s1.nodes.push(brand, title, sub);
  s1.animations = [
    ...ANIM_PRESETS["fly-up"].make().map((m, i) => ({ id: uid("an"), targetNodeId: title.id, trigger: (i ? "WITH_PREVIOUS" : "AFTER_PREVIOUS") as any, ...m })),
    ...ANIM_PRESETS["fade-in"].make().map((m) => ({ id: uid("an"), targetNodeId: sub.id, trigger: "ON_CLICK" as const, ...m })),
  ];

  const s2 = newPage("SLIDE", 1280, 720, "Loom 엔진");
  const t2 = newText("Loom 엔진", 600, { fontSize: 44, bold: true, color: "#1d1f24" });
  t2.transform = { x: 80, y: 70, rotation: 0, scale: 1 };
  const b2 = newText("• 내용 주소 타일: 같은 픽셀은 한 번만 저장\n• Weave Cache: 무효화 코드 없는 화면 타일 캐시\n• Shuttle 저널: 바뀐 조각만 기록하는 자동저장", 900, { fontSize: 26, color: "#33364a" });
  b2.transform = { x: 84, y: 170, rotation: 0, scale: 1 };
  s2.nodes.push(t2, b2);

  const paras = newText(
    "오메 기획서\n오메는 사진 편집, 일러스트, PDF 수정, 워드와 한글 문서, 발표 자료를 하나의 캔버스에서 다루는 공개 소프트웨어입니다. 파일 형식은 저장할 때의 모습일 뿐이고, 편집하는 동안에는 모두 같은 개체입니다.\n한글 조합형 문자는 자소가 분리되지 않도록 그래핌 단위로 줄을 나누고, 어절 단위 줄바꿈(keep-all)을 기본으로 사용합니다.",
    600,
    { fontSize: 15 },
  ).paragraphs;
  paras[0].runs[0].fontSize = 26;
  paras[0].runs[0].bold = true;
  paras[0].align = "CENTER";
  doc.pages = [s1, s2, ...paginate(paras, "기획서")];
  mkdirSync("docs/demo", { recursive: true });
  writeFileSync("docs/demo/omniweave-demo.omw", packOmw(doc).bytes);
});
