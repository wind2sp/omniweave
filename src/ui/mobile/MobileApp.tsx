// Phone shell (Android app, docs/MOBILE_PLAN.md §2): home (open · scan · new PDF, quick tools, recent), the document
// viewer (MobileViewer: PDF, DOCX, HWPX, PPTX, XLSX, .omw, pictures) with markup and signatures (markup.tsx), scan
// → PDF (scan.tsx), results handed to the system share sheet or saved as a new file (nativeFiles.ts). The desktop
// editor (ui/App) is not part of this build. Every file is processed on the phone; nothing is uploaded and the app
// has no network permission.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DICTS, LANGS, useLang, useT, t, type Lang } from "../../i18n";
import { isTauri, openFiles, type OpenedFile } from "../../io/platform";
import { switchLayout } from "../../web/phone";
import { setPasswordAsker } from "../../io/crypto/session";
import { compressPdf, formatBytes, imagesToPdf, mergePdfs } from "../../io/tools/pdfTools";
import { canvasRecompressor, compressImage, pdfToJpgs, sniffMime, toJpg, zipFiles } from "../../io/tools/imageTools";
import { addRecent, clearRecent, expireRecent, fingerprint, loadRecent, removeRecent, type RecentItem } from "./recent";
import { Icon, KindIcon, kindOf, type IconName, type Kind } from "./icons";
import { MobileViewer } from "./MobileViewer";
import { persistUri, saveCopy, shareFile } from "./nativeFiles";
import { PromptHost, ask, offerPassword, phonePasswordAsker } from "./prompt";
import { IMAGE_EXTS, MEDIA_EXTS, PAGE_EXTS, knownPassword } from "./openDoc";
import type { EditSession } from "./editor/session";
import { ScanEditor, renderScanPage, scanPageFrom, type ScanPage } from "./scan";
import { loadSignatures } from "./markup";
import { useBackClose } from "./back";
import { EDITOR_ONLY_EXTS, canEdit } from "./openDoc";
import "./mobile.css";
import "./theme.css";

// the editor (and the engine's writers) load when a file is first edited, not with the home screen
const MobileEditor = lazy(() => import("./editor/MobileEditor").then((m) => ({ default: m.MobileEditor })));
// the desktop editor laid out for the phone ("PC 기능 전체"): only when asked for
const PhoneDesk = lazy(() => import("./PhoneDesk").then((m) => ({ default: m.PhoneDesk })));

/** What the desktop editor on the phone opens with: a file, or the phone editor's document (file null). */
export interface DeskRequest {
  file: OpenedFile | null;
  command?: string | null;
  /** the phone editor's session that went on there (it carries on when the phone screen comes back) */
  session?: EditSession | null;
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
  /** opened for one job from the home screen: sign it, or make a PDF of it */
  intent?: "sign" | "toPdf";
}

let docSeq = 0;

// a phone says "finger", "this phone": the desktop's words that speak of a mouse or a computer get the phone's
// ("phone:<key>" in i18n/parts/mobile-desk), for the PC feature screen's dialogs too
for (const d of Object.values(DICTS) as Record<string, string>[]) for (const k of Object.keys(d)) if (k.startsWith("phone:")) d[k.slice(6)] = d[k];

/** desktop commands offered on the tools tab (ui/commands.ts ids): they open in the desktop editor on the phone */
const DESK_TOOLS: { cmd: string; icon: IconName; label: string }[] = [
  { cmd: "tools.commandSearch", icon: "search", label: "mobile.desk.cmdSearch" },
  { cmd: "quick.combine", icon: "merge", label: "mobile.desk.combine" },
  { cmd: "quick.to-jpg", icon: "toImage", label: "mobile.desk.toJpg" },
  { cmd: "file.new", icon: "plus", label: "mobile.desk.new" },
  { cmd: "file.settings", icon: "settings", label: "mobile.desk.settings" },
];

const PDF = [{ name: "PDF", extensions: ["pdf"] }];
/** documents, sheets and slides (the home screen's "문서 → PDF") */
const DOCS = [{ name: "Documents", extensions: ["docx", "doc", "hwpx", "hwp", "odt", "rtf", "txt", "md", "xlsx", "xls", "csv", "ods", "pptx", "ppt", "odp"] }];
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
    // OpenDocument: the first entry is the "mimetype" file, stored as is
    if (text.includes("application/vnd.oasis.opendocument.text")) return "odt";
    if (text.includes("application/vnd.oasis.opendocument.presentation")) return "odp";
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

