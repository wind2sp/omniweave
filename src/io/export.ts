import { withReviewPrint } from "../core/review";
import { PDFDocument } from "pdf-lib";
import { isEmptyPh } from "../core/slides";
import { getBlob } from "../core/assets";
import { layoutText, pageFontsSettled } from "../core/text";
import { paintBox, vectorToSvgD } from "../core/vector";
import type { Paint } from "../core/style/types";
import { renderMasterOf } from "../core/headerFooter";
import { nodeBounds, paintBounds } from "../core/loom";
import type { OmwDocument, Page, SceneNode, Vec2, VectorNode } from "../core/types";
import { buildTree, groupIndex, groupPath, hasStructure, type TreeItem } from "../core/layerTree";
import { svgEffectsFilter } from "./svgFx";
import { esc } from "./xml";
import { CSS_BLEND, loadDissolveField, pageDissolves } from "../core/style/blend";
import { renderPageCanvas } from "../render/weave";
import { makeCanvas } from "../render/draw";
import { PDF_PRODUCER, exportPdfVector } from "./pdfVector";
import { bakeAdjustDoc } from "./bakeAdjust";
import { t } from "../i18n";

export async function canvasToPng(c: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob = "convertToBlob" in c ? await c.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res) => (c as HTMLCanvasElement).toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Wait until async resources (images, PDF bitmaps) are decoded, then render. */
async function settledCanvas(doc: OmwDocument, page: Page, scale: number) {
  const master = renderMasterOf(doc, page);
  // DISSOLVE thresholds load on demand (core/style/blend.ts)
  if (pageDissolves(page) || (master && pageDissolves(master))) await loadDissolveField().catch(() => {});
  renderPageCanvas(doc, page, master, Math.min(scale, 0.25)); // warm resources
  await new Promise((r) => setTimeout(r, 350));
  return renderPageCanvas(doc, page, master, scale);
}

export async function exportPng(doc: OmwDocument, page: Page, scale = 2): Promise<Uint8Array> {
  return canvasToPng(await settledCanvas(doc, page, scale));
}

/**
 * A page as a JPG / WebP / PNG (ExportCtx.encodeImage): drawn as the PNG export, `background` under it (JPEG has no
 * transparency), encoded by the browser in the same canvas — a big picture is not copied once more.
 */
export async function exportImage(doc: OmwDocument, page: Page, o: { mime: string; quality: number; background: string | null; scale: number }): Promise<Uint8Array> {
  const c = await settledCanvas(doc, page, o.scale);
  if (o.background) {
    const g = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "destination-over";
    g.fillStyle = o.background;
    g.fillRect(0, 0, c.width, c.height);
    g.restore();
  }
  const blob = "convertToBlob" in c ? await c.convertToBlob({ type: o.mime, quality: o.quality }) : await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, o.mime, o.quality));
  // a browser without the encoder hands back a PNG instead: say so rather than write a PNG under a .jpg / .webp name
  if (!blob || blob.type !== o.mime) throw new Error(t("imgexport.err.encoder", { fmt: o.mime.split("/")[1].toUpperCase() }));
  // free the big canvas now (an 8000 px picture is 256 MB of pixels)
  c.width = c.height = 1;
  return new Uint8Array(await blob.arrayBuffer());
}

/** A page's pixels (RGBA, on its background colour) at `scale` — e.g. the first-page preview of an HWP file (hwp5Write.ts). */
export async function pageRgba(doc: OmwDocument, page: Page, scale: number): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const src = await settledCanvas(doc, page, scale);
  const cv = makeCanvas(src.width, src.height);
  const g = cv.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  g.fillStyle = page.background || "#ffffff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(src as CanvasImageSource, 0, 0);
  return { rgba: g.getImageData(0, 0, cv.width, cv.height).data, width: cv.width, height: cv.height };
}

