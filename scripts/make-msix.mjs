// Microsoft Store package (Windows only, no new dependencies — Windows SDK makeappx.exe / makepri.exe).
//
//   npx tauri build --no-bundle            (or the release build) → <target>/release/omniweave.exe
//   node scripts/make-msix.mjs [--exe <omniweave.exe>] [--out <dir>] [--name … --publisher CN=… --publisher-display-name …]
//   → <out>/Omniweave-X.Y.Z.0.msix  (default out: release/). Unsigned: the Store signs what is uploaded.
//
// - Identity from packaging/msix/store_identity.json (Partner Center › Product identity) or the options. Empty values
//   give a test package with a placeholder identity (a note is printed; the Store would reject it).
// - Version: package.json X.Y.Z → X.Y.Z.0 (the Store wants the fourth part 0).
// - Layout: Omniweave\omniweave.exe (+ LICENSE, NOTICE, THIRD_PARTY_NOTICES.md), Assets\ (tiles and logos drawn by
//   assets/make_icon.py --msix with Pillow), resources.pri (display names and file-type names, ko-KR default, en, ja, zh).
// - The exe is a Tauri app: the web assets are inside it, WebView2 comes with Windows. In the package the app turns its
//   own updater off (src/ui/shell/storeBuild.ts, is_store_package in src-tauri/src/lib.rs).
// - Work folder: <out>/msix-work (layout\ = what goes into the package, pri\ = the resource sources).
// - Child processes never open a console window (windowsHide).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HERE = join(ROOT, "packaging", "msix");
const MAX_TESTED = "10.0.26100.0";
/** Python with Pillow: $OMW_PYTHON, else the per-user Python 3.13 install, else python on PATH */
const userPy = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Python", "Python313", "python.exe") : "";
const PYTHON = process.env.OMW_PYTHON ?? (userPy && existsSync(userPy) ? userPy : "python");
const LEGAL = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];

/** names shown in Start, Settings and "Open with" — per language */
export const STRINGS = {
  "ko-KR": { AppDisplayName: "Omniweave", AppDescription: "이미지·벡터·PDF·문서·슬라이드·도면을 한 캔버스에서 여는 로컬 편집기", FileTypeWorkspace: "Omniweave 작업 파일", FileTypeDocuments: "문서·표·슬라이드·PDF", FileTypeGraphics: "이미지·벡터·도면" },
  "en-US": { AppDisplayName: "Omniweave", AppDescription: "A local editor that opens images, vectors, PDFs, documents, slides and drawings on one canvas", FileTypeWorkspace: "Omniweave workspace", FileTypeDocuments: "Documents, sheets, slides and PDF", FileTypeGraphics: "Images, vector art and drawings" },
  "ja-JP": { AppDisplayName: "Omniweave", AppDescription: "画像・ベクター・PDF・文書・スライド・図面をひとつのキャンバスで開くローカルエディター", FileTypeWorkspace: "Omniweave 作業ファイル", FileTypeDocuments: "文書・表・スライド・PDF", FileTypeGraphics: "画像・ベクター・図面" },
  "zh-CN": { AppDisplayName: "Omniweave", AppDescription: "在同一画布上打开图像、矢量、PDF、文档、幻灯片和图纸的本地编辑器", FileTypeWorkspace: "Omniweave 工作文件", FileTypeDocuments: "文档、表格、幻灯片和 PDF", FileTypeGraphics: "图像、矢量图和图纸" },
};

const PLACEHOLDER = { Name: "Omniweave.TestPackage", Publisher: "CN=Omniweave Test", PublisherDisplayName: "Omniweave (test package)" };

function fail(msg) {
  console.error("make-msix: " + msg);
  process.exit(1);
}
const opt = (args, k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** X.Y.Z(-pre) → X.Y.Z.0 */
export function packageVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`version ${v}`);
  return `${+m[1]}.${+m[2]}.${+m[3]}.0`;
}

export function identity(file, over = {}) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const id = { Name: over.Name || raw.Name, Publisher: over.Publisher || raw.Publisher, PublisherDisplayName: over.PublisherDisplayName || raw.PublisherDisplayName };
  const placeholder = !id.Name || !id.Publisher || !id.PublisherDisplayName;
  const out = placeholder ? { ...PLACEHOLDER, ...Object.fromEntries(Object.entries(id).filter(([, v]) => v)) } : id;
  if (!/^[-.A-Za-z0-9]{3,50}$/.test(out.Name)) throw new Error(`Identity Name ${out.Name}: 3–50 letters, digits, '-' or '.'`);
  if (!/^CN=/.test(out.Publisher)) throw new Error(`Publisher ${out.Publisher} must be a distinguished name (CN=…)`);
  return { ...out, placeholder };
}