/** the extension as a short tag (DOCX, HWPX, PDF …) */
function extLabel(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext && ext !== name.toLowerCase() ? ext.toUpperCase().slice(0, 4) : "FILE";
}

/** the eight formats this app opens and edits, under 열기 */
const FORMATS: { kind: Kind; ext: string; exts: string[] }[] = [
  { kind: "doc", ext: "DOCX", exts: ["docx", "doc", "odt", "rtf"] },
  { kind: "doc", ext: "HWPX", exts: ["hwpx", "hwp"] },
  { kind: "sheet", ext: "XLSX", exts: ["xlsx", "xls", "csv", "ods"] },
  { kind: "slide", ext: "PPTX", exts: ["pptx", "ppt", "odp"] },
  { kind: "pdf", ext: "PDF", exts: ["pdf"] },
  { kind: "photo", ext: "PSD", exts: ["psd", "psb", "png", "jpg", "jpeg", "webp"] },
  { kind: "design", ext: "AI", exts: ["ai", "svg", "eps"] },
  { kind: "cad", ext: "DXF", exts: ["dxf", "dwg"] },
];

/** 열기 → 고치기 → 원래 형식으로: the three threads of the logo, lit as far as the file came (0: how it works) */
function Thread({ step }: { step: 0 | 1 | 2 | 3 }) {
  const tr = useT();
  const steps = [
    ["open", "mobile.v2.th.open"],
    ["edit", "mobile.v2.th.edit"],
    ["save", "mobile.v2.th.save"],
  ] as const;
  return (
    // (spans, not a list: a picture of the way, not items to tap)
    <div className={"m-thread" + (step === 0 ? " m-thread-intro" : "")} role="img" aria-label={steps.map(([, k]) => tr(k)).join(" → ")}>
      {steps.map(([icon, k], i) => (
        <span key={k} className={"m-th m-th-" + (i + 1) + (step === 0 || i < step ? " on" : "")} aria-hidden>
          <i>
            <Icon name={icon} />
          </i>
          <span>{tr(k)}</span>
        </span>
      ))}
    </div>
  );
}

