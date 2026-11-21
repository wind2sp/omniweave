// SVG intrinsic size (pure). Chromium / WebView2 cannot decode an SVG Blob with createImageBitmap,
// so SVG assets are drawn through an <img>; an <img> needs the SVG to declare its own width and
// height, which many files leave out (only a viewBox, or nothing → the 300×150 default).

const ROOT = /<svg\b[^>]*>/i;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

/** CSS length → px (absolute units only; % and unknown units give null). */
function lengthPx(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const k: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const px = n * k[(m[2] ?? "px").toLowerCase()];
  return px > 0 && isFinite(px) ? px : null;
}

/** Size the SVG asks for: width/height, else the viewBox, else 300×150 (browser default). */
export function svgIntrinsicSize(text: string): { width: number; height: number } {
  const tag = ROOT.exec(text)?.[0] ?? "";
  let w = lengthPx(attr(tag, "width")), h = lengthPx(attr(tag, "height"));
  const vb = attr(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  const vw = vb && vb.length === 4 && vb[2] > 0 ? vb[2] : null, vh = vb && vb.length === 4 && vb[3] > 0 ? vb[3] : null;
  if (w && !h && vw && vh) h = (w * vh) / vw;
  if (h && !w && vw && vh) w = (h * vw) / vh;
  return { width: w ?? vw ?? 300, height: h ?? vh ?? 150 };
}

/** The SVG text with explicit width / height on its root (so an <img> has a real intrinsic size). */
export function svgWithSize(text: string): string {
  const m = ROOT.exec(text);
  if (!m) return text;
  const tag = m[0];
  const { width, height } = svgIntrinsicSize(text);
  let next = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  next = next.replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return text.slice(0, m.index) + next + text.slice(m.index + tag.length);
}

export function isSvg(bytes: Uint8Array, mime: string): boolean {
  if (/svg/i.test(mime)) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && /<svg\b/i.test(head));
}