/** Image PDF: each page rendered at 2x and placed at its true size (1px = 0.75pt). Text is not selectable. */
export async function exportPdfRaster(doc: OmwDocument, pages: Page[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  pdf.setCreator(PDF_PRODUCER);
  pdf.setProducer("Omniweave 0.1.0 (Loom engine)");
  for (const page of pages) {
    const png = await exportPng(doc, page, 2);
    const img = await pdf.embedPng(png);
    const p = pdf.addPage([page.width * 0.75, page.height * 0.75]);
    p.drawImage(img, { x: 0, y: 0, width: page.width * 0.75, height: page.height * 0.75 });
  }
  return pdf.save();
}

export interface PdfExportOptions {
  /** "vector" (default): live text, vector shapes, original images · "raster": every page as one image */
  mode?: "vector" | "raster";
  onWarning?: (msg: string) => void;
  /** bookmarks (see PdfVectorOptions.outline) */
  outline?: boolean | { title: string; page: number }[];
  /**
   * Tracked changes (core/review.ts): true (default) = with their marks (inserted text underlined, deleted text struck
   * through, as Word prints '모든 변경 내용'); false = the final text (deleted text left out). Never the view's choice
   * unasked; comment shading is not printed either way.
   */
  markup?: boolean;
}

/**
 * PDF export. Vector by default (selectable/searchable text with embedded Pretendard);
 * falls back to the image PDF when the vector writer fails (e.g. the font cannot be loaded).
 */
export async function exportPdf(doc: OmwDocument, pages: Page[], opts: PdfExportOptions = {}): Promise<Uint8Array> {
  // the document fonts' local() faces settled first, so the PDF lays text out as the screen does (core/text.ts)
  await pageFontsSettled([...pages, ...(doc.masters ?? [])]);
  // the view of tracked changes for the export only (laid out again for it, and back after)
  return withReviewPrint(opts.markup !== false ? "markup" : "final", () => exportPdfView(doc, pages, opts));
}

async function exportPdfView(doc: OmwDocument, pages: Page[], opts: PdfExportOptions): Promise<Uint8Array> {
  if (opts.mode === "raster") return exportPdfRaster(doc, pages);
  try {
    // adjustment layers have no PDF form: what they touch goes in as a picture (io/bakeAdjust.ts)
    const b = await bakeAdjustments(doc, pages);
    if (b.note) opts.onWarning?.(b.note);
    ({ doc, pages } = b);
    return await exportPdfVector(doc, pages, {
      rasterize: (page, node) => rasterizeNode(doc, page, node),
      onWarning: opts.onWarning ?? ((m) => console.warn("[PDF]", m)),
      outline: opts.outline,
    });
  } catch (e) {
    console.warn("[PDF] Vector PDF export failed; exporting an image PDF instead:", e);
    return exportPdfRaster(doc, pages);
  }
}

/**
 * The document with adjustment layers set as pictures for a format that cannot hold them (io/bakeAdjust.ts), and
 * the one-line notice to show when anything was set so.
 */
export async function bakeAdjustments(doc: OmwDocument, pages: Page[]): Promise<{ doc: OmwDocument; pages: Page[]; note: string | null }> {
  const b = await bakeAdjustDoc(doc, pages, rasterizeNode);
  return { doc: b.doc, pages: b.pages, note: b.baked ? t("doc.toast.adjustBaked") : null };
}

/** WebP bytes as a PNG, losslessly (the browser decodes, the canvas encodes); null when it cannot be decoded. */
export async function webpBytesToPng(webp: Uint8Array): Promise<Uint8Array | null> {
  try {
    const bmp = await createImageBitmap(new Blob([webp], { type: "image/webp" }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    return await canvasToPng(c);
  } catch {
    return null;
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** SVG export keeps vectors and text as live SVG; rasters/PDF pages are embedded as images. */
export async function exportSvg(doc: OmwDocument, page: Page): Promise<string> {
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">`);
  out.push(`<rect width="100%" height="100%" fill="${page.background}"/>`);
  const master = renderMasterOf(doc, page);
  let k = 0; // clip / mask ids: unique in the whole file (master and page both)
  for (const layers of master ? [master, page] : [page]) {
    if (!hasStructure(layers.nodes, layers.groups)) {
      for (const n of layers.nodes) if (n.visible) out.push(await nodeSvg(doc, page, n));
      continue;
    }
    const MIX = CSS_BLEND;
    const look = (opacity: number, blend: string) => `${opacity < 1 ? ` opacity="${opacity}"` : ""}${MIX[blend] ? ` style="mix-blend-mode:${MIX[blend]};isolation:isolate"` : ""}`;
    // groups → <g> with opacity / mix-blend-mode; clip stacks → <clipPath> (filled vector base) or an alpha <mask>
    const items = async (list: TreeItem[]): Promise<string> => {
      const parts: string[] = [];
      for (const it of list) {
        if (it.kind === "node" ? !it.node.visible : !it.group.visible) continue;
        const clips = it.clips.filter((c) => c.visible);
        const body = it.kind === "node" ? await nodeSvg(doc, page, clips.length ? ({ ...it.node, opacity: 1 } as SceneNode) : it.node) : await items(it.children);
        if (!clips.length) {
          if (it.kind === "node") parts.push(body);
          // a group in any mode but Pass Through is composited on its own first (its members do not blend with what is below)
          else {
            const g = `<g${look(it.group.opacity, it.group.blendMode)}${it.group.blendMode === "NORMAL" ? ` style="isolation:isolate"` : ""}>${body}</g>`;
            parts.push(it.group.effects?.length ? withSvgEffects(`fx-${it.group.id}`, it.group.effects, groupBox(it), g) : g);
          }
          continue;
        }
        const id = `clip-${page.id}-${k++}`;
        const base = it.kind === "node" ? it.node : null;
        const plain = base && base.type === "VECTOR" && base.fill && !(base.stroke && base.strokeWidth > 0);
        const def = plain
          ? `<clipPath id="${id}"><path transform="${svgTransform(base)}" d="${vectorToSvgD(base)}" clip-rule="${base.fillRule}"/></clipPath>`
          : `<mask id="${id}" mask-type="alpha" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${page.width}" height="${page.height}">${body}</mask>`;
        const inner = (await Promise.all(clips.map((c) => nodeSvg(doc, page, c)))).join("");
        const op = it.kind === "node" ? it.node.opacity : it.group.opacity;
        const blend = it.kind === "node" ? it.node.blendMode : it.group.blendMode;
        parts.push(`<g${look(op, blend)}><defs>${def}</defs>${body}<g ${plain ? "clip-path" : "mask"}="url(#${id})">${inner}</g></g>`);
      }
      return parts.join("");
    };
    out.push(await items(buildTree(layers.nodes, layers.groups)));
  }
  out.push(`</svg>`);
  return out.join("\n");
}

/** Page-space box of a group item's members. */
function groupBox(it: TreeItem): { x: number; y: number; w: number; h: number } {
  const all: SceneNode[] = [];
  const walk = (x: TreeItem) => (x.kind === "node" ? all.push(x.node, ...x.clips) : (x.children.forEach(walk), all.push(...x.clips)));
  walk(it);
  const bs = all.map((n) => nodeBounds(n));
  if (!bs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
}

function svgTransform(n: SceneNode): string {
  const t = n.transform;
  return `translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${t.scale}${t.scaleY !== undefined && t.scaleY !== t.scale ? ` ${t.scaleY}` : ""})`;
}

/** Content wrapped in a <g> with the effects' SVG filter (page coordinates), or unchanged without effects. */
function withSvgEffects(id: string, effects: SceneNode["effects"], box: { x: number; y: number; w: number; h: number }, body: string): string {
  const f = svgEffectsFilter(id, effects, box);
  return f ? `<g filter="url(#${id})"><defs>${f}</defs>${body}</g>` : body;
}

/** One node as SVG markup (vectors and text live, images embedded, everything else as a picture), with its effects. */
async function nodeSvg(doc: OmwDocument, page: Page, n: SceneNode): Promise<string> {
  if (isEmptyPh(n)) return "";
  const body = await nodeSvgBare(doc, page, n);
  return n.effects?.length ? withSvgEffects(`fx-${n.id}`, n.effects, nodeBounds(n), body) : body;
}

async function nodeSvgBare(doc: OmwDocument, page: Page, n: SceneNode): Promise<string> {
  const out: string[] = [];
  {
    const t = n.transform;
    const tr = `translate(${t.x} ${t.y}) rotate(${t.rotation}) scale(${t.scale}${t.scaleY !== undefined && t.scaleY !== t.scale ? ` ${t.scaleY}` : ""})`;
    const common = `transform="${tr}" opacity="${n.opacity}"`;
    switch (n.type) {
      case "VECTOR": {
        // a gradient fill (fills[0]) as an SVG gradient in the path's own space (render/draw vectorGradient)
        const g = (n as VectorNode & { fills?: Paint[] }).fills?.[0];
        let fill = n.fill ?? "none";
        if (n.fill && g?.type === "gradient" && (g.kind === "linear" || g.kind === "radial")) {
          const b = paintBox(n), id = `g_${n.id.replace(/[^\w-]/g, "")}`;
          const at = (u: Vec2) => [b.x + u[0] * b.w, b.y + u[1] * b.h].map((v) => +v.toFixed(3));
          const [x0, y0] = at(g.from), [x1, y1] = at(g.to);
          const stops = g.stops.map((s) => `<stop offset="${s.at}" stop-color="${s.color.hex}"${s.color.a !== undefined && s.color.a < 1 ? ` stop-opacity="${s.color.a}"` : ""}/>`).join("");
          out.push(
            g.kind === "linear"
              ? `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}">${stops}</linearGradient></defs>`
              : `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${x0}" cy="${y0}" r="${+Math.hypot(x1 - x0, y1 - y0).toFixed(3)}">${stops}</radialGradient></defs>`,
          );
          fill = `url(#${id})`;
        }
        out.push(`<path ${common} d="${vectorToSvgD(n)}" fill="${fill}" fill-rule="${n.fillRule}" stroke="${n.stroke ?? "none"}" stroke-width="${n.strokeWidth}" stroke-linejoin="${n.strokeJoin ?? "round"}" stroke-linecap="${n.strokeCap ?? "round"}"${n.strokeDash?.length ? ` stroke-dasharray="${n.strokeDash.join(" ")}"` : ""}/>`);
        break;
      }
      case "TEXT": {
        const lay = layoutText(n);
        out.push(`<g ${common}>`);
        if (n.background) out.push(`<rect width="${n.width}" height="${lay.height}" fill="${n.background}"/>`);
        for (const l of lay.lines)
          for (const p of l.pieces)
            out.push(
              `<text x="${p.x.toFixed(2)}" y="${(l.y + l.baseline).toFixed(2)}" font-family="${esc(p.run.fontFamily)}, 'Noto Sans KR', sans-serif" font-size="${p.run.fontSize}" font-weight="${p.run.bold ? 700 : 400}" font-style="${p.run.italic ? "italic" : "normal"}" fill="${p.run.color}"${p.run.underline ? ' text-decoration="underline"' : ""} xml:space="preserve">${esc(p.text)}</text>`,
            );
        out.push(`</g>`);
        break;
      }
      case "IMAGE": {
        const a = doc.assets[n.assetId];
        const b = a && getBlob(a.hash);
        if (b && n.crop) {
          // non-destructive crop: the whole image is kept, a clip path shows the cropped part
          const cid = `crop-${n.id}`;
          out.push(`<g ${common}><clipPath id="${cid}"><rect x="${n.crop.x}" y="${n.crop.y}" width="${n.crop.w}" height="${n.crop.h}"/></clipPath><image clip-path="url(#${cid})" width="${n.width}" height="${n.height}" href="data:${a.mime};base64,${b64(b)}"/></g>`);
        } else if (b) out.push(`<image ${common} width="${n.width}" height="${n.height}" href="data:${a.mime};base64,${b64(b)}"/>`);
        break;
      }
      case "RASTER":
      case "PDF":
      case "TABLE":
      case "MEDIA": {
        // the picture without effects: the SVG filter around it draws them
        const single: Page = { ...page, nodes: [{ ...n, clip: undefined, effects: undefined } as SceneNode], groups: undefined, background: "rgba(0,0,0,0)", masterId: null };
        const png = await canvasToPng(await settledCanvas(doc, single, 1));
        out.push(`<image width="${page.width}" height="${page.height}" href="data:image/png;base64,${b64(png)}"/>`);
        break;
      }
    }
  }
  return out.join("\n");
}

/**
 * One node painted alone (2x) and cropped to its page-space bounds — for exporters without a native equivalent.
 * Several nodes (a clip stack, a group's members) are painted together with the page's groups.
 */
export async function rasterizeNode(doc: OmwDocument, page: Page, nodeOrNodes: SceneNode | SceneNode[]): Promise<{ png: Uint8Array; x: number; y: number; w: number; h: number } | null> {
  const list = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
  if (!list.length) return null;
  const node = list[0];
  // what the nodes paint, effects included (a shadow reaches past the object's box)
  const gi = groupIndex(page.groups);
  const bs = list.map((n) => paintBounds(n, Array.isArray(nodeOrNodes) ? groupPath(n.groupId, gi) : []));
  const bx0 = Math.min(...bs.map((r) => r.x)), by0 = Math.min(...bs.map((r) => r.y));
  const b = { x: bx0, y: by0, w: Math.max(...bs.map((r) => r.x + r.w)) - bx0, h: Math.max(...bs.map((r) => r.y + r.h)) - by0 };
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
  const w = Math.min(page.width, Math.ceil(b.x + b.w)) - x, h = Math.min(page.height, Math.ceil(b.y + b.h)) - y;
  if (w <= 0 || h <= 0) return null;
  // one node: just that node — its group's eye / opacity / blend and its clipping base are not part of its own
  // pixels (the PSD / PPTX layer and a rasterized layer keep the group and the clip flag, which apply them again)
  const single: Page = Array.isArray(nodeOrNodes)
    ? { ...page, nodes: list, background: "rgba(0,0,0,0)", masterId: null }
    : { ...page, nodes: [{ ...node, groupId: undefined, clip: undefined } as SceneNode], groups: undefined, background: "rgba(0,0,0,0)", masterId: null };
  const full = await settledCanvas(doc, single, 2);
  const crop = document.createElement("canvas");
  crop.width = w * 2;
  crop.height = h * 2;
  crop.getContext("2d")!.drawImage(full as CanvasImageSource, x * 2, y * 2, w * 2, h * 2, 0, 0, w * 2, h * 2);
  return { png: await canvasToPng(crop), x, y, w, h };
}