/** today: the time; otherwise the date */
function whenTime(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
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
  /** the editor session to carry on with when the phone editor comes back from the PC feature screen */
  const [resume, setResume] = useState<EditSession | null>(null);
  const docRef = useRef<MobileDoc | null>(null);
  docRef.current = doc;
  const scanInput = useRef<HTMLInputElement>(null);

  useEffect(() => setPasswordAsker(phonePasswordAsker(t)), []);
  const openDesk = useCallback((r: DeskRequest) => {
    setDesk(r);
  }, []);

  // the app was closed while a document had unsaved edits (Android ends apps in the background): the autosaved copy
  // (the desktop's journal, written by the phone editor and the PC feature screen) is offered back at the next start
  useEffect(() => {
    void (async () => {
      const j = await import("../../io/journal");
      const others = await j.otherPagesOpenOnce();
      const crashed = j.startRunOnce() && !others;
      if (!crashed) {
        if (!others) await j.journalClear().catch(() => {});
        return;
      }
      const info = await j.journalPeek().catch(() => null);
      if (!info) return;
      const v = await ask({
        title: t("mobile.recover.title"),
        message: t("mobile.recover.msg", { name: info.title, when: new Date(info.savedAt).toLocaleString() }),
        choices: [
          { label: t("mobile.recover.ok"), value: "yes" },
          { label: t("mobile.recover.discard"), value: "no", danger: true },
        ],
      });
      if (v !== "yes") {
        if (v === "no") await j.journalClear().catch(() => {});
        return;
      }
      const [{ useStore }, ss] = await Promise.all([import("../../core/store"), import("../../core/sessions")]);
      const entries = await j.journalList();
      const restored = entries.length ? await j.journalRestore(entries[0].key) : null;
      if (!restored) return;
      if (!ss.isPristineActive()) ss.newSession(restored.title);
      useStore.getState().load(restored);
      useStore.getState().set({ dirty: true });
      await j.journalClear().catch(() => {});
      // the PC feature screen shows it; its 저장 writes it in its own format again
      setDesk({ file: null });
    })();
    // once, at start-up
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      /** the file the viewer shows now: its name and size (checks of what 공유 would send) */
      current: () => docRef.current && { name: docRef.current.name, size: docRef.current.bytes.length },
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
    // the system's file picker first, the busy cover only once a file came back (a picker closed without a file leaves
    // nothing covering the screen)
    open: async () => {
      const files = await openFiles(VIEWABLE);
      if (files.length) await run(tr("mobile.working"), async () => openPicked(files));
    },
    /** 열기 for one format (the formats row): its files first in the picker */
    openAs: async (exts: string[]) => {
      const files = await openFiles([{ name: exts[0].toUpperCase(), extensions: exts }]);
      if (files.length) await run(tr("mobile.working"), async () => openPicked(files));
    },
    scan: takePhoto,
    /** pick a PDF, the signature sheet over it */
    sign: async () => {
      const files = await openFiles(PDF);
      if (files[0]) show({ name: files[0].name, bytes: files[0].bytes, origin: "opened", intent: "sign" }, files[0].path);
    },
    /** pick a document / sheet / deck, its PDF made at once */
    docToPdf: async () => {
      const files = await openFiles(DOCS);
      if (files[0]) show({ name: files[0].name, bytes: files[0].bytes, origin: "opened", intent: "toPdf" }, files[0].path);
    },
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

  const tools: { id: "merge" | "compress" | "pdfToJpg" | "imagesToPdf" | "shrinkPhotos"; label: string; sub: string; icon: IconName }[] = [
    { id: "merge", label: tr("mobile.tool.merge"), sub: tr("mobile.v2.tool.merge"), icon: "merge" },
    { id: "compress", label: tr("mobile.tool.compress"), sub: tr("mobile.v2.tool.compress"), icon: "compress" },
    { id: "pdfToJpg", label: tr("mobile.tool.pdfToJpg"), sub: tr("mobile.v2.tool.pdfToJpg"), icon: "toImage" },
    { id: "imagesToPdf", label: tr("mobile.tool.imagesToPdf"), sub: tr("mobile.v2.tool.imagesToPdf"), icon: "toPdf" },
    { id: "shrinkPhotos", label: tr("mobile.tool.shrinkPhotos"), sub: tr("mobile.v2.tool.shrinkPhotos"), icon: "shrink" },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? recent.filter((r) => r.name.toLowerCase().includes(q)) : recent;
  }, [recent, query]);

  const reopen = async (r: RecentItem) => {
    if (isTauri && r.path && !r.expired) {
      let ok = false;
      await run(tr("mobile.working"), async () => {
        try {
          const { readFile } = await import("@tauri-apps/plugin-fs");
          show({ name: r.name, bytes: await readFile(r.path!), origin: "opened" }, r.path);
          ok = true;
        } catch {
          // the grant to that file ended (another session, the file moved or was deleted): pick it again
          setRecent(expireRecent(r));
        }
      });
      if (ok) return;
    }
    say(tr("mobile.recentExpired", { name: r.name }));
    await actions.open();
  };

  const renderRecent = (items: RecentItem[]) => (
    <ul className="m-recent">
      {items.length === 0 && (
        <li className="m-empty">
          <Icon name="files" />
          <span>{query.trim() ? tr("mobile.searchNone", { q: query.trim() }) : tr("mobile.recentEmpty")}</span>
        </li>
      )}
      {items.map((r) => (
        <li key={r.name + r.at} className="m-recent-row">
          <button className="m-row" onClick={() => void reopen(r)}>
            <span className={"m-kind-mark m-k-" + kindOf(r.name)} aria-hidden>
              <KindIcon kind={kindOf(r.name)} />
            </span>
            <span className="m-row-name">{r.name}</span>
            <span className="m-row-meta">
              <span className="m-ext">{extLabel(r.name)}</span> · {formatBytes(r.size)} · {when(r.at)}
              {r.expired ? " · " + tr("mobile.recentPickAgain") : ""}
            </span>
          </button>
          <button className="m-icon-btn m-row-x" onClick={() => setRecent(removeRecent(r))} aria-label={tr("mobile.recentRemove", { name: r.name })}>
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
  const recentList = renderRecent(shown);

  const toolGrid = (
    <div className="m-tools m-tools-list">
      {tools.map((x) => (
        <button key={x.id} className="m-tool" onClick={() => void actions[x.id]()}>
          <span className="m-tool-icon" aria-hidden>
            <Icon name={x.icon} />
          </span>
          <span className="m-tool-text">
            <b>{x.label}</b>
            <small>{x.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );

  // the first entry of the recent list, with its first page (when the viewer drew it) and whether it was saved back
  const last = recent[0];
  const continueCard = last && (
    <section className="m-continue" aria-label={tr("mobile.v2.continue")}>
      <h2 className="m-label">{tr("mobile.v2.continue")}</h2>
      <button className="m-continue-card" onClick={() => void reopen(last)}>
        <span className={"m-thumb m-k-" + kindOf(last.name)} aria-hidden>
          {last.thumb ? <img src={last.thumb} alt="" /> : <KindIcon kind={kindOf(last.name)} />}
        </span>
        <span className="m-continue-body">
          <span className={"m-tag m-k-" + kindOf(last.name)}>
            <i />
            {extLabel(last.name)}
          </span>
          <b>{last.name}</b>
          <small className={last.saved ? "m-saved" : undefined}>
            {last.saved && <Icon name="check" />}
            {last.saved ? tr("mobile.v2.savedSame", { when: whenTime(last.saved) }) : tr("mobile.v2.opened", { when: whenTime(last.at) })}
          </small>
        </span>
        <Icon name="next" className="m-chev" />
      </button>
      <Thread step={last.saved ? 3 : 1} />
    </section>
  );
  // nothing opened yet: what this app opens and does, in place of an empty list
  const firstRun = !last && (
    <section className="m-firstrun" aria-label={tr("mobile.v2.kinds")}>
      <Thread step={0} />
      <p className="m-note">{tr("mobile.v2.kindsNote")}</p>
    </section>
  );
  // three jobs of three kinds (photo → PDF, a document → PDF, a PDF signed); the rest is on the tools tab
  const homeJobs: { id: string; kind: Kind; icon: IconName; label: string; sub: string; run: () => unknown }[] = [
    { id: "scan", kind: "photo", icon: "scan", label: tr("mobile.v2.job.scan"), sub: tr("mobile.v2.job.scanSub"), run: actions.scan },
    { id: "toPdf", kind: "doc", icon: "convert", label: tr("mobile.v2.job.toPdf"), sub: tr("mobile.v2.job.toPdfSub"), run: actions.docToPdf },
    { id: "sign", kind: "pdf", icon: "sign", label: tr("mobile.v2.job.sign"), sub: tr("mobile.v2.job.signSub"), run: actions.sign },
  ];

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
          onExit={(saved) => {
            setDesk(null);
            // the desktop editor set its own light / dark: the phone's comes back
            applyTheme(theme);
            if (desk.session && editing) {
              // back to the phone editor with the document as it is now (the PC screen's edits kept, nothing asked)
              setResume(desk.session);
              setEditing({ ...editing, key: ++docSeq });
            } else if (!desk.file) setEditing(null);
            // a file saved there in its own format: the viewer (and its 공유) has the saved file, not the old one
            if (saved && desk.file && doc) setDoc({ ...doc, name: saved.name, bytes: saved.bytes, key: ++docSeq });
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
          <MobileEditor
            key={editing.key}
            doc={editing}
            say={say}
            resume={resume}
            onClose={() => (setEditing(null), setResume(null))}
            onResult={(d) => show(d)}
            onDesk={(session, command) => openDesk({ file: null, command, session })}
            onSavedFile={(d) => {
              // the viewer under the editor shows (and shares) the saved file; the recent list has it too
              if (doc) setDoc({ ...d, key: ++docSeq });
              setRecent(addRecent({ name: d.name, size: d.bytes.length, path: d.path ?? null, at: Date.now(), fp: fingerprint(d.bytes), saved: Date.now() }));
            }}
          />
        </Suspense>
      ) : doc ? (
        <MobileViewer
          key={doc.key}
          doc={doc}
          say={say}
          onBack={() => (setDoc(null), setRecent(loadRecent()))}
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
          <header className="m-top m-home-top">
            <img className="m-logo" src="./app_small.png" alt="" />
            <h1>Omniweave</h1>
            <span className="m-status" title={tr("mobile.noUpload")}>
              <Icon name="device" />
              {tr("mobile.v2.local")}
            </span>
          </header>
          <main className="m-main">
            {tab === "home" && (
              <>
                {continueCard}
                {firstRun}
                {/* open: the widest button, the accent; under it every kind it opens and edits */}
                <div className="m-start">
                  <button className="m-open" onClick={() => void actions.open()}>
                    <Icon name="open" />
                    <span>
                      <b>{tr("mobile.open")}</b>
                    </span>
                  </button>
                  <div className="m-formats" role="group" aria-label={tr("mobile.v2.kinds")}>
                    {FORMATS.map((f) => (
                      <button key={f.ext} className={"m-k-" + f.kind} onClick={() => void actions.openAs(f.exts)} aria-label={tr("mobile.v2.openAs", { ext: f.ext })}>
                        <KindIcon kind={f.kind} />
                        {f.ext}
                      </button>
                    ))}
                  </div>
                </div>
                <h2 className="m-label">{tr("mobile.v2.quick")}</h2>
                <div className="m-tools m-tools-list">
                  {homeJobs.map((x) => (
                    <button key={x.id} className="m-tool" onClick={() => void x.run()}>
                      <span className={"m-tool-icon m-k-" + x.kind} aria-hidden>
                        <Icon name={x.icon} />
                      </span>
                      <span className="m-tool-text">
                        <b>{x.label}</b>
                        <small>{x.sub}</small>
                      </span>
                    </button>
                  ))}
                </div>
                {recent.length > 1 && (
                  <>
                    <h2 className="m-label">
                      {tr("mobile.recent")} <span className="m-count">{recent.length}</span>
                    </h2>
                    {recent.length > 6 && <input className="m-search" type="search" placeholder={tr("mobile.search")} aria-label={tr("mobile.search")} value={query} onChange={(e) => setQuery(e.target.value)} />}
                    {/* the first one is the card above */}
                    {renderRecent(query.trim() ? shown : shown.slice(1))}
                  </>
                )}
                {/* every menu of the PC program, laid out for the phone: a way on, not one of the main buttons */}
                <button className="m-desk-row" onClick={() => openDesk({ file: null })}>
                  <Icon name="desk" />
                  <span className="m-tool-text">
                    <b>{tr("mobile.desk.open")}</b>
                    <small>{tr("mobile.desk.openNote")}</small>
                  </span>
                  <Icon name="next" className="m-chev" />
                </button>
              </>
            )}
            {tab === "files" && (
              <>
                <button className="m-open" onClick={() => void actions.open()}>
                  <Icon name="open" />
                  <span>
                    <b>{tr("mobile.open")}</b>
                    <small>{tr("mobile.v2.openSub")}</small>
                  </span>
                </button>
                <h2 className="m-label">
                  {tr("mobile.recent")} {recent.length > 0 && <span className="m-count">{recent.length}</span>}
                </h2>
                {recent.length > 6 && <input className="m-search" type="search" placeholder={tr("mobile.search")} aria-label={tr("mobile.search")} value={query} onChange={(e) => setQuery(e.target.value)} />}
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
                <h2 className="m-label">{tr("mobile.v2.quick")}</h2>
                {toolGrid}
                <h2 className="m-label">{tr("mobile.scan")}</h2>
                <div className="m-tools m-tools-list">
                  <button className="m-tool" onClick={actions.scan}>
                    <span className="m-tool-icon" aria-hidden>
                      <Icon name="scan" />
                    </span>
                    <span className="m-tool-text">
                      <b>{tr("mobile.scan.toPdf")}</b>
                    </span>
                  </button>
                </div>
                <h2 className="m-label">{tr("mobile.desk.allTools")}</h2>
                <div className="m-tools m-tools-list">
                  {DESK_TOOLS.map((x) => (
                    <button key={x.cmd} className="m-tool" onClick={() => openDesk({ file: null, command: x.cmd })}>
                      <span className="m-tool-icon" aria-hidden>
                        <Icon name={x.icon} />
                      </span>
                      <span className="m-tool-text">
                        <b>{tr(x.label)}</b>
                      </span>
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
                      {LANGS.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
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
                        {tr("mobile.v2.switch")}
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
                <Icon name={({ home: "home", files: "files", tools: "tools", about: "settings" } as const)[id]} />
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
