// Quick tools (Tools menu): PDF merge / compress / → JPG, images → PDF, image compress, → JPG.
// UI only — the processing lives in src/io/tools/*. Every step runs on this computer; nothing is uploaded.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../core/store";
import { openFiles, saveFile } from "../../io/platform";
import { canvasRecompressor, compressImage, decodeImage, encodeBitmap, pdfToJpgs, sniffMime, toJpg, zipFiles, type OutFormat } from "../../io/tools/imageTools";
import { compressPdf, formatBytes, imagesToPdf, mergePdfs, type PageSize } from "../../io/tools/pdfTools";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";
import { Seg, cx } from "./controls";
import { useUI } from "./uiStore";
import { combineToPdf } from "../pageActions";
import { claimDrop } from "../fileDrop";
import { t, useT } from "../../i18n";

export interface QuickTool {
  id: string;
  label: string;
  hint: string;
  icon: string;
  accept: string[];
  max: number;
  ordered: boolean;
  desc: string;
}

const IMG = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "tif", "tiff", "heic", "heif", "ico"];

const DOCS = ["pdf", "ai", "docx", "hwpx", "pptx", "xlsx", "omw", "hwp", "doc", "ppt", "xls", "md", "txt", "html", "htm", "csv", "epub", "psd"];

/** label / hint / desc are read in the current language each time (`quick.<id>`, `image.quick.<id>.hint|desc`). */
function quickTool(id: string, icon: string, accept: string[], max: number, ordered: boolean): QuickTool {
  return {
    id,
    icon,
    accept,
    max,
    ordered,
    get label() {
      return t(`quick.${id}`);
    },
    get hint() {
      return t(`image.quick.${id}.hint`);
    },
    get desc() {
      return t(`image.quick.${id}.desc`);
    },
  };
}

export const QUICK_TOOLS: QuickTool[] = [
  quickTool("combine", "pdf", [...DOCS, ...IMG], 200, true),
  quickTool("merge", "pdf", ["pdf"], 200, true),
  quickTool("compress-pdf", "pdf", ["pdf"], 20, false),
  quickTool("pdf-jpg", "image", ["pdf"], 20, false),
  quickTool("img-pdf", "doc", IMG, 300, true),
  quickTool("compress-img", "image", IMG, 100, false),
  quickTool("to-jpg", "image", IMG, 50, false),
];

interface Item {
  key: string;
  name: string;
  bytes: Uint8Array;
}
interface Result {
  name: string;
  bytes: Uint8Array;
  before?: number;
  note?: string;
  error?: string;
}

let seq = 0;

export function ToolsDialog() {
  const toolId = useUI((s) => s.quickTool);
  const set = useUI((s) => s.set);
  if (!toolId) return null;
  return <ToolsBody key={toolId} toolId={toolId} onClose={() => set({ quickTool: null })} onSwitch={(id) => set({ quickTool: id })} />;
}