export function manifest(template, id, version) {
  return template
    .replaceAll("$PUBLISHER_DISPLAY_NAME", xml(id.PublisherDisplayName))
    .replaceAll("$PUBLISHER", xml(id.Publisher))
    .replaceAll("$NAME", xml(id.Name))
    .replaceAll("$VERSION", version)
    .replaceAll("$MAX_TESTED", MAX_TESTED);
}

export function resw(strings) {
  const data = Object.entries(strings)
    .map(([k, v]) => `  <data name="${k}" xml:space="preserve"><value>${xml(v)}</value></data>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
  <resheader name="reader"><value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
  <resheader name="writer"><value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value></resheader>
${data}
</root>
`;
}

function sdkTool(name) {
  const base = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Windows Kits", "10", "bin");
  if (!existsSync(base)) fail(`Windows SDK not found (${base}). Install the Windows 10/11 SDK and run again.`);
  const vers = readdirSync(base)
    .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d) && existsSync(join(base, d, "x64", name)))
    .sort((a, b) => {
      const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
      return y.reduce((r, v, i) => r || v - x[i], 0); // newest first
    });
  if (!vers.length) fail(`${name} not found under ${base}\\<version>\\x64`);
  return join(base, vers[0], "x64", name);
}

function run(exe, args, what) {
  try {
    return execFileSync(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e) {
    const text = (b) => (b ? (b.includes(0) ? Buffer.from(b).toString("utf16le") : Buffer.from(b).toString("utf8")) : "");
    console.error(text(e.stdout).slice(-6000), text(e.stderr).slice(-3000));
    fail(`${what} failed (exit ${e.status})`);
  }
}

function main(args) {
  if (process.platform !== "win32") fail("MSIX packages are built on Windows only");
  const target = process.env.CARGO_TARGET_DIR ?? join(ROOT, "src-tauri", "target");
  const exe = resolve(opt(args, "--exe") ?? join(target, "release", "omniweave.exe"));
  if (!existsSync(exe)) fail(`${exe} not found — build first (npx tauri build --no-bundle), or pass --exe`);
  const outDir = resolve(opt(args, "--out") ?? join(ROOT, "release"));
  const makeappx = sdkTool("makeappx.exe"), makepri = sdkTool("makepri.exe");
  const id = identity(join(HERE, "store_identity.json"), { Name: opt(args, "--name"), Publisher: opt(args, "--publisher"), PublisherDisplayName: opt(args, "--publisher-display-name") });
  const version = packageVersion(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);

  const work = join(outDir, "msix-work"), layout = join(work, "layout"), pri = join(work, "pri");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(layout, "Omniweave"), { recursive: true });

  // 1) app files
  copyFileSync(exe, join(layout, "Omniweave", "omniweave.exe"));
  for (const f of LEGAL) if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(layout, "Omniweave", f));

  // 2) manifest
  writeFileSync(join(layout, "AppxManifest.xml"), manifest(readFileSync(join(HERE, "AppxManifest.template.xml"), "utf8"), id, version));

  // 3) images + per-language strings → resources.pri (indexed apart from the app files)
  mkdirSync(pri, { recursive: true });
  const py = run(PYTHON, [join(ROOT, "assets", "make_icon.py"), "--msix", join(pri, "Assets")], "assets/make_icon.py --msix").toString().trim();
  for (const [lang, strings] of Object.entries(STRINGS)) {
    mkdirSync(join(pri, "Strings", lang), { recursive: true });
    writeFileSync(join(pri, "Strings", lang, "Resources.resw"), resw(strings));
  }
  const cfg = join(work, "priconfig.xml");
  run(makepri, ["createconfig", "/cf", cfg, "/dq", "ko-KR", "/pv", "10.0.0", "/o"], "makepri createconfig");
  // one .msix with every language and scale (no per-language split for bundles)
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/\s*<packaging>[\s\S]*?<\/packaging>/, ""));
  run(makepri, ["new", "/pr", pri, "/cf", cfg, "/in", id.Name, "/of", join(pri, "resources.pri"), "/o"], "makepri new");
  cpSync(join(pri, "Assets"), join(layout, "Assets"), { recursive: true });
  copyFileSync(join(pri, "resources.pri"), join(layout, "resources.pri"));

  // 4) pack
  const out = join(outDir, `Omniweave-${version}.msix`);
  run(makeappx, ["pack", "/d", layout, "/p", out, "/o"], "makeappx pack");
  console.log(`msix ${out}  ${(statSync(out).size / 1e6).toFixed(1)} MB  version ${version}  (${py})  identity ${id.Name} / ${id.Publisher}`);
  if (id.placeholder) console.log("  NOTE: placeholder identity — fill packaging/msix/store_identity.json from Partner Center before uploading.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
