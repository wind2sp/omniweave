// EPUB 2/3 (OCF zip + OPF package): spine documents in reading order become document pages
// (headings, paragraphs, lists, tables, images). DRM-protected books (META-INF/encryption.xml with
// content encryption) are refused honestly.

import { t } from "../../i18n";
import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../core/assets";
import type { AssetRef, Page } from "../../core/types";
import { attr, descendants, parseXml } from "../xml";
import { flowBlocks, type Block } from "./flow";
import { htmlBlocks, parseHtml } from "./html";
import { imageMime, imageSize } from "./sniff";
import { baseName } from "./text";

function resolve(base: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0]);
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export function importEpub(bytes: Uint8Array, name: string): { pages: Page[]; assets: Record<string, AssetRef>; title: string; chapters: number } {
  const files = unzipSync(bytes);
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error(t("engine.epub.noContainer"));
  const enc = files["META-INF/encryption.xml"];
  if (enc && /EncryptedData/.test(strFromU8(enc)) && !/obfuscation|font/i.test(strFromU8(enc))) throw new Error(t("engine.epub.drm"));
  const rootfile = descendants(parseXml(strFromU8(container)), "rootfile")[0];
  const opfPath = rootfile ? attr(rootfile, "full-path") ?? "" : "";
  const opfBytes = files[opfPath];
  if (!opfBytes) throw new Error(t("engine.epub.noOpf"));
  const opf = parseXml(strFromU8(opfBytes));
  const title = descendants(opf, "title")[0]?.textContent?.trim() || baseName(name);
  const manifest = new Map<string, { href: string; type: string }>();
  for (const it of descendants(opf, "item")) manifest.set(attr(it, "id") ?? "", { href: resolve(opfPath, attr(it, "href") ?? ""), type: attr(it, "media-type") ?? "" });
  const assets: Record<string, AssetRef> = {};
  const byPath = new Map<string, AssetRef | null>();
  const blocks: Block[] = [];
  let chapters = 0;
  for (const ref of descendants(opf, "itemref")) {
    if (attr(ref, "linear") === "no") continue;
    const item = manifest.get(attr(ref, "idref") ?? "");
    if (!item || !/html|xml/.test(item.type)) continue;
    const raw = files[item.href];
    if (!raw) continue;
    const text = strFromU8(raw);
    let doc: Document;
    try {
      doc = parseXml(text);
      if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) throw new Error();
    } catch {
      doc = parseHtml(text);
    }
    const body = descendants(doc, "body")[0] ?? doc.documentElement;
    if (!body) continue;
    const chapter = htmlBlocks(body, (src, alt) => {
      const p = resolve(item.href, src);
      let a = byPath.get(p);
      if (a === undefined) {
        const b = files[p];
        const mime = b ? imageMime(b) : null;
        a = b && mime && mime !== "image/tiff" ? makeAsset(b, mime, p.split("/").pop() ?? alt) : null;
        if (a) assets[a.id] = a;
        byPath.set(p, a);
      }
      if (!a) return null;
      const size = imageSize(files[p]) ?? { width: 400, height: 300 };
      return { assetId: a.id, width: size.width, height: size.height, name: alt || a.name };
    });
    if (!chapter.length) continue;
    if (chapters) blocks.push({ kind: "pagebreak" });
    blocks.push(...chapter);
    chapters++;
  }
  if (!blocks.length) throw new Error(t("engine.epub.noBody"));
  const pages = flowBlocks(blocks, title, assets, { source: { format: "epub", name } });
  return { pages, assets, title, chapters };
}