function ToolsBody({ toolId, onClose, onSwitch }: { toolId: string; onClose: () => void; onSwitch: (id: string) => void }) {
  const t = useT();
  const tool = QUICK_TOOLS.find((q) => q.id === toolId) ?? QUICK_TOOLS[0];
  const [items, setItems] = useState<Item[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [quality, setQuality] = useState(tool.id === "to-jpg" ? 0.92 : 0.75);
  const [dpi, setDpi] = useState("150");
  const [pageSize, setPageSize] = useState<PageSize>("A4");
  const [fmt, setFmt] = useState<OutFormat | "same">("same");
  const [maxDim, setMaxDim] = useState("0");
  const [protect, setProtect] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const notify = (m: string) => useStore.getState().notify(m);

  useEffect(() => {
    setResults([]);
    setError(null);
  }, [items]);

  const add = (files: { name: string; bytes: Uint8Array }[]) => {
    const ok = files.filter((f) => tool.accept.includes(f.name.split(".").pop()!.toLowerCase()));
    const bad = files.length - ok.length;
    setItems((cur) => {
      const next = [...cur, ...ok.map((f) => ({ key: `f${++seq}`, name: f.name, bytes: f.bytes }))];
      if (next.length > tool.max) notify(t("image.tools.tooMany", { max: tool.max, extra: next.length - tool.max }));
      return next.slice(0, tool.max);
    });
    if (bad) notify(t(bad === 1 ? "image.tools.badFormatOne" : "image.tools.badFormat", { n: bad, formats: tool.accept.slice(0, 6).join("·") + (tool.accept.length > 6 ? "…" : "") }));
  };

  const pick = async () => add(await openFiles([{ name: tool.label, extensions: tool.accept }], true));

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    claimDrop(e);
    setOver(false);
    if (dragFrom.current !== null) return;
    const files = await Promise.all(Array.from(e.dataTransfer.files).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    add(files);
  };

  const move = (from: number, to: number) =>
    setItems((cur) => {
      if (to < 0 || to >= cur.length || from === to) return cur;
      const next = [...cur];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return next;
    });

  const run = async () => {
    if (!items.length) return;
    setBusy(true);
    setError(null);
    setResults([]);
    const onProgress = (done: number, total: number, label?: string) => setProgress({ done, total, label });
    try {
      const out: Result[] = [];
      switch (tool.id) {
        case "combine": {
          const r = await combineToPdf(items, { protect, onProgress });
          if (!r) {
            setError(t("image.tools.cancelPw"));
            break;
          }
          const base = items[0].name.replace(/\.[^.]+$/, "") || t("image.tools.docName");
          out.push({
            name: (items.length > 1 ? t("image.tools.andMore", { name: base, n: items.length - 1 }) : base) + ".pdf",
            bytes: r.bytes,
            before: items.reduce((a, i) => a + i.bytes.length, 0),
            note: [
              t("image.tools.filesPages", { files: r.files, pages: r.pages }),
              t("image.tools.bookmarks", { n: r.files }),
              r.protectedWith ? t("image.tools.protected") : "",
              r.warnings.length ? t("image.tools.warnings", { n: r.warnings.length, list: r.warnings.slice(0, 2).join(" / ") }) : "",
            ]
              .filter(Boolean)
              .join(" · "),
          });
          break;
        }
        case "merge": {
          const r = await mergePdfs(items, onProgress);
          out.push({ name: t("image.tools.mergedName") + ".pdf", bytes: r.bytes, before: items.reduce((a, i) => a + i.bytes.length, 0), note: t("image.tools.filesPages", { files: items.length, pages: r.pages }) });
          break;
        }
        case "compress-pdf":
          for (let i = 0; i < items.length; i++) {
            onProgress(i, items.length, items[i].name);
            try {
              const r = await compressPdf(items[i].bytes, { quality, maxDim: Number(maxDim) || 2400, recompress: canvasRecompressor, onProgress: (d, t, l) => setProgress({ done: i + d / Math.max(1, t), total: items.length, label: `${items[i].name} · ${l ?? ""}` }) });
              out.push({ name: items[i].name.replace(/\.pdf$/i, "") + (r.effective ? t("image.tools.compressedSuffix") + ".pdf" : ".pdf"), bytes: r.bytes, before: r.before, note: r.note });
            } catch (e: any) {
              out.push({ name: items[i].name, bytes: new Uint8Array(0), error: e?.message ?? String(e) });
            }
          }
          break;
        case "pdf-jpg":
          for (let i = 0; i < items.length; i++) {
            try {
              const pages = await pdfToJpgs(items[i].bytes, items[i].name, { dpi: Number(dpi), quality, onProgress: (d, t, l) => setProgress({ done: i + d / Math.max(1, t), total: items.length, label: `${items[i].name} · ${l ?? ""}` }) });
              out.push(...pages);
            } catch (e: any) {
              out.push({ name: items[i].name, bytes: new Uint8Array(0), error: e?.message ?? String(e) });
            }
          }
          break;
        case "img-pdf": {
          const bytes = await imagesToPdf(
            items.map((i) => ({ name: i.name, bytes: i.bytes, mime: sniffMime(i.bytes, i.name) })),
            {
              pageSize,
              onProgress,
              convert: async (img) => {
                const bmp = await decodeImage(img.bytes, img.mime);
                const r = await encodeBitmap(bmp, img.mime === "image/webp" || img.mime === "image/avif" ? "jpeg" : "png", 0.92);
                bmp.close();
                return { name: img.name, bytes: r.bytes, mime: img.mime === "image/webp" || img.mime === "image/avif" ? "image/jpeg" : "image/png" };
              },
            },
          );
          const base = items[0].name.replace(/\.[^.]+$/, "") || t("image.tools.imageName");
          out.push({ name: (items.length > 1 ? t("image.tools.andMoreImages", { name: base, n: items.length - 1 }) : base) + ".pdf", bytes, note: t("image.tools.pages", { n: items.length }) });
          break;
        }
        case "compress-img":
          for (let i = 0; i < items.length; i++) {
            onProgress(i, items.length, items[i].name);
            try {
              const r = await compressImage(items[i].bytes, items[i].name, { quality, format: fmt, maxDim: Number(maxDim) });
              out.push({ name: r.name, bytes: r.bytes, before: r.before, note: r.kept ? t("image.tools.kept") : undefined });
            } catch (e: any) {
              out.push({ name: items[i].name, bytes: new Uint8Array(0), error: e?.message ?? String(e) });
            }
          }
          break;
        case "to-jpg":
          for (let i = 0; i < items.length; i++) {
            onProgress(i, items.length, items[i].name);
            try {
              const r = await toJpg(items[i].bytes, items[i].name, quality);
              out.push({ name: r.name, bytes: r.bytes, before: items[i].bytes.length });
            } catch (e: any) {
              out.push({ name: items[i].name, bytes: new Uint8Array(0), error: e?.message ?? String(e) });
            }
          }
          break;
      }
      setProgress({ done: 1, total: 1 });
      setResults(out);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const ok = results.filter((r) => !r.error && r.bytes.length);
  const save = async () => {
    if (!ok.length) return;
    if (ok.length === 1) {
      const ext = ok[0].name.split(".").pop()!;
      await saveFile(ok[0].name, ok[0].bytes, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    } else await saveFile(t("image.tools.zipName", { tool: tool.label, n: ok.length }) + ".zip", zipFiles(ok), [{ name: "ZIP", extensions: ["zip"] }]);
    notify(t("image.tools.saved"));
  };

  const totalBefore = ok.reduce((a, r) => a + (r.before ?? 0), 0);
  const totalAfter = ok.reduce((a, r) => a + r.bytes.length, 0);
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <Modal labelledBy="tools-title" onClose={busy ? undefined : onClose} className="tools-modal">
      <div className="tools">
        <nav className="tools-nav" aria-label={t("image.tools.title")}>
          <div className="tools-nav-head">
            <Icon name="tools" size={16} />
            {t("image.tools.title")}
          </div>
          {QUICK_TOOLS.map((q) => (
            <button key={q.id} type="button" className={cx("tools-nav-item", q.id === tool.id && "on")} disabled={busy} onClick={() => onSwitch(q.id)}>
              <Icon name={q.icon} size={14} />
              <span>{q.label}</span>
            </button>
          ))}
          <div className="tools-local">
            <Icon name="shield" size={14} />
            <span>{t("image.tools.local")}</span>
          </div>
        </nav>
        <section className="tools-main">
          <header className="tools-head">
            <h2 id="tools-title">{tool.label}</h2>
            <button type="button" className="modal-close ibtn ibtn-md" aria-label={t("common.close")} data-tip={t("common.close")} data-kbd="Esc" disabled={busy} onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </header>
          <p className="tools-desc">{tool.desc}</p>
          <div
            className={cx("tools-drop", over && "drag-over")}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragFrom.current === null) setOver(true);
            }}
            onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
            onDrop={onDrop}
          >
            {items.length === 0 ? (
              <button type="button" className="tools-drop-empty" onClick={() => void pick()}>
                <Icon name="upload" size={22} />
                <b>{t("image.tools.drop")}</b>
                <span>
                  {tool.accept.slice(0, 8).join(" · ").toUpperCase()}
                  {tool.max > 1 ? ` · ${t("image.tools.maxN", { n: tool.max })}` : ""}
                </span>
              </button>
            ) : (
              <ol className="tools-list">
                {items.map((it, i) => (
                  <li
                    key={it.key}
                    className="tools-row"
                    draggable={tool.ordered && !busy}
                    onDragStart={() => (dragFrom.current = i)}
                    onDragEnd={() => (dragFrom.current = null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragFrom.current !== null) move(dragFrom.current, i);
                      dragFrom.current = null;
                    }}
                  >
                    {tool.ordered && <Icon name="grip" size={14} className="tools-grip" />}
                    <span className="tools-idx">{i + 1}</span>
                    <span className="tools-name" title={it.name}>
                      {it.name}
                    </span>
                    <span className="tools-size">{formatBytes(it.bytes.length)}</span>
                    {tool.ordered && (
                      <>
                        <button type="button" className="ibtn ibtn-sm" aria-label={t("image.tools.up")} disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                          <Icon name="up" size={12} />
                        </button>
                        <button type="button" className="ibtn ibtn-sm" aria-label={t("image.tools.down")} disabled={busy || i === items.length - 1} onClick={() => move(i, i + 1)}>
                          <Icon name="down" size={12} />
                        </button>
                      </>
                    )}
                    <button type="button" className="ibtn ibtn-sm danger" aria-label={t("image.tools.remove")} disabled={busy} onClick={() => setItems((c) => c.filter((x) => x.key !== it.key))}>
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {items.length > 0 && (
            <div className="tools-actions-row">
              <button type="button" className="btn btn-ghost" disabled={busy || items.length >= tool.max} onClick={() => void pick()}>
                <Icon name="plus" size={14} />
                <span>{t("image.tools.addFiles")}</span>
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => setItems([])}>
                {t("image.tools.clear")}
              </button>
              <span className="tools-count">
                {t(items.length === 1 ? "image.tools.countOne" : "image.tools.count", { n: items.length, size: formatBytes(items.reduce((a, i) => a + i.bytes.length, 0)) })}
              </span>
            </div>
          )}

          <div className="tools-options">
            {tool.id === "combine" && (
              <label className="tools-opt check">
                <input type="checkbox" checked={protect} disabled={busy} onChange={(e) => setProtect(e.target.checked)} />
                <span>{t("image.tools.protect")}</span>
              </label>
            )}
            {(tool.id === "compress-pdf" || tool.id === "compress-img" || tool.id === "to-jpg" || tool.id === "pdf-jpg") && (
              <label className="tools-opt">
                <span>{tool.id === "compress-pdf" ? t("image.tools.imageQuality") : t("image.tools.quality")}</span>
                <input type="range" min={0.3} max={1} step={0.01} value={quality} disabled={busy} onChange={(e) => setQuality(Number(e.target.value))} />
                <b>{Math.round(quality * 100)}</b>
              </label>
            )}
            {tool.id === "pdf-jpg" && (
              <div className="tools-opt">
                <span>{t("image.tools.resolution")}</span>
                <Seg
                  value={dpi}
                  onChange={setDpi}
                  options={[
                    { value: "96", label: "96 DPI", tip: t("image.tools.dpiScreen") },
                    { value: "150", label: "150", tip: t("image.tools.dpiNormal") },
                    { value: "200", label: "200", tip: t("image.tools.dpiSharp") },
                    { value: "300", label: "300", tip: t("image.tools.dpiPrint") },
                  ]}
                />
              </div>
            )}
            {tool.id === "img-pdf" && (
              <div className="tools-opt">
                <span>{t("image.tools.pageSize")}</span>
                <Seg<PageSize>
                  value={pageSize}
                  onChange={setPageSize}
                  options={[
                    { value: "fit", label: t("image.tools.fit") },
                    { value: "A4", label: t("image.tools.a4Portrait") },
                    { value: "A4-landscape", label: t("image.tools.a4Landscape") },
                    { value: "Letter", label: "Letter" },
                  ]}
                />
              </div>
            )}
            {tool.id === "compress-img" && (
              <div className="tools-opt">
                <span>{t("image.tools.format")}</span>
                <Seg<OutFormat | "same">
                  value={fmt}
                  onChange={setFmt}
                  options={[
                    { value: "same", label: t("image.tools.sameFormat") },
                    { value: "jpeg", label: "JPG" },
                    { value: "webp", label: "WebP" },
                    { value: "png", label: "PNG" },
                  ]}
                />
              </div>
            )}
            {(tool.id === "compress-img" || tool.id === "compress-pdf") && (
              <div className="tools-opt">
                <span>{t("image.tools.maxSize")}</span>
                <Seg
                  value={maxDim}
                  onChange={setMaxDim}
                  options={[
                    { value: "0", label: tool.id === "compress-pdf" ? "2400px" : t("image.tools.origSize") },
                    { value: "1920", label: "1920px" },
                    { value: "1280", label: "1280px" },
                  ]}
                />
              </div>
            )}
          </div>

          {progress && busy && (
            <div className="tools-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="tools-bar" style={{ width: `${pct}%` }} />
              <span>
                {pct}% {progress.label ?? ""}
              </span>
            </div>
          )}
          {error && <p className="tools-error">{error}</p>}
          {results.length > 0 && (
            <div className="tools-results">
              <ul>
                {results.slice(0, 200).map((r, i) => (
                  <li key={i} className={cx(r.error && "bad")}>
                    <Icon name={r.error ? "info" : "check"} size={13} />
                    <span className="tools-name">{r.name}</span>
                    {r.error ? (
                      <span className="tools-note">{r.error}</span>
                    ) : (
                      <span className="tools-size">
                        {r.before ? `${formatBytes(r.before)} → ` : ""}
                        <b>{formatBytes(r.bytes.length)}</b>
                        {r.before && r.bytes.length < r.before ? ` (−${Math.round((1 - r.bytes.length / r.before) * 100)}%)` : ""}
                      </span>
                    )}
                    {r.note && !r.error && <span className="tools-note">{r.note}</span>}
                  </li>
                ))}
              </ul>
              {totalBefore > 0 && ok.length > 1 && (
                <p className="tools-sum">
                  {t("image.tools.total", { before: formatBytes(totalBefore) })} <b>{formatBytes(totalAfter)}</b>
                </p>
              )}
            </div>
          )}
          <footer className="tools-foot">
            <span className="tools-local-inline">
              <Icon name="shield" size={13} /> {t("image.tools.localInline")}
            </span>
            {ok.length > 0 && (
              <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void save()}>
                <Icon name="save" size={14} />
                <span>{ok.length > 1 ? t("image.tools.saveZip", { n: ok.length }) : t("image.tools.saveResult")}</span>
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !items.length} onClick={() => void run()}>
              <Icon name="play" size={14} />
              <span>{busy ? t("image.tools.running") : results.length ? t("image.tools.rerun") : t("image.tools.run")}</span>
            </button>
          </footer>
        </section>
      </div>
    </Modal>
  );
}
