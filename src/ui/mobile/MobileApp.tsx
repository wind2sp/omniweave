// Phone shell (Android app, docs/MOBILE_PLAN.md §2): home (open · scan · new PDF, quick tools, recent), the document
// viewer (MobileViewer: PDF, DOCX, HWPX, PPTX, XLSX, .omw, pictures) with markup and signatures (markup.tsx), scan
// → PDF (scan.tsx), results handed to the system share sheet or saved as a new file (nativeFiles.ts). The desktop
// editor (ui/App) is not part of this build. Every file is processed on the phone; nothing is uploaded and the app
// has no network permission.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang, useT, t, type Lang } from "../../i18n";
import { isTauri, openFiles, type OpenedFile } from "../../io/platform";
import { switchLayout } from "../../web/phone";
import { setPasswordAsker } from "../../io/crypto/session";
import { compressPdf, formatBytes, imagesToPdf, mergePdfs } from "../../io/tools/pdfTools";
import { canvasRecompressor, compressImage, pdfToJpgs, sniffMime, toJpg, zipFiles } from "../../io/tools/imageTools";
import { addRecent, clearRecent, expireRecent, fingerprint, loadRecent, removeRecent, type RecentItem } from "./recent";
import { MobileViewer } from "./MobileViewer";
import { persistUri, saveCopy, shareFile } from "./nativeFiles";
import { PromptHost, offerPassword, phonePasswordAsker } from "./prompt";
import { IMAGE_EXTS, MEDIA_EXTS, PAGE_EXTS, knownPassword } from "./openDoc";
import { ScanEditor, renderScanPage, scanPageFrom, type ScanPage } from "./scan";
import { loadSignatures } from "./markup";
import { useBackClose } from "./back";
import { EDITOR_ONLY_EXTS, canEdit } from "./openDoc";
import "./mobile.css";

// the editor (and the engine's writers) load when a file is first edited, not with the home screen
const MobileEditor = lazy(() => import("./editor/MobileEditor").then((m) => ({ default: m.MobileEditor })));
// the desktop editor laid out for the phone ("PC 기능 전체"): only when asked for
const PhoneDesk = lazy(() => import("./PhoneDesk").then((m) => ({ default: m.PhoneDesk })));

/** What the desktop editor on the phone opens with: a file, or the phone editor's document (file null). */
export interface DeskRequest {
  file: OpenedFile | null;
  command?: string | null;
}

export { mimeOf, shareFile } from "./nativeFiles";

type Tab = "home" | "files" | "tools" | "about";
export interface MobileDoc {
  name: string;
  bytes: Uint8Array;
  /** where it came from: a picked or shared file, or a result made here (not saved yet) */
  origin: "opened" | "received" | "result";
  /** changes with every file shown, so the viewer starts at the top of a new one */
  key?: number;
  /** where it was read from (Android content:// URI, desktop path) — for saving over it */
  path?: string | null;
}

let docSeq = 0;

/** desktop commands offered on the tools tab (ui/commands.ts ids): they open in the desktop editor on the phone */
const DESK_TOOLS: { cmd: string; icon: string; label: string }[] = [
  { cmd: "tools.commandSearch", icon: "⌕︎", label: "mobile.desk.cmdSearch" },
  { cmd: "quick.combine", icon: "⧉︎", label: "mobile.desk.combine" },
  { cmd: "quick.to-jpg", icon: "▣︎", label: "mobile.desk.toJpg" },
  { cmd: "file.new", icon: "＋", label: "mobile.desk.new" },
  { cmd: "file.settings", icon: "⚙︎", label: "mobile.desk.settings" },
];

const PDF = [{ name: "PDF", extensions: ["pdf"] }];
const IMAGES = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }];
/** every format the desktop opens (io/formats), the phone too */
const ALL_EXTS = [...new Set(["pdf", ...IMAGE_EXTS, ...PAGE_EXTS, ...MEDIA_EXTS, "psd", "psb", "ai", "dxf", "dwg", "svg", "zip"])];
const VIEWABLE = [{ name: "Documents", extensions: ALL_EXTS.filter((e) => e !== "zip") }];

const KNOWN = new RegExp(`\\.(${ALL_EXTS.join("|")})$`, "i");

/** The type from the first bytes, for a file handed over without a usable name (a media id such as
 *  content://media/external/file/18). ZIP-based Office/HWPX files are told apart by their part names. */
export function sniffExt(bytes: Uint8Array): string | null {
  const head = (n: number) => String.fromCharCode(...bytes.subarray(0, n));
  if (head(5) === "%PDF-") return "pdf";
  if (bytes[0] === 0x89 && head(4).slice(1) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (head(4) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  if (head(3) === "GIF") return "gif";
  if (head(4) === "8BPS") return bytes[5] === 2 ? "psb" : "psd";
  if (/^AC10[1-3]\d/.test(head(6))) return "dwg";
  if (/^\s*0\s*\r?\n\s*SECTION/.test(head(40)) || head(18) === "AutoCAD Binary DXF") return "dxf";
  if (head(5) === "%!PS-") return "ai";
  // OLE compound files: 한글 (HWP 5), Word / Excel / PowerPoint 97-2003, by their stream names (UTF-16 in the directory)
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const names = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20))).replace(/\0/g, "");
    if (names.includes("HwpSummaryInformation") || names.includes("FileHeader")) return "hwp";
    if (names.includes("WordDocument")) return "doc";
    if (names.includes("PowerPoint Document")) return "ppt";
    if (names.includes("Workbook") || names.includes("Book")) return "xls";
  }
  if (head(2) === "PK") {
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    if (text.includes("application/hwp+zip") || text.includes("Contents/section")) return "hwpx";
    if (text.includes("word/")) return "docx";
    if (text.includes("ppt/")) return "pptx";
    if (text.includes("xl/")) return "xlsx";
    if (text.includes("omniweave")) return "omw";
    return "zip";
  }
  return null;
}

/**
 * The name to show: the provider's display name when it has a known extension; otherwise (a bare media id such as
 * "18", or no name at all) a plain name for the kind of file the bytes are — "문서.pdf", "사진.jpg" — never the id.
 */
export function nameWithExt(name: string, bytes: Uint8Array): string {
  if (KNOWN.test(name)) return name;
  const ext = sniffExt(bytes);
  if (!ext) return name || t("mobile.untitledDoc");
  const stem = name && !/^\d+$/.test(name) && !/^(msf|document|image|video):?\d*$/i.test(name) ? name : ["png", "jpg", "webp", "gif"].includes(ext) ? t("mobile.untitledImage") : t("mobile.untitledDoc");
  return `${stem}.${ext}`;
}

function fileKind(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "PDF";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "IMG";
  // three letters: the badge stays readable at the largest system font size
  return ext.toUpperCase().slice(0, 3) || "DOC";
}

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? t("mobile.today") : d.toLocaleDateString();
}

/** light / dark: the system's choice unless the viewer picked one (Settings) */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "omniweave.mobile.theme";
function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function MobileApp() {
  const tr = useT();
  const lang = useLang((s) => s.lang);
  const [tab, setTab] = useState<Tab>("home");
  const [doc, setDoc] = useState<MobileDoc | null>(null);
  /** the file open in the editor (over the viewer, or alone for files only the editor shows: PSD, AI, drawings) */
  const [editing, setEditing] = useState<MobileDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>(() => loadRecent());
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [scanPages, setScanPages] = useState<ScanPage[] | null>(null);
  /** the desktop editor on the phone, while it is shown */
  const [desk, setDesk] = useState<DeskRequest | null>(null);
  const scanInput = useRef<HTMLInputElement>(null);

  useEffect(() => setPasswordAsker(phonePasswordAsker(t)), []);
  const openDesk = useCallback((r: DeskRequest) => {
    setDesk(r);
  }, []);
  // back on another tab goes to the home tab first; on the home tab it leaves the app (Android's own behaviour)
  useBackClose(tab !== "home" && !doc && !editing && !scanPages, () => setTab("home"));
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((m) => (m === msg ? null : m)), 3500);
  }, []);

  const show = useCallback((d: MobileDoc, path: string | null = null) => {
    d = { ...d, name: nameWithExt(d.name, d.bytes) };
    if (d.origin !== "result") {
      setRecent(addRecent({ name: d.name, size: d.bytes.length, path, at: Date.now(), fp: fingerprint(d.bytes) }));
      void persistUri(path);
    }
    const shown = { ...d, path: d.path ?? path, key: ++docSeq };
    setEditing(null);
    if (EDITOR_ONLY_EXTS.includes(d.name.toLowerCase().split(".").pop() ?? "")) {
      setDoc(null);
      setEditing(shown);
    } else setDoc(shown);
  }, []);

  const run = useCallback(
    async (label: string, job: () => Promise<void>) => {
      setBusy(label);
      try {
        await job();
      } catch (e: any) {
        say(tr("mobile.failed", { error: e?.message ?? String(e) }));
      } finally {
        setBusy(null);
      }
    },
    [say, tr],
  );

  // files other apps hand over ("Open with", "Share"): at a cold start and while running
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | undefined;
    const take = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const urls = await invoke<string[]>("opened_files").catch(() => [] as string[]);
      if (!urls.length) return;
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const { displayName } = await import("../../io/platform");
      for (const u of urls) {
        await run(tr("mobile.working"), async () => {
          const bytes = await readFile(u);
          const name = (await invoke<string | null>("content_name", { uri: u }).catch(() => null)) || displayName(u);
          show({ name, bytes, origin: "received" }, u);
        });
      }
    };
    void take();
    void import("@tauri-apps/api/event").then(({ listen }) => listen("opened-files", () => void take()).then((un) => (stop = un)));
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion().then(setVersion)).catch(() => {});
    return () => stop?.();
  }, [run, show, tr]);

  // the browser: files opened with the installed web app (launch queue) and the example file of a ?demo link — the
  // desktop editor's own start-up helpers (web/pwa.ts, ui/actions.ts), shown on the phone screen
  useEffect(() => {
    if (isTauri) return;
    void import("../../web/pwa").then(({ openLaunchedFiles }) => openLaunchedFiles(async (f) => show({ name: f.name, bytes: f.bytes, origin: "received" }, null)));
    let demo: string | null = null;
    try {
      const q = new URLSearchParams(location.search);
      if (q.has("demo")) demo = q.get("demo") || "demo.omw";
    } catch {}
    if (!demo) return;
    void run(tr("mobile.working"), async () => {
      // only example files published with the app (same origin) — never an arbitrary URL from a link
      const url = new URL(demo!, location.href);
      if (url.origin !== location.origin) return;
      const res = await fetch(url.href);
      if (!res.ok) return;
      show({ name: url.pathname.split("/").pop() || "omniweave-demo.omw", bytes: new Uint8Array(await res.arrayBuffer()), origin: "received" });
    });
    // once, at start-up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // automated checks and store screenshots (scripts/mobile-shots.mjs over WebView debugging, debug builds only):
  // open bytes as if picked, start a scan from a photo. Nothing outside the page can call it in a release build.
  useEffect(() => {
    (window as any).__omwMobile = {
      open: (name: string, bytes: Uint8Array) => show({ name, bytes, origin: "opened" }, null),
      scan: async (bytes: Uint8Array) => {
        const page = await scanPageFrom(bytes);
        setScanPages((p) => [...(p ?? []), page]);
      },
      tab: (id: Tab) => (setDoc(null), setEditing(null), setTab(id)),
      edit: (name: string, bytes: Uint8Array) => (setDoc(null), setEditing({ name, bytes, origin: "opened", key: ++docSeq })),
      desk: (name?: string, bytes?: Uint8Array, command?: string) => setDesk({ file: name && bytes ? { name, path: null, bytes } : null, command }),
      editor: () => import("./editor/MobileEditor").then((m) => m.editorHook.current),
    };
  }, [show]);

  const openPicked = (files: OpenedFile[]) => {
    const f = files[0];
    if (f) show({ name: f.name, bytes: f.bytes, origin: "opened" }, f.path);
  };

  /** one photo from the camera app (Android) → a scan page; the browser uses the file input */
  const takePhoto = () => {
    if (!isTauri) return scanInput.current?.click();
    void run(tr("mobile.scan"), async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const buf = await invoke<ArrayBuffer>("scan_photo");
      const bytes = new Uint8Array(buf);
      if (!bytes.length) return;
      const page = await scanPageFrom(bytes);
      setScanPages((p) => [...(p ?? []), page]);
    });
  };

  const actions = {
    open: () => run(tr("mobile.working"), async () => openPicked(await openFiles(VIEWABLE))),
    scan: takePhoto,
    merge: () =>
      run(tr("mobile.tool.merge"), async () => {
        const files = await openFiles(PDF, true);
        if (!files.length) return;
        const r = await mergePdfs(files);
        show({ name: tr("mobile.out.merged") + ".pdf", bytes: r.bytes, origin: "result" });
      }),
    compress: () =>
      run(tr("mobile.tool.compress"), async () => {
        const [f] = await openFiles(PDF);
        if (!f) return;
        const r = await compressPdf(f.bytes, { quality: 0.6, maxDim: 1600, recompress: canvasRecompressor });
        say(r.note);
        show({ name: nameWithExt(f.name, f.bytes).replace(/\.pdf$/i, "") + "_small.pdf", bytes: r.bytes, origin: "result" });
      }),
    pdfToJpg: () =>
      run(tr("mobile.tool.pdfToJpg"), async () => {
        const [f] = await openFiles(PDF);
        if (!f) return;
        const pages = await pdfToJpgs(f.bytes, f.name, { dpi: 150, quality: 0.85 });
        if (pages.length === 1) show({ name: pages[0].name, bytes: pages[0].bytes, origin: "result" });
        else show({ name: nameWithExt(f.name, f.bytes).replace(/\.pdf$/i, "") + "_jpg.zip", bytes: zipFiles(pages), origin: "result" });
      }),
    imagesToPdf: () =>
      run(tr("mobile.tool.imagesToPdf"), async () => {
        const files = await openFiles(IMAGES, true);
        if (!files.length) return;
        const bytes = await photosToPdf(files);
        show({ name: (files[0].name.replace(/\.[^.]+$/, "") || "photos") + ".pdf", bytes, origin: "result" });
      }),
    shrinkPhotos: () =>
      run(tr("mobile.tool.shrinkPhotos"), async () => {
        const files = await openFiles(IMAGES, true);
        if (!files.length) return;
        const out = await Promise.all(files.map((f) => compressImage(f.bytes, f.name, { quality: 0.72, format: "same", maxDim: 2048 })));
        if (out.length === 1) show({ name: out[0].name, bytes: out[0].bytes, origin: "result" });
        else show({ name: "photos_small.zip", bytes: zipFiles(out), origin: "result" });
      }),
  };

  const onScanInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    void run(tr("mobile.scan"), async () => {
      const pages = await Promise.all(files.map(async (f) => scanPageFrom(new Uint8Array(await f.arrayBuffer()))));
      setScanPages((p) => [...(p ?? []), ...pages]);
    });
  };

  /** straightened, cleaned-up scan pages → one A4 PDF */
  const finishScan = (pages: ScanPage[]) =>
    run(tr("mobile.scan.making"), async () => {
      const shots: OpenedFile[] = [];
      for (const p of pages) shots.push({ name: `scan_${shots.length + 1}.jpg`, path: null, bytes: (await renderScanPage(p)).bytes });
      const bytes = await photosToPdf(shots, "A4");
      for (const p of pages) if ("close" in p.bitmap) p.bitmap.close();
      setScanPages(null);
      const n = new Date();
      const p2 = (v: number) => String(v).padStart(2, "0");
      const stamp = `${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}_${p2(n.getHours())}${p2(n.getMinutes())}`;
      show({ name: `scan_${stamp}.pdf`, bytes, origin: "result" });
    });

  const tools: { id: keyof typeof actions; label: string; icon: string }[] = [
    { id: "merge", label: tr("mobile.tool.merge"), icon: "⧉" },
    { id: "compress", label: tr("mobile.tool.compress"), icon: "⇲" },
    { id: "pdfToJpg", label: tr("mobile.tool.pdfToJpg"), icon: "▣" },
    { id: "imagesToPdf", label: tr("mobile.tool.imagesToPdf"), icon: "⎙\uFE0E" },
    { id: "shrinkPhotos", label: tr("mobile.tool.shrinkPhotos"), icon: "◱" },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? recent.filter((r) => r.name.toLowerCase().includes(q)) : recent;
  }, [recent, query]);

  const reopen = (r: RecentItem) =>
    run(tr("mobile.working"), async () => {
      if (isTauri && r.path && !r.expired) {
        try {
          const { readFile } = await import("@tauri-apps/plugin-fs");
          return show({ name: r.name, bytes: await readFile(r.path), origin: "opened" }, r.path);
        } catch {
          // the grant to that file ended (another session, the file moved or was deleted): pick it again
          setRecent(expireRecent(r));
        }
      }
      say(tr("mobile.recentExpired", { name: r.name }));
      openPicked(await openFiles(VIEWABLE));
    });

  const recentList = (
    <ul className="m-recent">
      {shown.length === 0 && <li className="m-empty">{tr("mobile.recentEmpty")}</li>}
      {shown.map((r) => (
        <li key={r.name + r.at} className="m-recent-row">
          <button className="m-row" onClick={() => void reopen(r)}>
            <span className={"m-kind m-kind-" + fileKind(r.name).toLowerCase()} aria-hidden>
              {fileKind(r.name)}
            </span>
            <span className="m-row-name">{r.name}</span>
            <span className="m-row-meta">
              {formatBytes(r.size)} · {when(r.at)}
              {r.expired ? " · " + tr("mobile.recentPickAgain") : ""}
            </span>
          </button>
          <button className="m-icon-btn m-row-x" onClick={() => setRecent(removeRecent(r))} aria-label={tr("mobile.recentRemove", { name: r.name })}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );

  const toolGrid = (
    <div className="m-tools">
      {tools.map((x) => (
        <button key={x.id} className="m-tool" onClick={() => void actions[x.id]()}>
          <span className="m-tool-icon" aria-hidden>
            {x.icon}
          </span>
          <span>{x.label}</span>
        </button>
      ))}
    </div>
  );

  const pickTheme = (v: Theme) => {
    setTheme(v);
    try {
      localStorage.setItem(THEME_KEY, v);
    } catch {}
  };

  if (desk)
    return (
      <Suspense fallback={<div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}>
        <PhoneDesk
          key={desk.file?.name ?? "store"}
          file={desk.file}
          command={desk.command}
          onExit={() => {
            setDesk(null);
            // the phone editor's document went on in the desktop editor: the phone shows the file list again
            if (!desk.file) setEditing(null);
          }}
        />
        <PromptHost />
      </Suspense>
    );

  return (
    <div className="m-app">
      <input ref={scanInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={onScanInput} />
      {scanPages && scanPages.length > 0 ? (
        <ScanEditor
          pages={scanPages}
          setPages={(f) => setScanPages((p) => f(p ?? []))}
          onAddPhoto={takePhoto}
          onCancel={() => {
            for (const p of scanPages) if ("close" in p.bitmap) p.bitmap.close();
            setScanPages(null);
          }}
          onFinish={(pages) => void finishScan(pages)}
        />
      ) : editing ? (
        <Suspense fallback={<div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}>
          <MobileEditor key={editing.key} doc={editing} say={say} onClose={() => setEditing(null)} onResult={(d) => show(d)} onDesk={(command) => openDesk({ file: null, command })} />
        </Suspense>
      ) : doc ? (
        <MobileViewer
          key={doc.key}
          doc={doc}
          say={say}
          onBack={() => setDoc(null)}
          onResult={(d) => show(d)}
          onEdit={
            canEdit(doc.name)
              ? () => {
                  offerPassword(knownPassword(doc.bytes));
                  setEditing(doc);
                }
              : undefined
          }
          onDesk={(command) => openDesk({ file: { name: doc.name, path: doc.path ?? null, bytes: doc.bytes }, command })}
          onShare={() => void run(tr("mobile.share"), () => shareFile(doc.name, doc.bytes))}
          onSave={() =>
            void run(tr("mobile.saveCopy"), async () => {
              if (await saveCopy(doc.name, doc.bytes)) say(tr("mobile.saved", { name: doc.name }));
            })
          }
        />
      ) : (
        <>
          <header className="m-top">
            <img className="m-logo" src="./app_small.png" alt="" />
            <h1>Omniweave</h1>
          </header>
          <main className="m-main">
            {tab === "home" && (
              <>
                <input className="m-search" type="search" placeholder={tr("mobile.search")} aria-label={tr("mobile.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
                <div className="m-actions">
                  <button className="m-action m-primary" onClick={() => void actions.open()}>
                    <span className="m-action-icon" aria-hidden>
                      ▤︎
                    </span>
                    {tr("mobile.open")}
                  </button>
                  <button className="m-action" onClick={actions.scan}>
                    <span className="m-action-icon" aria-hidden>
                      ◎︎
                    </span>
                    {tr("mobile.scan")}
                  </button>
                  <button className="m-action" onClick={() => void actions.imagesToPdf()}>
                    <span className="m-action-icon" aria-hidden>
                      ＋
                    </span>
                    {tr("mobile.newPdf")}
                  </button>
                </div>
                <button className="m-action m-wide m-desk-entry" onClick={() => openDesk({ file: null })}>
                  <span className="m-action-icon" aria-hidden>
                    ▦︎
                  </span>
                  <span>
                    {tr("mobile.desk.open")}
                    <small>{tr("mobile.desk.openNote")}</small>
                  </span>
                </button>
                <h2>{tr("mobile.tools")}</h2>
                {toolGrid}
                <h2>{tr("mobile.recent")}</h2>
                {recentList}
                <p className="m-note">{tr("mobile.noUpload")}</p>
              </>
            )}
            {tab === "files" && (
              <>
                <button className="m-action m-primary m-wide" onClick={() => void actions.open()}>
                  {tr("mobile.open")}
                </button>
                <h2>{tr("mobile.recent")}</h2>
                {recentList}
                {recent.length > 0 && (
                  <button className="m-btn m-wide-btn" onClick={() => setRecent(clearRecent())}>
                    {tr("mobile.recentClear")}
                  </button>
                )}
              </>
            )}
            {tab === "tools" && (
              <>
                <h2>{tr("mobile.tools")}</h2>
                {toolGrid}
                <h2>{tr("mobile.scan")}</h2>
                <button className="m-tool m-wide" onClick={actions.scan}>
                  <span className="m-tool-icon" aria-hidden>
                    ◎︎
                  </span>
                  <span>{tr("mobile.scan.toPdf")}</span>
                </button>
                <h2>{tr("mobile.desk.allTools")}</h2>
                <div className="m-tools">
                  {DESK_TOOLS.map((x) => (
                    <button key={x.cmd} className="m-tool" onClick={() => openDesk({ file: null, command: x.cmd })}>
                      <span className="m-tool-icon" aria-hidden>
                        {x.icon}
                      </span>
                      <span>{tr(x.label)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {tab === "about" && (
              <div className="m-about">
                <img src="./app_small.png" alt="" width={64} height={64} />
                <h2>Omniweave</h2>
                {version && <p>{tr("mobile.version", { v: version })}</p>}
                <section className="m-settings" aria-label={tr("mobile.settings")}>
                  <label className="m-set-row">
                    <span>{tr("mobile.language")}</span>
                    <select value={lang} onChange={(e) => useLang.getState().set(e.target.value as Lang)} className="m-select">
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                      <option value="ja">日本語</option>
                      <option value="zh">中文(简体)</option>
                    </select>
                  </label>
                  <label className="m-set-row">
                    <span>{tr("mobile.theme")}</span>
                    <select value={theme} onChange={(e) => pickTheme(e.target.value as Theme)} className="m-select">
                      <option value="system">{tr("mobile.theme.system")}</option>
                      <option value="light">{tr("mobile.theme.light")}</option>
                      <option value="dark">{tr("mobile.theme.dark")}</option>
                    </select>
                  </label>
                  <div className="m-set-row">
                    <span>{tr("mobile.signaturesKept", { n: loadSignatures().length })}</span>
                    <button
                      className="m-btn"
                      onClick={() => {
                        try {
                          localStorage.removeItem("omniweave.mobile.signatures.v1");
                        } catch {}
                        say(tr("mobile.signaturesCleared"));
                      }}
                    >
                      {tr("mobile.mk.delete")}
                    </button>
                  </div>
                  {!isTauri && (
                    // the web app on a phone: the desktop editor for this visit (web/phone.ts, io/platform.ts isMobile)
                    <div className="m-set-row">
                      <span>{tr("webphone.desktop")}</span>
                      <button className="m-btn" onClick={() => switchLayout("desktop")}>
                        {tr("webphone.desktop")}
                      </button>
                    </div>
                  )}
                </section>
                <p>{tr("mobile.noUpload")}</p>
                <p>{tr("mobile.privacy")}</p>
                <p className="m-note">GPL-3.0-or-later · © NINEROW partners Co., Ltd. and Omniweave contributors</p>
                <p className="m-note">{tr("mobile.licensesNote")}</p>
              </div>
            )}
          </main>
          <nav className="m-nav">
            {(["home", "files", "tools", "about"] as Tab[]).map((id) => (
              <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                <span aria-hidden>{{ home: "⌂\uFE0E", files: "▤\uFE0E", tools: "⚒\uFE0E", about: "ⓘ\uFE0E" }[id]}</span>
                {tr(id === "tools" ? "mobile.tools" : "mobile." + id)}
              </button>
            ))}
          </nav>
        </>
      )}
      {busy && (
        <div className="m-busy" role="status">
          <i />
          {busy}
        </div>
      )}
      {toast && (
        <div className="m-toast" role="status">
          {toast}
        </div>
      )}
      <PromptHost />
    </div>
  );
}

/** Photos → one PDF; formats pdf-lib cannot embed go through JPEG. `A4` fits each photo on an A4 page (scans). */
async function photosToPdf(files: OpenedFile[], pageSize: "fit" | "A4" = "fit"): Promise<Uint8Array> {
  const images = files.map((f) => ({ name: f.name, bytes: f.bytes, mime: sniffMime(f.bytes, f.name) }));
  return imagesToPdf(images, {
    pageSize,
    margin: pageSize === "A4" ? 0 : undefined,
    convert: async (img) => {
      const j = await toJpg(img.bytes, img.name, 0.9);
      return { name: j.name, bytes: j.bytes, mime: "image/jpeg" };
    },
  });
}
